import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";

import { MAX_AUDIO_ASSET_BYTES } from "../../src/audio-services/contracts.js";
import { createHostAbortController } from "../../src/runtime/host.js";
import {
  AudioArtifactNotFoundError, deleteSessionPluginAudioArtifacts, listPluginAudioArtifactRecords, listPluginAudioArtifacts,
  listSessionPluginAudioDirectoryIds, readExpectedSessionAudioArtifact, readPluginAudioArtifact,
  readSessionAudioArtifact, savePluginAudioArtifact,
} from "../../src/storage/audio-artifacts.js";
import { assertAudioOutputCapacity } from "../../src/storage/audio-assets.js";
import { listAudioJobs } from "../../src/storage/audio-jobs.js";
import { saveMidiArtifact } from "../../src/storage/midi-artifacts.js";
import { createSession } from "../../src/storage/sessions.js";
import { audioStorageHarness, mp3Bytes, sessionInput, waveBytes } from "./support/audio-storage-test-helpers.js";
import { midiBytes, noteTrack } from "../attachments/support/midi-test-helpers.js";

const source = { pluginId: "local-renderer", serverId: "local", toolName: "render", label: "Rendered take" };
const directory = (storage: string, sessionId: string) => path.join(storage, "live-smith-audio-artifacts", sessionId);

test("standalone Plugin WAV and MP3 results retain immutable bytes and exact Session ownership without jobs", async (t) => {
  const h = await audioStorageHarness(t);
  const initialJobs = await listAudioJobs(h.storage, h.session.id);
  for (const format of ["wav", "mp3"] as const) {
    const bytes = format === "wav" ? waveBytes() : mp3Bytes();
    const original = new Uint8Array(bytes);
    const saved = await savePluginAudioArtifact(h.storage, h.session.id, { ...source, bytes, format, signal: h.signal });
    bytes.fill(0);
    assert.match(saved.id, /^audio_artifact_/);
    assert.equal(saved.mediaType, format === "wav" ? "audio/wav" : "audio/mpeg");
    assert.deepEqual(saved.version, { groupId: saved.id, number: 1 });
    assert.equal(Object.hasOwn(saved, "jobId"), false);
    const read = await readPluginAudioArtifact(h.storage, h.session.id, saved.id, h.signal);
    assert.deepEqual(read.bytes, original);
    assert.deepEqual(read.artifact, saved);
    assert.deepEqual((await readSessionAudioArtifact(h.storage, h.session.id, saved.id, h.signal)).asset, saved);
    assert.deepEqual(await readExpectedSessionAudioArtifact(h.storage, h.session.id, saved, h.signal), original);
    await assert.rejects(readExpectedSessionAudioArtifact(h.storage, h.session.id, { ...saved, label: "changed" }, h.signal));
    const other = await createSession(h.storage, sessionInput);
    await assert.rejects(readPluginAudioArtifact(h.storage, other.id, saved.id));
  }
  assert.equal((await listPluginAudioArtifacts(h.storage, h.session.id)).length, 2);
  assert.deepEqual(await listAudioJobs(h.storage, h.session.id), initialJobs);
  assert.deepEqual(await listSessionPluginAudioDirectoryIds(h.storage), [h.session.id]);
  await deleteSessionPluginAudioArtifacts(h.storage, h.session.id);
  assert.deepEqual(await listPluginAudioArtifacts(h.storage, h.session.id), []);
});

test("Plugin audio inspection rejects mismatched formats, invalid bytes, cancellation and corruption", async (t) => {
  const h = await audioStorageHarness(t);
  const save = (bytes: Uint8Array, format: "wav" | "mp3", signal = h.signal) =>
    savePluginAudioArtifact(h.storage, h.session.id, { ...source, bytes, format, signal });
  await assert.rejects(save(mp3Bytes(), "wav"), /declared format/);
  await assert.rejects(save(waveBytes(), "mp3"), /declared format/);
  await assert.rejects(save(new Uint8Array([1, 2, 3]), "wav"));
  const controller = createHostAbortController(); controller.abort(new Error("stop"));
  await assert.rejects(save(waveBytes(), "wav", controller.signal), /stop/);
  assert.deepEqual(await listPluginAudioArtifacts(h.storage, h.session.id), []);
  const saved = await save(waveBytes(), "wav");
  const blob = path.join(directory(h.storage, h.session.id), `${saved.id}.audio`);
  const changed = waveBytes(); changed[changed.length - 1] = 1;
  await fs.writeFile(blob, changed);
  await assert.rejects(readPluginAudioArtifact(h.storage, h.session.id, saved.id));
  await fs.rm(blob); await fs.symlink(path.join(h.directory, "other.audio"), blob);
  await assert.rejects(readPluginAudioArtifact(h.storage, h.session.id, saved.id));
});

test("audio revisions join Plugin groups while MIDI provenance remains a separate audio work", async (t) => {
  const h = await audioStorageHarness(t);
  const save = (revisionOf?: { kind: "audio" | "midi"; id: string }) => savePluginAudioArtifact(h.storage, h.session.id,
    { ...source, bytes: waveBytes(), format: "wav", signal: h.signal, ...(revisionOf ? { revisionOf } : {}) });
  const first = await save();
  const second = await save({ kind: "audio", id: first.id });
  assert.deepEqual(second.version, { groupId: first.id, number: 2, derivedFromId: first.id });
  await fs.rm(path.join(directory(h.storage, h.session.id), `${second.id}.audio`));
  const third = await save({ kind: "audio", id: first.id });
  assert.equal(third.version.number, 3);
  assert.equal((await listPluginAudioArtifacts(h.storage, h.session.id)).length, 2);
  assert.equal((await listPluginAudioArtifactRecords(h.storage, h.session.id)).length, 3);
  const midi = await saveMidiArtifact(h.storage, h.session.id, { ...source, bytes: midiBytes({ tracks: [noteTrack()] }), signal: h.signal });
  const rendered = await save({ kind: "midi", id: midi.id });
  assert.deepEqual(rendered.version, { groupId: rendered.id, number: 1 });
  assert.deepEqual(rendered.sourceArtifact, { kind: "midi", id: midi.id });
  const stem = await h.saveResult("vocals");
  const processedStem = await save({ kind: "audio", id: stem.id });
  assert.deepEqual(processedStem.version, { groupId: processedStem.id, number: 1 });
  assert.deepEqual(processedStem.sourceArtifact, { kind: "audio", id: stem.id });
});

test("common audio reader rejects uncommitted job receipts and accepts exact committed output", async (t) => {
  const h = await audioStorageHarness(t);
  const receipt = await h.save("vocals");
  await assert.rejects(readSessionAudioArtifact(h.storage, h.session.id, receipt.id), AudioArtifactNotFoundError);
  const committed = await h.saveResult("vocals");
  const read = await readSessionAudioArtifact(h.storage, h.session.id, committed.id);
  assert.deepEqual(read.asset, committed); assert.deepEqual(read.bytes, waveBytes());
  const internalSource = await h.save("source");
  await assert.rejects(readSessionAudioArtifact(h.storage, h.session.id, internalSource.id), AudioArtifactNotFoundError);
});

test("Plugin and job audio share one byte budget including interrupted blobs", async (t) => {
  const h = await audioStorageHarness(t);
  const saved = await savePluginAudioArtifact(h.storage, h.session.id, { ...source, bytes: waveBytes(), format: "wav", signal: h.signal });
  for (let index = 0; index < 7; index++) {
    const handle = await fs.open(path.join(h.directory, `asset_orphan_${index}.audio`), "wx");
    await handle.truncate(MAX_AUDIO_ASSET_BYTES); await handle.close();
  }
  await assert.rejects(assertAudioOutputCapacity(h.storage, h.session.id, 1), /storage limit/);
  const partial = path.join(directory(h.storage, h.session.id), `.audio_artifact_interrupted.audio.tmp_pending`);
  const handle = await fs.open(partial, "wx"); await handle.truncate(MAX_AUDIO_ASSET_BYTES - saved.byteLength); await handle.close();
  await assert.rejects(savePluginAudioArtifact(h.storage, h.session.id, { ...source, bytes: waveBytes(), format: "wav", signal: h.signal }), /storage limit/);
  await assert.rejects(h.save("vocals"), /storage limit/);
  assert.deepEqual((await listPluginAudioArtifacts(h.storage, h.session.id)).map((entry) => entry.id), [saved.id]);
});

test("Plugin audio storage refuses symlinked roots before writing bytes", async (t) => {
  const h = await audioStorageHarness(t);
  const before = await fs.readdir(h.directory);
  await fs.symlink(h.directory, path.join(h.storage, "live-smith-audio-artifacts"));
  await assert.rejects(savePluginAudioArtifact(h.storage, h.session.id, { ...source, bytes: waveBytes(), format: "wav", signal: h.signal }));
  assert.deepEqual(await fs.readdir(h.directory), before);
});
