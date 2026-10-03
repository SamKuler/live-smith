import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { URL } from "node:url";
import { runAgentFlow, type AgentFlowDependencies } from "../../../src/app/agent-flow.js";
import type { MidiContinuationView } from "../../../src/agent/midi-continuation-contracts.js";
import { pendingArtifactParentFromEvents } from "../../../src/agent/artifact-contracts.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import { readMidiArtifact, readMidiContinuation } from "../../../src/storage/midi-artifacts.js";
import { saveSavedProfile } from "../../../src/storage/settings.js";
import type { ChatDialogState } from "../../../src/ui/chat-state.js";
import type { LiveInteractionContext } from "../../../src/live/context.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";
import { continuationHarness } from "./support/continuation-harness.js";

type State = ChatDialogState & { midiContinuation?: MidiContinuationView };
let sequence = 0;
const endpoint = (url: string, route: string) => { const parsed = new URL(url); parsed.pathname = route; return parsed; };
function command(url: string, body: unknown, id = `continuation-command-${++sequence}`) {
  return fetch(endpoint(url, "/command"), { method: "POST", headers: { "Content-Type": "application/json", "X-Live-Smith-Command-Id": id }, body: JSON.stringify(body) });
}
async function state(response: Response): Promise<State> {
  const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text) as State;
}
function notes(label: string, pitch = 48) {
  return { content: null, toolCalls: [{ id: `notes-${pitch}`, name: "save_midi_artifact", arguments: JSON.stringify({ label,
    tracks: [{ name: "Bass", channel: 1, notes: [{ pitch, startTime: 0, duration: 4, velocity: 96 }] },
      { name: "Lead", channel: 2, notes: [{ pitch: pitch + 24, startTime: 1, duration: 2, velocity: 100 }] }] }) }] };
}

async function withFlow(t: TestContext, inspect: (input: { url: string; h: Awaited<ReturnType<typeof continuationHarness>> }) => Promise<void>,
  requester: NonNullable<AgentFlowDependencies["requestModelTurn"]>) {
  const h = await continuationHarness(t);
  const interaction: LiveInteractionContext = { presentation: liveContextPresentationFixture("Live Set", "other"), summary: "Bass and Lead source clips", target: {},
    scope: { kind: "selection", identity: "set", label: "Live Set" } };
  interaction.selectionContext = { refresh: () => interaction };
  await runAgentFlow({ application: { song: h.song }, environment: { storageDirectory: h.directory }, ui: { showModalDialog: (url: string) => inspect({ url, h }) } } as never,
    interaction, { renderHtml: () => "<html></html>", requestModelTurn: requester, modelBackendManager: {
      async forProfile() { return { kind: "direct-api" as const, async listModels() { return []; }, async createToolTurn() { return { content: "Unused", toolCalls: [] }; }, async close() {} }; },
      async oauth() { throw new Error("No OAuth fixture"); }, async oauthLease() { throw new Error("No OAuth fixture"); }, async invalidateOAuth() {}, async close() {},
    } });
}

async function configure(url: string) {
  const initial = await state(await fetch(endpoint(url, "/state")));
  const loaded = await state(await command(url, { kind: "load_midi_continuation", sessionId: initial.activeSessionId }));
  assert.equal(loaded.midiContinuation!.clips.length, 2);
  const configured = await state(await command(url, { kind: "configure_midi_continuation", sessionId: loaded.activeSessionId,
    expectedBufferId: loaded.midiContinuation?.buffer?.id ?? null,
    sourceClips: loaded.midiContinuation!.clips.map(({ trackId, clipId }) => ({ trackId, clipId })), segmentBeats: 8, capacity: 2, prompt: "Keep both voices.", generator: { kind: "model" } }));
  assert.equal(configured.midiContinuation!.buffer!.queue.length, 0);
  return configured;
}

test("real command flow loads sources, configures, generates and refills after a confirmed mapped import", async (t) => {
  let modelCalls = 0;
  await withFlow(t, async ({ url, h }) => {
    let current = await configure(url); const sessionId = current.activeSessionId; const bufferId = current.midiContinuation!.buffer!.id;
    const source = current.midiContinuation!.buffer!.sourceArtifactRef;
    await state(await command(url, { kind: "select_artifact", sessionId, selection: { action: "continue", candidate: { kind: "midi", id: source } } }));
    current = await state(await command(url, { kind: "fill_midi_continuation", sessionId, bufferId }));
    const buffer = current.midiContinuation!.buffer!;
    assert.equal(buffer.queue.length, 2); assert.equal(modelCalls, 2); assert.equal(current.midiContinuation!.stale, false);
    assert.equal(pendingArtifactParentFromEvents(await loadSessionEvents(h.directory, sessionId))?.id, source);
    await state(await command(url, { kind: "fill_midi_continuation", sessionId, bufferId })); assert.equal(modelCalls, 2);
    const head = buffer.queue[0]!;
    const parsed = await readMidiArtifact(h.directory, sessionId, head.artifactRef);
    assert.equal(parsed.parsed.parts.length, 2); assert.equal(parsed.artifact.generationKind, "continuation");
    const created: { notes: unknown[] }[] = [];
    for (const track of h.tracks) Object.defineProperty(track, "createMidiClip", { value: async () => { const clip = { name: "New", notes: [] }; created.push(clip); return clip; } });
    await state(await command(url, { kind: "set_session_approval_mode", sessionId, approvalMode: "everything" }));
    current = await state(await command(url, { kind: "import_midi_continuation", sessionId, bufferId, artifactRef: head.artifactRef, startBeat: 8,
      mappings: parsed.parsed.parts.map((part, index) => ({ partId: part.id, trackId: String(index + 1), trackName: index ? "Lead" : "Bass" })) }));
    assert.equal(created.length, 2); assert.deepEqual(created.map((clip) => clip.notes.length), [1, 1]);
    assert.equal(current.midiContinuation!.buffer!.queue.length, 1);
    current = await state(await command(url, { kind: "fill_midi_continuation", sessionId, bufferId }));
    assert.equal(modelCalls, 3); assert.deepEqual(current.midiContinuation!.buffer!.queue.map((entry) => entry.sequence), [1, 2]);
    h.song.tempo = 130;
    const rejected = await command(url, { kind: "fill_midi_continuation", sessionId, bufferId });
    assert.notEqual(rejected.status, 200); await rejected.text(); assert.equal(modelCalls, 3);
  }, async (input) => { modelCalls++; assert.deepEqual(input.editScopes, []); return notes(`Section ${modelCalls}`, 48 + modelCalls); });
});

test("Stop rejects a late model result and Session switch/delete cannot bypass an active Fill", async (t) => {
  let started!: () => void; let release!: () => void;
  const began = new Promise<void>((done) => { started = done; }); const blocked = new Promise<void>((done) => { release = done; });
  await withFlow(t, async ({ url, h }) => {
    const configured = await configure(url); const sessionId = configured.activeSessionId; const bufferId = configured.midiContinuation!.buffer!.id;
    const running = command(url, { kind: "fill_midi_continuation", sessionId, bufferId }, "continuation-fill-stop");
    try {
      await began;
      for (const kind of ["select_session", "delete_session"]) {
        const response = await command(url, { kind, sessionId }); assert.equal(response.status, 409, await response.text());
      }
      const stopped = await fetch(endpoint(url, "/stop"), { method: "POST", headers: { "Content-Type": "application/json", "X-Live-Smith-Command-Id": "continuation-fill-stop" }, body: "{}" });
      assert.equal(stopped.status, 200); await stopped.text(); release();
      const response = await running; assert.notEqual(response.status, 200); await response.text();
      assert.deepEqual((await readMidiContinuation(h.directory, sessionId))!.queue, []);
    } finally { release(); await running.catch(() => {}); }
  }, async () => { started(); await blocked; return notes("Late section"); });
});

test("Profile changes during a model request reject publication to its configured buffer", async (t) => {
  let hForModel: Awaited<ReturnType<typeof continuationHarness>>;
  await withFlow(t, async ({ url, h }) => {
    hForModel = h;
    const configured = await configure(url);
    const response = await command(url, { kind: "fill_midi_continuation", sessionId: configured.activeSessionId, bufferId: configured.midiContinuation!.buffer!.id });
    assert.notEqual(response.status, 200); await response.text();
    assert.deepEqual((await readMidiContinuation(h.directory, configured.activeSessionId))!.queue, []);
  }, async () => {
    await saveSavedProfile(hForModel.directory, { ...hForModel.profile, name: "Changed Profile" });
    return notes("Old configuration section");
  });
});
