import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";

import { pendingArtifactParentFromEvents } from "../../../src/agent/artifact-contracts.js";
import { handleAgentRequest, type AgentModelTurnRequester } from "../../../src/app/agent-request.js";
import { runtimeProfileForSavedProfile } from "../../../src/app/model/model-request.js";
import { listSessionArtifacts, selectSessionArtifact } from "../../../src/app/session/session-artifacts.js";
import type { DirectApiProfile } from "../../../src/model/profile.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { appendSessionEvent, loadSessionEvents, type SessionEvent } from "../../../src/storage/events.js";
import { inspectMidiArtifacts, midiArtifactVersion, readMidiArtifact, saveMidiArtifact } from "../../../src/storage/midi-artifacts.js";
import { createSession } from "../../../src/storage/sessions.js";
import { midiBytes, noteTrack } from "../../attachments/support/midi-test-helpers.js";
import { modelMessageText } from "../../model/support/model-message-test-helpers.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";

const authored = () => ({
  label: "Piano and bass",
  durationBeats: 8,
  tracks: [
    { name: "Piano", channel: 1, notes: [
      { pitch: 60, startTime: 0, duration: 1, velocity: 90 },
      { pitch: 64, startTime: 2, duration: 2, velocity: 96 },
    ] },
    { name: "Bass", channel: 3, notes: [{ pitch: 36, startTime: 0.5, duration: 3, velocity: 100 }] },
  ],
});

const call = (id: string, name: string, args: unknown) => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const done = () => ({ content: "Saved for review.", toolCalls: [] });

test("ordinary chat authors multitrack MIDI in an empty read-only Session and inspects it in the same request without Live writes", async (t) => {
  const h = await setup(t);
  assert.deepEqual((await inspectMidiArtifacts(h.directory, h.session.id)).artifacts, []);
  let turn = 0;
  let ref = "";
  const result = await h.run(async (request) => {
    turn++;
    if (turn === 1) {
      const tools = new Set(request.tools.filter((entry) => entry.type === "function").map((entry) => entry.function.name));
      for (const tool of ["save_midi_artifact", "list_session_artifacts", "inspect_midi_artifact"]) assert.ok(tools.has(tool));
      return call("save-score", "save_midi_artifact", authored());
    }
    const response = JSON.parse(modelMessageText(request.agentMessages.at(-1)));
    if (turn === 2) {
      assert.equal(response.artifacts.length, 1);
      const artifact = response.artifacts[0];
      ref = artifact.artifactRef;
      assert.equal(artifact.kind, "midi");
      assert.equal(artifact.noteCount, 3);
      assert.equal(artifact.durationBeats, 8);
      assert.deepEqual(artifact.version, { groupId: ref, number: 1 });
      return call("list-score", "list_session_artifacts", {});
    }
    if (turn === 3) {
      assert.equal(response.length, 1);
      assert.equal(response[0].artifactRef, ref);
      assert.deepEqual(response[0].parts.map((part: { sourceTrackName: string; channel: number; noteCount: number }) =>
        [part.sourceTrackName, part.channel, part.noteCount]), [["Piano", 1, 2], ["Bass", 3, 1]]);
      return call("inspect-piano", "inspect_midi_artifact", { artifactRef: ref, partId: response[0].parts[0].id, offset: 1 });
    }
    assert.equal(turn, 4);
    assert.equal(response.artifactRef, ref);
    assert.equal(response.part.sourceTrackName, "Piano");
    assert.equal(response.part.channel, 1);
    assert.equal(response.offset, 1);
    assert.deepEqual(response.notes, [authored().tracks[0]!.notes[1]]);
    return done();
  });
  assert.equal(result, "Saved for review.");
  assert.equal(turn, 4);
  const history = await loadSessionEvents(h.directory, h.session.id);
  assert.deepEqual(history.find((event) => event.kind === "tool_result" && event.name === "save_midi_artifact")?.artifacts, [{ kind: "midi", id: ref }]);
  const saved = await readMidiArtifact(h.directory, h.session.id, ref);
  assert.deepEqual(saved.artifact.source, { kind: "model", profileId: "profile", model: "model" });
  assert.equal(saved.artifact.toolName, "save_midi_artifact");
  assert.equal(saved.parsed.durationBeats, 8, "the saved artifact keeps its trailing silence");
  assert.deepEqual(saved.parsed.parts.map((part) => part.notes), authored().tracks.map((track) => track.notes));
  const candidates = await listSessionArtifacts(h.input);
  assert.equal(candidates.total, 1);
  assert.equal(candidates.artifacts[0]!.generation?.toolName, "save_midi_artifact");
  assert.deepEqual(JSON.parse(candidates.artifacts[0]!.generation!.parameters), authored());
  h.assertLiveUnchanged();
});

test("an admitted chat revision stays bound to v1 when historical preferences and the next-chat source change during the request", async (t) => {
  const h = await setup(t);
  const original = await h.seed("Theme", 60);
  const alternative = await h.seed("Other theme", 72);
  const before = await readMidiArtifact(h.directory, h.session.id, original.id);
  const a = { kind: "midi" as const, id: original.id };
  const b = { kind: "midi" as const, id: alternative.id };
  await selectSessionArtifact({ ...h.input, selection: { action: "continue", candidate: a } });
  let turn = 0;
  let ref = "";
  await h.run(async (request) => {
    if (++turn === 1) return call("save-revision", "save_midi_artifact", { ...authored(), label: "Theme variation" });
    ref = JSON.parse(modelMessageText(request.agentMessages.at(-1))).artifacts[0].artifactRef;
    return done();
  }, async (event) => {
    if (event.kind === "user" && !event.steeringReceipt) {
      await appendSessionEvent(h.directory, h.session.id, { kind: "candidate", content: "Preferred artifact selected.", candidateSelection: { action: "prefer", candidate: b } });
      await selectSessionArtifact({ ...h.input, selection: { action: "continue", candidate: b } });
    }
  });
  assert.equal(turn, 2);
  const revision = await readMidiArtifact(h.directory, h.session.id, ref);
  assert.deepEqual(midiArtifactVersion(revision.artifact), { groupId: original.id, number: 2, derivedFromId: original.id });
  assert.deepEqual((await readMidiArtifact(h.directory, h.session.id, original.id)).bytes, before.bytes);
  const events = await loadSessionEvents(h.directory, h.session.id);
  const user = events.find((event) => event.kind === "user")!;
  const savedCall = events.find((event) => event.kind === "tool_call" && event.name === "save_midi_artifact")!;
  assert.deepEqual(user.parentCandidate, a);
  assert.deepEqual(savedCall.parentCandidate, a);
  assert.equal(savedCall.requestEventId, user.id);
  assert.deepEqual(pendingArtifactParentFromEvents(events), b);
  assert.ok(events.some((event) => event.candidateSelection?.action === "prefer"));
  const candidate = (await listSessionArtifacts(h.input)).artifacts.find((entry) => entry.ref.id === ref)!;
  assert.deepEqual(candidate.parent, a);
  assert.equal(candidate.generation?.requestEventId, user.id);
  h.assertLiveUnchanged();
});

test("invalid authored MIDI returns tool failures without saving candidates or changing existing MIDI", async (t) => {
  const h = await setup(t);
  const existing = await h.seed("Saved theme", 65);
  const before = await readMidiArtifact(h.directory, h.session.id, existing.id);
  const artifactDirectory = path.join(h.directory, "live-smith-midi", h.session.id);
  const files = (await fs.readdir(artifactDirectory)).sort();
  const invalidChannel = authored(); invalidChannel.tracks[0]!.channel = 17;
  let turn = 0;
  await h.run(async (request) => {
    turn++;
    if (turn === 1) return call("invalid-channel", "save_midi_artifact", invalidChannel);
    if (turn <= 3) {
      assert.ok(modelMessageText(request.agentMessages.at(-1)).length > 0);
      assert.doesNotMatch(modelMessageText(request.agentMessages.at(-1)), /"artifacts"/);
      assert.deepEqual((await inspectMidiArtifacts(h.directory, h.session.id)).artifacts, [before.artifact]);
      assert.deepEqual((await fs.readdir(artifactDirectory)).sort(), files);
      if (turn === 2) return call("truncated-notes", "save_midi_artifact", { ...authored(), durationBeats: 1 });
      return call("read-preserved", "inspect_midi_artifact", { artifactRef: existing.id, partId: before.parsed.parts[0]!.id });
    }
    assert.equal(turn, 4);
    assert.deepEqual(JSON.parse(modelMessageText(request.agentMessages.at(-1))).notes, before.parsed.parts[0]!.notes);
    return done();
  });
  assert.equal(turn, 4);
  const after = await readMidiArtifact(h.directory, h.session.id, existing.id);
  assert.deepEqual(after.artifact, before.artifact);
  assert.deepEqual(after.bytes, before.bytes);
  assert.equal((await listSessionArtifacts(h.input)).total, 1);
  h.assertLiveUnchanged();
});

async function setup(t: { after(fn: () => Promise<unknown>): void }) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-midi-authoring-request-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "MIDI authoring", projectKey: "project", editScopes: [],
    scope: { kind: "selection", identity: "set", label: "Set" } });
  const signal = createHostAbortController().signal;
  const input = { storageDirectory: directory, sessionId: session.id, projectKey: "project", signal };
  const song = { handle: { id: 1n }, tempo: 120, tracks: [], returnTracks: [], scenes: [], cuePoints: [] };
  const baseline = { handle: { id: 1n }, tempo: 120, tracks: [], returnTracks: [], scenes: [], cuePoints: [] };
  const context = { application: { song }, environment: { storageDirectory: directory, tempDirectory: directory } } as never;
  const run = (request: AgentModelTurnRequester, onSessionEvent: (event: SessionEvent) => Promise<void> | void = () => {}) =>
    handleAgentRequest(context, directory, { presentation: liveContextPresentationFixture("Set"), summary: "Set", target: {}, scope: session.scope },
      "Save MIDI for review.", runtimeProfileForSavedProfile(profile()), "project", session.id,
      { signal, onDelta() {}, onProgress() {}, onSessionEvent,
        confirmActions: async () => assert.fail("Saving or reading a MIDI candidate must not request Live approval."),
        withActionExecutionLock: async () => assert.fail("Saving or reading a MIDI candidate must not enter Live mutation."),
      }, request);
  const seed = (label: string, pitch: number) => saveMidiArtifact(directory, session.id, {
    connectionId: "existing-generator", serverId: "midi", toolName: "generate_midi", label,
    bytes: midiBytes({ tracks: [noteTrack({ pitch })] }), signal,
  });
  return { directory, session, signal, input, run, seed, assertLiveUnchanged: () => assert.deepEqual(song, baseline) };
}

function profile(): DirectApiProfile {
  return { id: "profile", name: "Profile", defaultModel: "model",
    connection: { kind: "direct-api", apiFamily: "openai", apiMode: "chat-completions", baseUrl: "https://example.test/v1", apiKey: "fixture-key" },
    models: [{ model: "model", parameters: { maxOutputTokens: 4096, reasoning: { mode: "default" } }, advanced: {} }],
  };
}
