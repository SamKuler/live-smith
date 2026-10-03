import assert from "node:assert/strict";
import test from "node:test";
import { audioStorageHarness } from "../../storage/support/audio-storage-test-helpers.js";
import { midiBytes, noteTrack, sequentialNotes } from "../../attachments/support/midi-test-helpers.js";
import { saveMidiArtifact } from "../../../src/storage/midi-artifacts.js";
import { appendSessionEvent, loadSessionEvents, type SessionEvent } from "../../../src/storage/events.js";
import { createSession } from "../../../src/storage/sessions.js";
import { listSessionArtifacts, selectSessionArtifact, artifactGenerationsFromEvents } from "../../../src/app/session/session-artifacts.js";
import { artifactKey, pendingArtifactParentFromEvents, preferredArtifactFromEvents } from "../../../src/agent/artifact-contracts.js";
import { createSessionMidiArtifactToolset } from "../../../src/app/midi/midi-artifact-tools.js";
import { parseCommandInput } from "../../../src/app/chat/chat-bridge-http.js";

test("artifacts project owned audio/MIDI, parameters and parent from persisted Session events", async (t) => {
  const h = await audioStorageHarness(t);
  const audio = await h.save("vocals");
  const parent = { kind: "audio" as const, id: audio.id };
  const request = await appendSessionEvent(h.storage, h.session.id, { kind: "user", content: "Write a variation", parentCandidate: parent });
  const call = await appendSessionEvent(h.storage, h.session.id, { kind: "tool_call", name: "make_midi",
    content: JSON.stringify({ prompt: "Syncopated", seed: 12 }), parentCandidate: parent, requestEventId: request.id });
  const midi = await saveMidiArtifact(h.storage, h.session.id, { connectionId: "midi-generator", serverId: "midi", toolName: "make_midi",
    label: "Variation", bytes: midiBytes({ tracks: [noteTrack(), noteTrack({ channel: 2 })] }), signal: h.signal });
  const result = await appendSessionEvent(h.storage, h.session.id, { kind: "tool_result", name: "make_midi",
    content: JSON.stringify({ artifacts: [{ kind: "midi", artifactRef: midi.id }] }) });
  const input = { storageDirectory: h.storage, sessionId: h.session.id, projectKey: "test-project", signal: h.signal };
  await selectSessionArtifact({ ...input, selection: { action: "prefer", candidate: { kind: "midi", id: midi.id } } });
  await selectSessionArtifact({ ...input, selection: { action: "continue", candidate: parent } });
  await appendSessionEvent(h.storage, h.session.id, { kind: "compaction", content: "Checkpoint" });
  const restarted = await listSessionArtifacts(input);
  assert.equal(restarted.artifacts.length, 2);
  const candidate = restarted.artifacts.find((entry) => entry.ref.kind === "midi")!;
  assert.equal(candidate.preferred, true); assert.deepEqual(candidate.parent, parent);
  assert.deepEqual(candidate.generation, { toolName: "make_midi", callEventId: call.id, resultEventId: result.id,
    requestEventId: request.id, parameters: '{"prompt":"Syncopated","seed":12}', parametersTruncated: false });
  assert.equal(candidate.midi!.parts.length, 2);
  assert.deepEqual(candidate.midi!.notes.map((note) => note.pitch), [60, 60]);
  assert.deepEqual(restarted.continuation, parent);
  assert.equal(restarted.artifacts.find((entry) => entry.ref.kind === "audio")!.generation, undefined);
  assert.doesNotMatch(JSON.stringify(restarted), /connectionFingerprint|authorization|apiKey|\/private\//);
  assert.deepEqual(await listSessionArtifacts(input), restarted, "a fresh read rebuilds the same state without process-local candidate storage");
  const other = await createSession(h.storage, { title: "Other", projectKey: "test-project", scope: { kind: "selection", identity: "other", label: "Other" } });
  assert.deepEqual((await listSessionArtifacts({ ...input, sessionId: other.id })).artifacts, []);
  for (const ref of [parent, { kind: "midi" as const, id: midi.id }]) {
    await assert.rejects(selectSessionArtifact({ ...input, sessionId: other.id, selection: { action: "prefer", candidate: ref } }));
  }
  assert.equal((await loadSessionEvents(h.storage, other.id)).length, 0);
});

test("pending continuation survives failed admission, preferences, read tools and compaction; initial user consumes it", async (t) => {
  const h = await audioStorageHarness(t); const audio = await h.save("vocals");
  const a = { kind: "audio" as const, id: audio.id }; const b = { kind: "midi" as const, id: "midi-b" };
  const input = { storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal };
  await selectSessionArtifact({ ...input, selection: { action: "continue", candidate: a } });
  await assert.rejects(selectSessionArtifact({ ...input, selection: { action: "continue", candidate: b } }));
  await appendSessionEvent(h.storage, h.session.id, { kind: "candidate", content: "Preferred B", candidateSelection: { action: "prefer", candidate: b } });
  await appendSessionEvent(h.storage, h.session.id, { kind: "tool_call", name: "get_audio_job", content: "{}" });
  await appendSessionEvent(h.storage, h.session.id, { kind: "compaction", content: "Checkpoint" });
  let events = await loadSessionEvents(h.storage, h.session.id);
  assert.deepEqual(pendingArtifactParentFromEvents(events), a);
  assert.deepEqual(preferredArtifactFromEvents(events), b);
  await assert.rejects(appendSessionEvent(h.storage, h.session.id, { kind: "user", content: "Fail before commit", parentCandidate: { kind: "midi", id: "../bad" } }));
  assert.deepEqual(pendingArtifactParentFromEvents(await loadSessionEvents(h.storage, h.session.id)), a);
  const user = await appendSessionEvent(h.storage, h.session.id, { kind: "user", content: "Variation", parentCandidate: a });
  events = await loadSessionEvents(h.storage, h.session.id);
  assert.equal(pendingArtifactParentFromEvents(events), undefined);
  user.parentCandidate!.id = "changed-return-value";
  assert.deepEqual((await loadSessionEvents(h.storage, h.session.id)).at(-1)!.parentCandidate, a);
  await appendSessionEvent(h.storage, h.session.id, { kind: "candidate", content: "Prepare B", candidateSelection: { action: "continue", candidate: b } });
  await appendSessionEvent(h.storage, h.session.id, { kind: "tool_call", name: "generate", content: "{}", parentCandidate: a, requestEventId: user.id });
  assert.deepEqual(pendingArtifactParentFromEvents(await loadSessionEvents(h.storage, h.session.id)), b);
});

test("overlapping same-name calls keep provenance unknown instead of guessing", () => {
  const event = (id: string, kind: SessionEvent["kind"], content: string): SessionEvent => ({ id, kind, name: "make", content, createdAt: "2026-10-03T00:00:00Z" });
  const events = [event("a", "tool_call", '{"seed":1}'), event("b", "tool_call", '{"seed":2}'),
    event("ra", "tool_result", '{"artifacts":[{"kind":"midi","artifactRef":"midi-a"}]}'),
    event("rb", "tool_result", '{"artifacts":[{"kind":"midi","artifactRef":"midi-b"}]}')];
  assert.equal(artifactGenerationsFromEvents(events).size, 0);
});

test("saved MIDI inspection pages exact notes without provider calls and rejects foreign parts", async (t) => {
  const h = await audioStorageHarness(t);
  const saved = await saveMidiArtifact(h.storage, h.session.id, { connectionId: "generator", serverId: "midi", toolName: "make",
    label: "Long pattern", bytes: midiBytes({ tracks: [sequentialNotes(300)] }), signal: h.signal });
  const tools = createSessionMidiArtifactToolset({ storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal });
  const inspect = (args: unknown) => tools.callTool({ id: "inspect", name: "inspect_midi_artifact", arguments: JSON.stringify(args) });
  const first = JSON.parse((await inspect({ artifactRef: saved.id, partId: "track-0-channel-1" })).content);
  assert.equal(first.notes.length, 256); assert.equal(first.nextOffset, 256); assert.equal(first.part.noteCount, 300);
  const second = JSON.parse((await inspect({ artifactRef: saved.id, partId: "track-0-channel-1", offset: first.nextOffset })).content);
  assert.equal(second.notes.length, 44); assert.equal(second.nextOffset, undefined);
  assert.equal(second.notes[0].startTime, 256 / 480);
  for (const patch of [{ artifactRef: "other-session-artifact" }, { partId: "track-99-channel-1" }, { offset: -1 }, { offset: 301 }, { path: "private" }]) {
    assert.equal((await inspect({ artifactRef: saved.id, partId: "track-0-channel-1", ...patch })).invalidArguments, true);
  }
  const listing = await listSessionArtifacts({ storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal });
  assert.equal(listing.artifacts[0]!.midi!.notes.length, 256); assert.equal(listing.artifacts[0]!.midi!.omittedNoteCount, 44);
  assert.equal(artifactKey(listing.artifacts[0]!.ref), `midi:${saved.id}`);
});

test("artifact commands admit only exact Session references and selection semantics", () => {
  const command = { kind: "select_artifact", sessionId: "session", selection: { action: "continue", candidate: { kind: "midi", id: "midi-one" } } };
  assert.deepEqual(parseCommandInput(command), command);
  assert.throws(() => parseCommandInput({ ...command, parameters: { secret: true } }));
  assert.throws(() => parseCommandInput({ ...command, selection: { action: "generate", candidate: command.selection.candidate } }));
  assert.throws(() => parseCommandInput({ ...command, selection: { action: "prefer", candidate: { kind: "midi", id: "../other" } } }));
});
