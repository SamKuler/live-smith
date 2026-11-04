import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { URL } from "node:url";
import { createAgentRuntime } from "../../../src/app/agent-flow.js";
import { writeStandardMidi } from "../../../src/attachments/midi-writer.js";
import { saveMidiArtifact, deleteSessionMidiArtifacts } from "../../../src/storage/midi-artifacts.js";
import { saveAudioAsset } from "../../../src/storage/audio-assets.js";
import { createAudioJob, updateAudioJob } from "../../../src/storage/audio-jobs.js";
import { createSession } from "../../../src/storage/sessions.js";
import { waveBytes } from "../../storage/support/audio-storage-test-helpers.js";
import type { NativeDragInput } from "../../../src/runtime/native-chat-window.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const storage = await fs.mkdtemp("/private/tmp/live-smith-native-drag-flow-");
  const song = { handle: { id: 1n }, tracks: [], scenes: [] };
  const runtime = await createAgentRuntime({ application: { song }, environment: { storageDirectory: storage } } as never,
    { summary: "Files", presentation: { origin: "object", objectKind: "other", title: "Files", details: [] }, scope: { kind: "object", identity: "files", label: "Files" }, target: {} },
    { renderHtml: () => "<html></html>", nativeChatHost: { supported: true, open: async () => { throw new Error("unused"); } } }, "native");
  t.after(async () => { await runtime.close(); await fs.rm(storage, { recursive: true, force: true }); });
  const endpoint = new URL(runtime.url); endpoint.pathname = "/state";
  const state = await (await fetch(endpoint)).json();
  return { storage, runtime, state, song };
}

test("native drag reads exact saved MIDI and audio and retains handed-off files independently of the Session source", async t => {
  const { storage, runtime, state } = await fixture(t);
  const midiBytes = writeStandardMidi({ durationBeats: 4, tracks: [{ name: "Lead", channel: 1, notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 80 }] }] });
  const midi = await saveMidiArtifact(storage, state.activeSessionId, { pluginId: "fixture", serverId: "fixture", toolName: "phrase", label: "Phrase", bytes: midiBytes, signal: new AbortController().signal });
  const job = await createAudioJob(storage, state.activeSessionId, { provider: "elevenlabs", serviceId: "fixture", connectionFingerprint: "a".repeat(64), operation: "generate_music", stems: [] });
  const audioBytes = waveBytes();
  const asset = await saveAudioAsset(storage, state.activeSessionId, { jobId: job.id, role: "music", label: "Music", origin: { kind: "generated" }, bytes: audioBytes, signal: new AbortController().signal });
  await updateAudioJob(storage, state.activeSessionId, job.id, { status: "completed", outputAssets: [asset] });
  const copies = [];
  for (const [artifact, bytes] of [[{ kind: "midi", id: midi.id }, midiBytes], [{ kind: "audio", id: asset.id }, audioBytes]] as const) {
    const copy = await runtime.prepareArtifactExport({ sessionId: state.activeSessionId, artifact }, new AbortController().signal);
    assert.deepEqual(await fs.readFile(copy.filePath), Buffer.from(bytes)); copies.push(copy);
  }
  await deleteSessionMidiArtifacts(storage, state.activeSessionId); await runtime.close();
  assert.deepEqual(await fs.readFile(copies[0]!.filePath), Buffer.from(midiBytes));
  await copies[1]!.discard(); await assert.rejects(fs.stat(copies[1]!.filePath));
});

test("native drag checks project ownership and Set identity and keeps copy failures path-free", async t => {
  const { storage, runtime, state, song } = await fixture(t);
  const midi = await saveMidiArtifact(storage, state.activeSessionId, { pluginId: "fixture", serverId: "fixture", toolName: "phrase", label: "Phrase",
    bytes: writeStandardMidi({ durationBeats: 4, tracks: [{ name: "Lead", channel: 1, notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 80 }] }] }), signal: new AbortController().signal });
  const foreign = await createSession(storage, { projectKey: "other-set", title: "Other", scope: { kind: "object", identity: "other", label: "Other" } });
  const input: NativeDragInput = { sessionId: state.activeSessionId, artifact: { kind: "midi", id: midi.id } };
  await assert.rejects(runtime.prepareArtifactExport({ ...input, sessionId: foreign.id }, new AbortController().signal));
  await assert.rejects(fs.stat(path.join(storage, "live-smith-exports")));
  await fs.writeFile(path.join(storage, "live-smith-exports"), "occupied");
  await assert.rejects(runtime.prepareArtifactExport(input, new AbortController().signal), error => {
    assert.equal(String(error).includes(storage), false); assert.equal((error as Error).cause, undefined); return true;
  });
  song.handle.id = 2n;
  await assert.rejects(runtime.prepareArtifactExport(input, new AbortController().signal), /Live Set changed/);
});
