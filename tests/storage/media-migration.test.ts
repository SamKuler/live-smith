import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { deleteSessionAttachments, listSessionAttachments, readSessionAttachmentBytes, saveSessionAttachment } from "../../src/storage/attachments.js";
import { listStoredEntries, readStoredBytes, removeStoredEntry } from "../../src/storage/sqlite.js";
import { audioStorageHarness, waveBytes } from "./support/audio-storage-test-helpers.js";
import { deleteSessionAudio, listAudioAssets, readAudioAsset, saveAudioAsset } from "../../src/storage/audio-assets.js";
import { loadAudioJob, updateAudioJob } from "../../src/storage/audio-jobs.js";
import { deleteSessionPluginAudioArtifacts, readPluginAudioArtifact, savePluginAudioArtifact } from "../../src/storage/audio-artifacts.js";
import { deleteSessionMidiArtifacts, hasSessionMidiContent, readMidiArtifact, saveMidiArtifact } from "../../src/storage/midi-artifacts.js";
import { deleteSessionDeviceParameters, listDeviceParameterApplications, readDeviceParameterArtifact, saveDeviceParameterApplication, saveDeviceParameterArtifact, saveDeviceParameterProgress } from "../../src/storage/device-parameter-artifacts.js";
import { captureParameterDevice } from "../../src/live/device-parameters.js";
import { deviceParameterFixture } from "../live/support/device-parameter-fixture.js";
import { midiBytes, noteTrack } from "../attachments/support/midi-test-helpers.js";

test("legacy attachments remain frozen while imported records are deleted and recreated", async t => {
  const storage = await mkdtemp("/private/tmp/live-smith-media-migration-");
  t.after(() => rm(storage, { recursive: true, force: true }));
  const bytes = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]);
  const sessionId = "legacy_session";
  const metadata = await saveSessionAttachment(undefined, sessionId, { fileName: "old.png", bytes }, { preSavePendingAttachmentRefs: [] });
  const directory = path.join(storage, "live-smith-attachments", sessionId);
  await mkdir(directory, { recursive: true });
  const original = JSON.stringify(metadata);
  await writeFile(path.join(directory, `${metadata.id}.json`), original);
  await writeFile(path.join(directory, `${metadata.id}.bin`), bytes);
  assert.deepEqual(await listSessionAttachments(storage, sessionId), [metadata]);
  assert.deepEqual(await readSessionAttachmentBytes(storage, sessionId, metadata.id), bytes);
  await deleteSessionAttachments(storage, sessionId);
  assert.deepEqual(await listSessionAttachments(storage, sessionId), []);
  assert.equal(await readFile(path.join(directory, `${metadata.id}.json`), "utf8"), original);
  assert.deepEqual(new Uint8Array(await readFile(path.join(directory, `${metadata.id}.bin`))), bytes);
  const fresh = await saveSessionAttachment(storage, sessionId, { fileName: "new.png", bytes }, { preSavePendingAttachmentRefs: [] });
  assert.deepEqual(await listSessionAttachments(storage, sessionId), [fresh]);
});

test("relative and absolute storage directories address the same media records", async t => {
  const storage = await mkdtemp("/private/tmp/live-smith-media-relative-");
  t.after(() => rm(storage, { recursive: true, force: true }));
  const relative = path.relative(process.cwd(), storage);
  const bytes = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]);
  const saved = await saveSessionAttachment(relative, "relative_session", { fileName: "image.png", bytes }, { preSavePendingAttachmentRefs: [] });
  assert.deepEqual(await listSessionAttachments(storage, "relative_session"), [saved]);
  assert.deepEqual(await readSessionAttachmentBytes(storage, "relative_session", saved.id), bytes);
});

test("legacy audio, MIDI and parameter journals migrate together and leave every original frozen", async t => {
  const h = await audioStorageHarness(t);
  const asset = await h.saveResult("vocals");
  const source = { pluginId: "local-renderer", serverId: "local", toolName: "render", label: "Take" };
  const midi = await saveMidiArtifact(h.storage, h.session.id, { ...source, bytes: midiBytes({ tracks: [noteTrack()] }), signal: h.signal });
  const audio = await savePluginAudioArtifact(h.storage, h.session.id, { ...source, bytes: waveBytes(), format: "wav", signal: h.signal });
  const fixture = deviceParameterFixture();
  const snapshot = await captureParameterDevice(fixture.context, fixture.target);
  const parameters = await saveDeviceParameterArtifact(h.storage, h.session.id, { ...snapshot, label: "Synth", source: { kind: "captured" }, signal: h.signal });
  const application = { id: "parameter_apply_migration", sessionId: h.session.id, artifactId: parameters.id,
    artifactLabel: parameters.label, artifactVersion: parameters.version.number, createdAt: new Date().toISOString(), target: snapshot.target,
    status: "applying" as const, entries: snapshot.parameters.map(parameter => ({ parameter, requested: 0.8, state: "pending" as const })) };
  await saveDeviceParameterApplication(h.storage, application);
  await saveDeviceParameterProgress(h.storage, h.session.id, application.id, { index: 1, state: "applying" });
  const storage = await mkdtemp("/private/tmp/live-smith-media-legacy-all-");
  t.after(() => rm(storage, { recursive: true, force: true }));
  const originals = new Map<string, Uint8Array>();
  for (const entry of await listStoredEntries(h.storage)) {
    const bytes = await readStoredBytes(h.storage, entry.key);
    const target = path.join(storage, entry.key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    originals.set(target, bytes);
  }
  const continuation = path.join(storage, "live-smith-midi", h.session.id, "continuation.json");
  await writeFile(continuation, "{}"); originals.set(continuation, new TextEncoder().encode("{}"));
  const initialJob = await loadAudioJob(h.storage, h.session.id, h.job.id);
  assert.deepEqual(await loadAudioJob(storage, h.session.id, h.job.id), initialJob);
  assert.deepEqual((await readAudioAsset(storage, h.session.id, asset.id)).bytes, waveBytes());
  assert.deepEqual((await readPluginAudioArtifact(storage, h.session.id, audio.id)).artifact, audio);
  assert.deepEqual((await readMidiArtifact(storage, h.session.id, midi.id)).artifact, midi);
  assert.equal(await hasSessionMidiContent(storage, h.session.id), true);
  assert.deepEqual(await readDeviceParameterArtifact(storage, h.session.id, parameters.id), parameters);
  assert.equal((await listDeviceParameterApplications(storage, h.session.id))[0]!.entries[1]!.state, "applying");
  await updateAudioJob(storage, h.session.id, h.job.id, { status: "partial" });
  await saveDeviceParameterProgress(storage, h.session.id, application.id, { index: 1, state: "applied", after: 0.8 });
  await removeStoredEntry(storage, path.join("live-smith-audio", h.session.id, `${asset.id}.audio`));
  assert.deepEqual(await listAudioAssets(storage, h.session.id), []);
  const recovered = await saveAudioAsset(storage, h.session.id, { jobId: h.job.id, role: asset.role, label: asset.label,
    bytes: waveBytes(), origin: asset.origin, signal: h.signal });
  assert.deepEqual(recovered, asset);
  await deleteSessionAudio(storage, h.session.id);
  await deleteSessionPluginAudioArtifacts(storage, h.session.id);
  await deleteSessionMidiArtifacts(storage, h.session.id);
  await deleteSessionDeviceParameters(storage, h.session.id);
  for (const [target, bytes] of originals) assert.deepEqual(new Uint8Array(await readFile(target)), new Uint8Array(bytes));
  assert.equal(await hasSessionMidiContent(storage, h.session.id), false);
  assert.deepEqual(await listDeviceParameterApplications(storage, h.session.id), []);
});
