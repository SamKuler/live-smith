import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { MidiTrack, type NoteDescription } from "@ableton-extensions/sdk";
import { createHostAbortController } from "../../src/runtime/host.js";
import { createSession, updateSession } from "../../src/storage/sessions.js";
import { readMidiArtifact, saveMidiArtifact } from "../../src/storage/midi-artifacts.js";
import { appendSessionEvent, loadSessionEvents } from "../../src/storage/events.js";
import { importMidiArtifact, type MidiArtifactImportCommand } from "../../src/app/midi-artifact-import.js";
import { prepareMidiArtifactImport } from "../../src/app/midi-artifact-preview.js";
import { isMidiArtifactImportPreview } from "../../src/ui/client/wire-contracts/midi-import.js";
import { midiBytes, noteTrack, endTrack } from "../attachments/support/midi-test-helpers.js";
import { publishSessionEditScopesChange } from "../../src/app/session/session-edit-scope-events.js";
import { LiveMutationQueue } from "../../src/app/live-mutation-queue.js";
import { decidePlanApproval } from "../../src/app/agent-flow.js";
import { liveContextPresentationFixture } from "./context/support/live-context.test-harness.js";
import { parseCommandInput } from "../../src/app/chat/chat-bridge-http.js";
import { ChatBridgeCommandOutcomeUnknownError, createChatBridge } from "../../src/app/chat/chat-bridge.js";
import { activeRecoveryLedgerFromEvents } from "../../src/app/context/session-context.js";
import { digestActionIdentity } from "../../src/agent/loop.js";
import { AgentPlanExecutionError } from "../../src/live/executor.js";
import type { ChatDialogState } from "../../src/ui/chat-state.js";
import { URL } from "node:url";

async function setup(t: TestContext, bytes?: Uint8Array) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-import-midi-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Import", projectKey: "set",
    scope: { kind: "selection", identity: "set", label: "Live Set" }, editScopes: ["midi"], approvalMode: "manual" });
  const controller = createHostAbortController();
  const saved = await saveMidiArtifact(directory, session.id, { connectionId: "connection", serverId: "server", toolName: "tool", label: "Notes",
    bytes: bytes ?? new Uint8Array([77,84,104,100,0,0,0,6,0,0,0,1,1,224,77,84,114,107,0,0,0,13,0,144,60,96,131,96,128,60,64,0,255,47,0]), signal: controller.signal });
  const mutationQueue = new LiveMutationQueue();
  let writes = 0;
  const clip = { name: "Untitled", notes: [] as NoteDescription[] };
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), Object.fromEntries(Object.entries({
    handle: { id: 2n }, name: "Piano", arrangementClips: [], clipSlots: [], devices: [], takeLanes: [], mute: false, solo: false, arm: false, mutedViaSolo: false, groupTrack: null, isGrouped: false, isFoldable: false, color: 0,
    createMidiClip: async () => { writes += 1; return clip; },
  }).map(([key, value]) => [key, { value, writable: true, configurable: true }])));
  const createdTracks: typeof track[] = [];
  const song = { handle: { id: 1n }, tempo: 120, tracks: [track], returnTracks: [], scenes: [],
    createMidiTrack: async () => {
      const created = Object.defineProperties(Object.create(track), {
        handle: { value: { id: BigInt(createdTracks.length + 3) }, writable: true },
        name: { value: "MIDI", writable: true },
        arrangementClips: { value: [] },
        createMidiClip: { value: async (startBeat: number, durationBeats: number) => {
          await track.createMidiClip(startBeat, durationBeats);
          const clip = { name: "Untitled", notes: [], startTime: startBeat, duration: durationBeats };
          created.arrangementClips.push(clip); return clip;
        } },
      });
      createdTracks.push(created); song.tracks.push(created); return created;
    },
  };
  const context = { application: { song } } as never;
  const run = (confirm: () => Promise<boolean> = async () => true, command: Partial<MidiArtifactImportCommand> = {}) => importMidiArtifact({
    kind: "import_midi_artifact", sessionId: session.id, artifactRef: saved.id, trackName: "Piano", startBeat: 0,
    context, storageDirectory: directory, projectKey: "set", signal: controller.signal, mutationQueue,
    interaction: { presentation: liveContextPresentationFixture("Live Set", "other"), summary: "Live Set", scope: session.scope, target: {} },
    confirm: (plan) => decidePlanApproval(directory, session.id, plan, confirm),
    ...command,
  });
  return { run, directory, session, saved, context, song, controller, track, clip, mutationQueue, createdTracks, get writes() { return writes; } };
}

test("read-derived preview exposes parts and only unambiguous observed MIDI destinations", async (t) => {
  const h = await setup(t, midiBytes({ tracks: [endTrack(1920), noteTrack(), noteTrack({ channel: 2, pitch: 48 })] }));
  const preview = () => prepareMidiArtifactImport({ context: h.context, storageDirectory: h.directory, projectKey: "set",
    sessionId: h.session.id, artifactRef: h.saved.id, signal: h.controller.signal });
  const first = await preview();
  assert.deepEqual(first.targets, [{ trackId: "2", trackName: "Piano" }]);
  assert.deepEqual(first.parts.map((part) => part.id), ["track-1-channel-1", "track-2-channel-2"]);
  assert.equal(first.parts.some((part) => "notes" in part), false);
  assert.equal(h.writes, 0);
  const duplicate = Object.create(h.track);
  Object.defineProperty(duplicate, "handle", { value: { id: 3n } });
  h.song.tracks.push(duplicate);
  assert.deepEqual((await preview()).targets, []);
  assert.equal((await preview()).unavailableTargetCount, 2);
  await assert.rejects(prepareMidiArtifactImport({ context: h.context, storageDirectory: h.directory, projectKey: "other",
    sessionId: h.session.id, artifactRef: h.saved.id, signal: h.controller.signal }), /not available/);
});

test("mapped import rejects a replaced observed destination before approval", async (t) => {
  const h = await setup(t);
  let confirmations = 0;
  await assert.rejects(h.run(async () => { confirmations += 1; return true; }, {
    mappings: [{ partId: "track-0-channel-1", trackId: "999", trackName: "Piano" }],
  }), /destination changed/);
  assert.equal(confirmations, 0); assert.equal(h.writes, 0);
});

test("mapped import revalidates observed handle and name after approval", async (t) => {
  for (const change of ["rename", "replace"] as const) {
    const h = await setup(t);
    await assert.rejects(h.run(async () => {
      if (change === "rename") h.track.name = "Changed";
      else Object.defineProperty(h.track, "handle", { value: { id: 999n } });
      return true;
    }, { mappings: [{ partId: "track-0-channel-1", trackId: "2", trackName: "Piano" }] }), /destination changed/);
    assert.equal(h.writes, 0);
  }
});

test("mapped parts write distinct notes at a common Arrangement start", async (t) => {
  const h = await setup(t, midiBytes({ tracks: [noteTrack({ startTicks: 480 }), noteTrack({ channel: 2, pitch: 48 })] }));
  const second = Object.create(h.track);
  const clips: { notes: unknown[] }[] = [];
  const positions: number[][] = [];
  const create = async (start: number, duration: number) => {
    positions.push([start, duration]); const clip = { notes: [] }; clips.push(clip); return clip;
  };
  h.track.createMidiClip = create;
  Object.defineProperties(second, { name: { value: "Bass" }, handle: { value: { id: 3n } }, createMidiClip: { value: create } });
  h.song.tracks.push(second);
  assert.equal(await h.run(undefined, { mappings: [
    { partId: "track-0-channel-1", trackId: "2", trackName: "Piano" },
    { partId: "track-1-channel-2", trackId: "3", trackName: "Bass" },
  ], startBeat: 8 }), true);
  assert.deepEqual(positions, [[8, 2], [8, 1]]);
  assert.deepEqual(clips.map((clip) => clip.notes), [
    [{ pitch: 60, startTime: 1, duration: 1, velocity: 96 }],
    [{ pitch: 48, startTime: 0, duration: 1, velocity: 96 }],
  ]);
  assert.equal(h.song.tempo, 120);
});

test("multitrack partial failure records completed parts and blocks a blind retry", async (t) => {
  const h = await setup(t, midiBytes({ tracks: [noteTrack(), noteTrack({ channel: 2, pitch: 48 })] }));
  const second = Object.create(h.track);
  let attempts = 0;
  Object.defineProperties(second, { name: { value: "Bass" }, handle: { value: { id: 3n } },
    createMidiClip: { value: async () => { attempts += 1; throw new Error("Disconnected"); } } });
  h.song.tracks.push(second);
  const command = { mappings: [
    { partId: "track-0-channel-1", trackId: "2", trackName: "Piano" },
    { partId: "track-1-channel-2", trackId: "3", trackName: "Bass" },
  ], startBeat: 8 };
  await assert.rejects(h.run(undefined, command), /Inspect Live/);
  assert.equal(h.writes, 1); assert.equal(attempts, 1); assert.equal(h.song.tempo, 120);
  const recovery = activeRecoveryLedgerFromEvents(await loadSessionEvents(h.directory, h.session.id));
  assert.ok(recovery?.completedActionDigests.length);
  await assert.rejects(h.run(undefined, command), /unfinished Live operation/);
  assert.equal(h.writes, 1); assert.equal(attempts, 1);
});

test("MIDI mapped commands reject duplicate parts, duplicate targets and mixed modes", () => {
  const mapping = { partId: "track-0-channel-1", trackId: "2", trackName: "Piano" };
  const valid = { kind: "import_midi_artifact", sessionId: "session", artifactRef: "artifact", mappings: [mapping], startBeat: 8 };
  assert.deepEqual(parseCommandInput(valid), valid);
  for (const patch of [{ mappings: [] }, { mappings: [mapping, mapping] },
    { mappings: [mapping, { ...mapping, partId: "track-1-channel-2" }] }, { trackName: "Piano" }, { mergeParts: true },
    { mappings: [{ ...mapping, partId: "track-0-channel-17" }] }, { mappings: [{ ...mapping, secret: "no" }] },
    ...[2, "track_2", "2e10", "2.5", " 2", "02"].map((trackId) => ({ mappings: [{ ...mapping, trackId }] }))]) {
    assert.throws(() => parseCommandInput({ ...valid, ...patch }));
  }
});

test("explicit MIDI import materializes saved notes and records the applied result", async (t) => {
  const h = await setup(t);
  let confirmations = 0;
  assert.equal(await h.run(async () => { confirmations += 1; return true; }), true);
  assert.equal(confirmations, 1);
  assert.equal(h.writes, 1);
  assert.equal(h.clip.notes.length, 1);
  const events = await loadSessionEvents(h.directory, h.session.id);
  assert.equal(events.at(-1)?.kind, "apply_result");
  assert.equal(events.at(-1)?.applyOperation?.status, "applied");
  assert.equal(events[0]?.applyOperation?.status, "proposed");
  assert.equal(events[0]?.applyOperation?.id, events.at(-1)?.applyOperation?.id);
  assert.match(events.at(-1)!.content, /^Applied:\n- /u);
});

test("explicit MIDI import cancellation performs no writes", async (t) => {
  const h = await setup(t);
  assert.equal(await h.run(async () => false), false);
  assert.equal(h.writes, 0);
  const events = await loadSessionEvents(h.directory, h.session.id);
  assert.equal(events.at(-1)?.applyOperation?.status, "cancelled");
  assert.equal(events[0]?.applyOperation?.id, events.at(-1)?.applyOperation?.id);
});

test("MIDI import rechecks permissions and target after confirmation", async (t) => {
  for (const change of ["scope", "target", "abort"] as const) {
    const h = await setup(t);
    let reachedConfirmation = false;
    await assert.rejects(h.run(async () => {
      reachedConfirmation = true;
      if (change === "scope") await updateSession(h.directory, h.session.id, { editScopes: [] });
      if (change === "target") h.track.name = "Renamed";
      if (change === "abort") h.controller.abort();
      return true;
    }));
    assert.equal(reachedConfirmation, true);
    assert.equal(h.writes, 0);
    const events = await loadSessionEvents(h.directory, h.session.id);
    assert.equal(events.at(-1)?.applyOperation?.status, change === "abort" ? "cancelled" : "failed");
  }
});

test("read-only scope denies import even under Accept Everything", async (t) => {
  const h = await setup(t);
  await updateSession(h.directory, h.session.id, { editScopes: [], approvalMode: "everything" });
  await assert.rejects(h.run(), /edit scope/i);
  assert.equal(h.writes, 0);
});

test("MIDI command rejects unexpected fields and invalid positions", () => {
  const valid = { kind: "import_midi_artifact", sessionId: "session", artifactRef: "artifact", trackName: "Piano", startBeat: 0 };
  assert.deepEqual(parseCommandInput(valid), valid);
  for (const patch of [{ startBeat: -1 }, { startBeat: Infinity }, { trackName: " " }, { path: "/tmp/private.mid" }]) {
    assert.throws(() => parseCommandInput({ ...valid, ...patch }));
  }
});


test("import approval follows Low Risk and Accept Everything policies", async (t) => {
  for (const approvalMode of ["low-risk", "everything"] as const) {
    const h = await setup(t);
    await updateSession(h.directory, h.session.id, { approvalMode });
    let confirmations = 0;
    assert.equal(await h.run(async () => { confirmations += 1; return true; }), true);
    assert.equal(confirmations, approvalMode === "everything" ? 0 : 1);
    assert.equal(h.writes, 1);
    const events = await loadSessionEvents(h.directory, h.session.id);
    assert.equal(events.at(-1)?.applyOperation?.status, "applied");
    assert.equal(events.some((event) => event.applyOperation?.status === "approved"), approvalMode === "everything");
  }
});

test("queued MIDI import detects target drift after it acquires the shared mutation queue", async (t) => {
  const h = await setup(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const blocker = h.mutationQueue.run(h.controller.signal, () => gate);
  let approved!: () => void;
  const confirmation = new Promise<void>((resolve) => { approved = resolve; });
  const pending = h.run(async () => { approved(); return true; });
  await confirmation;
  h.track.name = "Changed while queued";
  release();
  await blocker;
  await assert.rejects(pending);
  assert.equal(h.writes, 0);
});

test("uncertain host mutation is reported without retrying", async (t) => {
  const h = await setup(t);
  let attempts = 0;
  h.track.createMidiClip = async () => { attempts += 1; throw new Error("Host disconnected"); };
  await assert.rejects(h.run(), /Inspect Live before trying again/);
  assert.equal(attempts, 1);
  const events = await loadSessionEvents(h.directory, h.session.id);
  assert.equal(events.at(-1)?.kind, "apply_result");
  assert.ok(activeRecoveryLedgerFromEvents(events));
  await assert.rejects(h.run(), /unfinished Live operation/);
  assert.equal(attempts, 1);
});


test("partially created MIDI persists canonical recovery and blocks another direct import", async (t) => {
  const h = await setup(t);
  Object.defineProperty(h.clip, "notes", { configurable: true, get: () => [], set: () => { throw new Error("Notes write failed"); } });
  let failure: AgentPlanExecutionError | undefined;
  await assert.rejects(h.run(), (error: unknown) => {
    assert.ok(error instanceof ChatBridgeCommandOutcomeUnknownError);
    assert.ok(error.cause instanceof AgentPlanExecutionError);
    failure = error.cause;
    return true;
  });
  assert.equal(h.writes, 1);
  assert.ok(failure!.completedMutationCount > 0);
  const events = await loadSessionEvents(h.directory, h.session.id);
  const recovery = activeRecoveryLedgerFromEvents(events);
  assert.equal(events.at(-1)?.applyOperation?.status, "partial");
  assert.equal(events[0]?.applyOperation?.id, events.at(-1)?.applyOperation?.id);
  assert.ok(recovery, "the next chat request must receive the unfinished operation");
  assert.deepEqual(recovery.completedActionDigests,
    [...new Set(failure!.completedActionKeys.flat().map(digestActionIdentity))].sort());
  assert.ok(recovery.completedActionDigests.length > 0);
  await assert.rejects(h.run(), /unfinished Live operation/);
  assert.equal(h.writes, 1);
  assert.deepEqual(activeRecoveryLedgerFromEvents(await loadSessionEvents(h.directory, h.session.id)), recovery);
});

test("direct import preserves an existing unfinished recovery without asking approval", async (t) => {
  const h = await setup(t);
  const recovery = { active: true, completedActionDigests: [digestActionIdentity("existing Live action")] };
  await appendSessionEvent(h.directory, h.session.id, { kind: "apply_result", content: "Unfinished prior operation", recovery });
  let confirmations = 0;
  await assert.rejects(h.run(async () => { confirmations += 1; return true; }), /unfinished Live operation/);
  assert.equal(confirmations, 0);
  assert.equal(h.writes, 0);
  assert.deepEqual(activeRecoveryLedgerFromEvents(await loadSessionEvents(h.directory, h.session.id)), {
    completedActionDigests: recovery.completedActionDigests, unresolvedFailure: "Unfinished prior operation",
  });
});

for (const failure of ["host", "partial", "history"] as const) {
  test(`HTTP MIDI import reconciles ${failure} failures as unknown without retrying`, async (t) => {
    const h = await setup(t);
    let attempts = 0;
    const create = h.track.createMidiClip;
    h.track.createMidiClip = async () => {
      attempts += 1;
      if (failure === "host") throw new Error("Host reply lost");
      const clip = await create();
      if (failure === "history") await fs.writeFile(`${h.directory}/live-smith-events/${h.session.id}.json`, "invalid history");
      return clip;
    };
    if (failure === "partial") Object.defineProperty(h.clip, "notes", {
      get: () => [], set: () => { throw new Error("Notes write failed"); },
    });
    let stateBuilds = 0;
    const state = { status: "Authoritative Session state" } as ChatDialogState;
    const bridge = await createChatBridge({
      buildState: async () => { stateBuilds += 1; return state; }, renderHtml: () => "<html></html>",
      handleSend: async () => {}, handleCommand: async () => { await h.run(); return state; },
    });
    t.after(() => bridge.close());
    const url = new URL(bridge.url); url.pathname = "/command";
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Live-Smith-Command-Id": "midi-import-command" },
      body: JSON.stringify({ kind: "import_midi_artifact", sessionId: h.session.id,
        artifactRef: "artifact", trackName: "Piano", startBeat: 0 }),
    });
    assert.equal(response.status, 500);
    const result = await response.json() as { commandOutcome?: string; state?: ChatDialogState };
    assert.equal(result.commandOutcome, "unknown");
    assert.equal(result.state?.status, state.status);
    assert.equal(stateBuilds, 1);
    assert.equal(attempts, 1);
    assert.equal(h.writes, failure === "host" ? 0 : 1);
  });
}


for (const mode of ["parts", "merge"] as const) {
  test(`observed large Live handle survives JSON preview and ${mode} import admission`, async (t) => {
    const h = await setup(t);
    const handleId = (1n << 151n) + 7n;
    h.track.handle = { id: handleId };
    const preview = JSON.parse(JSON.stringify(await prepareMidiArtifactImport({ context: h.context,
      storageDirectory: h.directory, projectKey: "set", sessionId: h.session.id,
      artifactRef: h.saved.id, signal: h.controller.signal })));
    assert.equal(isMidiArtifactImportPreview(preview), true);
    assert.equal(preview.targets[0].trackId, String(handleId));
    const command = parseCommandInput({ kind: "import_midi_artifact", sessionId: h.session.id,
      artifactRef: h.saved.id, startBeat: 0, ...(mode === "parts"
        ? { mappings: [{ partId: preview.parts[0].id, ...preview.targets[0] }] }
        : { ...preview.targets[0], mergeParts: true }) });
    assert.equal(command.kind, "import_midi_artifact");
    if (command.kind !== "import_midi_artifact") throw new Error("Expected MIDI import command");
    assert.equal(await h.run(async () => true, command), true);
    assert.equal(h.writes, 1);
    assert.deepEqual(h.clip.notes, [{ pitch: 60, startTime: 0, duration: 1, velocity: 96 }]);
  });
}


test("preview returns observed Arrangement defaults, including beat zero, without inventing a cursor", async (t) => {
  const h = await setup(t);
  const base = { context: h.context, storageDirectory: h.directory, projectKey: "set",
    sessionId: h.session.id, artifactRef: h.saved.id, signal: h.controller.signal };
  const plain = await prepareMidiArtifactImport(base);
  assert.equal(plain.maxActions, 64);
  assert.equal(plain.suggestedTrackId, undefined);
  assert.equal(plain.suggestedStartBeat, undefined);
  for (const [origin, start] of [["arrangement-selection", 0], ["object", 12]] as const) {
    const result = await prepareMidiArtifactImport({ ...base, interaction: {
      presentation: { ...liveContextPresentationFixture("Arrangement", "midi-clip"), origin,
        range: { coordinate: "arrangement-beats", start, end: start + 4 } },
      summary: "Arrangement", scope: h.session.scope, target: { track: h.track },
    } });
    assert.equal(result.suggestedTrackId, "2");
    assert.equal(result.suggestedStartBeat, start);
    assert.equal(isMidiArtifactImportPreview(JSON.parse(JSON.stringify(result))), true);
  }
  const stale = Object.create(h.track);
  Object.defineProperty(stale, "handle", { value: { id: 999n } });
  const unavailable = await prepareMidiArtifactImport({ ...base, interaction: {
    presentation: liveContextPresentationFixture("Session Clip", "midi-clip"),
    summary: "Session Clip", scope: h.session.scope, target: { track: stale },
  } });
  assert.equal(unavailable.suggestedTrackId, undefined);
  assert.equal(unavailable.suggestedStartBeat, undefined);
  for (const patch of [{ suggestedTrackId: "999" }, { suggestedTrackId: 2 },
    { suggestedStartBeat: -1 }, { suggestedStartBeat: Infinity }, { suggestedStartBeat: "0" }, { maxActions: 65 }]) {
    assert.equal(isMidiArtifactImportPreview({ ...plain, ...patch }), false);
  }
});

test("mapped import creates separate tracks through bound creator refs and preserves source bytes", async (t) => {
  const bytes = midiBytes({ tracks: [noteTrack(), noteTrack({ channel: 2, pitch: 48 })] });
  const h = await setup(t, bytes);
  await updateSession(h.directory, h.session.id, { editScopes: ["midi", "structure"] });
  assert.equal(await h.run(undefined, { mappings: [
    { partId: "track-0-channel-1", createTrack: true, trackName: "Piano" },
    { partId: "track-1-channel-2", createTrack: true, trackName: "Piano" },
  ], startBeat: 8 }), true);
  assert.equal(h.createdTracks.length, 2);
  assert.deepEqual(h.createdTracks.map((track) => track.name), ["Piano", "Piano"]);
  assert.equal(h.writes, 2);
  assert.deepEqual(h.createdTracks.map((track) => track.arrangementClips.map((clip: { startTime: number; notes: { pitch: number }[] }) =>
    ({ startBeat: clip.startTime, pitches: clip.notes.map((note) => note.pitch) }))), [
    [{ startBeat: 8, pitches: [60] }], [{ startBeat: 8, pitches: [48] }],
  ]);
  assert.equal(h.song.tempo, 120);
  assert.deepEqual((await readMidiArtifact(h.directory, h.session.id, h.saved.id, h.controller.signal)).bytes, bytes);
});

test("explicit merge creates one MIDI track and keeps every part's notes", async (t) => {
  const h = await setup(t, midiBytes({ tracks: [noteTrack(), noteTrack({ channel: 2, pitch: 48 })] }));
  await updateSession(h.directory, h.session.id, { editScopes: ["midi", "structure"] });
  assert.equal(await h.run(undefined, { trackName: "Combined", createTrack: true, mergeParts: true }), true);
  assert.equal(h.createdTracks.length, 1);
  assert.equal(h.createdTracks[0].name, "Combined");
  assert.equal(h.writes, 1);
  assert.deepEqual(h.createdTracks[0].arrangementClips[0].notes.map((note: { pitch: number }) => note.pitch).sort(), [48, 60]);
});

test("a mixed existing/new import needs all scopes before any approval or mutation", async (t) => {
  const h = await setup(t, midiBytes({ tracks: [noteTrack(), noteTrack({ channel: 2 })] }));
  await updateSession(h.directory, h.session.id, { approvalMode: "everything" });
  let confirmations = 0;
  await assert.rejects(h.run(async () => { confirmations += 1; return true; }, { mappings: [
    { partId: "track-0-channel-1", trackId: "2", trackName: "Piano" },
    { partId: "track-1-channel-2", createTrack: true, trackName: "New MIDI" },
  ] }), /edit scope/i);
  assert.equal(confirmations, 0);
  assert.equal(h.writes, 0);
  assert.equal(h.createdTracks.length, 0);
});

test("new MIDI track import obeys ordinary approval modes", async (t) => {
  for (const approvalMode of ["manual", "low-risk", "everything"] as const) {
    const h = await setup(t);
    await updateSession(h.directory, h.session.id, { editScopes: ["midi", "structure"], approvalMode });
    let confirmations = 0;
    assert.equal(await h.run(async () => { confirmations += 1; return true; }, { createTrack: true, trackName: "New MIDI" }), true);
    assert.equal(confirmations, approvalMode === "everything" ? 0 : 1);
    assert.equal(h.createdTracks.length, 1);
    assert.equal(h.writes, 1);
  }
});

test("new MIDI tracks are not created after cancel, Stop, or withdrawn structure scope", async (t) => {
  for (const change of ["cancel", "abort", "scope"] as const) {
    const h = await setup(t);
    await updateSession(h.directory, h.session.id, { editScopes: ["midi", "structure"] });
    const pending = h.run(async () => {
      if (change === "abort") h.controller.abort();
      if (change === "scope") await updateSession(h.directory, h.session.id, { editScopes: ["midi"] });
      return change !== "cancel";
    }, { createTrack: true, trackName: "New MIDI" });
    if (change === "cancel") assert.equal(await pending, false);
    else await assert.rejects(pending);
    assert.equal(h.createdTracks.length, 0);
    assert.equal(h.writes, 0);
  }
});

test("mixed imports revalidate large existing destination handles before creating a track", async (t) => {
  const h = await setup(t, midiBytes({ tracks: [noteTrack(), noteTrack({ channel: 2 })] }));
  const id = (1n << 151n) + 7n;
  h.track.handle = { id };
  await updateSession(h.directory, h.session.id, { editScopes: ["midi", "structure"] });
  await assert.rejects(h.run(async () => { h.track.handle = { id: id + 1n }; return true; }, { mappings: [
    { partId: "track-0-channel-1", createTrack: true, trackName: "New MIDI" },
    { partId: "track-1-channel-2", trackId: String(id), trackName: "Piano" },
  ] }), /destination changed/);
  assert.equal(h.createdTracks.length, 0);
  assert.equal(h.writes, 0);
});

test("track creation and Clip creation share the 64-action import budget", async (t) => {
  const tracks = Array.from({ length: 32 }, () => noteTrack());
  tracks[0] = [...noteTrack().slice(0, -4), ...noteTrack({ channel: 2 })];
  const mappings = Array.from({ length: 32 }, (_, index) => ({
    partId: `track-${index}-channel-1`, createTrack: true as const, trackName: `Part ${index + 1}`,
  }));
  const h = await setup(t, midiBytes({ tracks }));
  await updateSession(h.directory, h.session.id, { editScopes: ["midi", "structure"] });
  let confirmations = 0;
  await assert.rejects(h.run(async () => { confirmations += 1; return true; }, { mappings: [
    ...mappings, { partId: "track-0-channel-2", trackId: "2", trackName: "Piano" },
  ] }), /at most 64 actions/);
  assert.equal(confirmations, 0);
  assert.equal(h.writes, 0);
  assert.equal(h.createdTracks.length, 0);
  assert.equal(await h.run(undefined, { mappings }), true);
  assert.equal(h.createdTracks.length, 32);
  assert.equal(h.writes, 32);
});

test("a failure after creating a MIDI track persists recovery and blocks duplicate creation", async (t) => {
  const h = await setup(t);
  await updateSession(h.directory, h.session.id, { editScopes: ["midi", "structure"] });
  h.track.createMidiClip = async () => { throw new Error("Clip write disconnected"); };
  const command = { createTrack: true, trackName: "New MIDI" };
  await assert.rejects(h.run(undefined, command), /Inspect Live/);
  assert.equal(h.createdTracks.length, 1);
  assert.equal(h.writes, 0);
  const recovery = activeRecoveryLedgerFromEvents(await loadSessionEvents(h.directory, h.session.id));
  assert.ok(recovery?.completedActionDigests.length);
  await assert.rejects(h.run(undefined, command), /unfinished Live operation/);
  assert.equal(h.createdTracks.length, 1);
});


test("mixed imports keep an existing handle bound when a new track has the same name", async (t) => {
  const h = await setup(t, midiBytes({ tracks: [noteTrack(), noteTrack({ channel: 2, pitch: 48 })] }));
  await updateSession(h.directory, h.session.id, { editScopes: ["midi", "structure"] });
  assert.equal(await h.run(undefined, { mappings: [
    { partId: "track-0-channel-1", createTrack: true, trackName: "Piano" },
    { partId: "track-1-channel-2", trackId: "2", trackName: "Piano" },
  ] }), true);
  assert.equal(h.createdTracks.length, 1);
  assert.equal(h.writes, 2);
  assert.equal(h.clip.notes[0]!.pitch, 48);
  assert.equal(h.createdTracks[0].arrangementClips[0].notes[0].pitch, 60);
});

test("Stop while a new-track import waits for the mutation queue creates nothing", async (t) => {
  const h = await setup(t);
  await updateSession(h.directory, h.session.id, { editScopes: ["midi", "structure"] });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const blocker = h.mutationQueue.run(h.controller.signal, () => gate);
  let approved!: () => void;
  const confirmation = new Promise<void>((resolve) => { approved = resolve; });
  const pending = h.run(async () => { approved(); return true; }, { createTrack: true, trackName: "New MIDI" });
  await confirmation;
  h.controller.abort();
  release();
  await blocker;
  await assert.rejects(pending);
  assert.equal(h.createdTracks.length, 0);
  assert.equal(h.writes, 0);
});

test("withdrawing MIDI scope during track creation stops the following Clip and persists recovery", async (t) => {
  const h = await setup(t);
  await updateSession(h.directory, h.session.id, { editScopes: ["midi", "structure"] });
  const create = h.song.createMidiTrack;
  h.song.createMidiTrack = async () => {
    const track = await create();
    await updateSession(h.directory, h.session.id, { editScopes: ["structure"] });
    publishSessionEditScopesChange(h.directory, { sessionId: h.session.id, editScopes: ["structure"], updatedAt: new Date().toISOString() });
    return track;
  };
  await assert.rejects(h.run(undefined, { createTrack: true, trackName: "New MIDI" }), /Inspect Live/);
  assert.equal(h.createdTracks.length, 1);
  assert.equal(h.writes, 0);
  assert.ok(activeRecoveryLedgerFromEvents(await loadSessionEvents(h.directory, h.session.id))?.completedActionDigests.length);
});

test("MIDI command admission accepts explicit new destinations and budgets their creator actions", () => {
  const base = { kind: "import_midi_artifact", sessionId: "session", artifactRef: "artifact", startBeat: 0 };
  const mapping = { partId: "track-0-channel-1", createTrack: true, trackName: "New MIDI" };
  const mappings = Array.from({ length: 32 }, (_, index) => ({ ...mapping, partId: `track-${index}-channel-1` }));
  for (const command of [{ ...base, mappings: [mapping] }, { ...base, mappings },
    { ...base, createTrack: true, trackName: "Merged", mergeParts: true },
    { ...base, mappings: [mapping, { partId: "track-1-channel-1", trackId: "2", trackName: "Piano" }] }]) {
    assert.deepEqual(parseCommandInput(command), command);
  }
  for (const patch of [{ mappings: [{ ...mapping, trackId: "2" }] },
    { mappings: [{ ...mapping, createTrack: false }] }, { mappings: [{ ...mapping, createTrack: "true" }] },
    { mappings: [{ ...mapping, createTrack: undefined }] }, { mappings: [{ ...mapping, trackName: " " }] },
    { mappings, createTrack: true },
    { mappings: [...mappings, { partId: "track-0-channel-2", trackId: "2", trackName: "Piano" }] },
    { createTrack: true, trackId: "2", trackName: "New MIDI" }, { createTrack: false, trackName: "Piano" },
    { createTrack: "true", trackName: "New MIDI" }, { createTrack: true }]) {
    assert.throws(() => parseCommandInput({ ...base, ...patch }));
  }
});
