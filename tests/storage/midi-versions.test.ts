import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { createSession } from "../../src/storage/sessions.js";
import { inspectMidiArtifacts, midiArtifactVersion, readMidiArtifact, saveMidiArtifact } from "../../src/storage/midi-artifacts.js";
import { midiBytes, noteTrack } from "../attachments/support/midi-test-helpers.js";
import { createHostAbortController } from "../../src/runtime/host.js";

async function setup(t: { after(fn: () => Promise<unknown>): void }) {
  const directory = await fs.mkdtemp('/private/tmp/live-smith-midi-versions-');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: 'Verse', projectKey: 'project', scope: { kind: 'selection', identity: 'selected', label: 'Verse' } });
  const save = (revisionOf?: string, pitch = 60, sessionId = session.id) => saveMidiArtifact(directory, sessionId, {
    connectionId: 'generator', serverId: 'midi', toolName: 'generate_midi', label: 'Verse piano',
    bytes: midiBytes({ tracks: [noteTrack({ pitch })] }), signal: createHostAbortController().signal,
    ...(revisionOf ? { revisionOf } : {}),
  });
  return { directory, session, save };
}

test('MIDI versions keep immutable bytes, monotonic numbers and the chosen parent across branches and reloads', async(t) => {
  const h = await setup(t);
  const first = await h.save();
  const original = (await readMidiArtifact(h.directory, h.session.id, first.id)).bytes;
  assert.deepEqual(midiArtifactVersion(first), { groupId: first.id, number: 1 });
  const [second, third] = await Promise.all([h.save(first.id, 64), h.save(first.id, 67)]);
  assert.deepEqual([second.version!.number, third.version!.number].sort(), [2, 3]);
  const fourth = await h.save(second.id, 69);
  assert.deepEqual(fourth.version, { groupId: first.id, number: 4, derivedFromId: second.id });
  second.version!.number = 999;
  const reloaded = await inspectMidiArtifacts(h.directory, h.session.id);
  assert.deepEqual(reloaded.artifacts.map(a => midiArtifactVersion(a).number).sort(), [1, 2, 3, 4]);
  assert.deepEqual((await readMidiArtifact(h.directory, h.session.id, first.id)).bytes, original);
  assert.equal((await readMidiArtifact(h.directory, h.session.id, fourth.id)).parsed.notes[0]!.pitch, 69);
  assert.deepEqual(Object.keys(reloaded).sort(), ['artifacts', 'unavailableCount']);
});

test('unavailable version blobs retain their number and another Session cannot become a version source', async(t) => {
  const h = await setup(t); const first = await h.save(); const second = await h.save(first.id, 64);
  await fs.unlink(path.join(h.directory, 'live-smith-midi', h.session.id, `${second.id}.mid`));
  const third = await h.save(first.id, 67);
  assert.equal(third.version!.number, 3);
  assert.equal((await inspectMidiArtifacts(h.directory, h.session.id)).unavailableCount, 1);
  await assert.rejects(h.save(second.id), /source MIDI version is unavailable/);
  const other = await createSession(h.directory, { title: 'Other', projectKey: 'project', scope: { kind: 'selection', identity: 'other', label: 'Other' } });
  await assert.rejects(h.save(first.id, 60, other.id), /source MIDI version is unavailable/);
  assert.equal((await inspectMidiArtifacts(h.directory, other.id)).artifacts.length, 0);
});

test('legacy MIDI metadata starts at v1 without rewriting it when a new version is saved', async(t) => {
  const h = await setup(t); const first = await h.save();
  const metadataPath = path.join(h.directory, 'live-smith-midi', h.session.id, `${first.id}.midi.json`);
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')); delete metadata.version;
  const legacy = JSON.stringify(metadata); await fs.writeFile(metadataPath, legacy);
  const old = (await readMidiArtifact(h.directory, h.session.id, first.id)).artifact;
  assert.deepEqual(midiArtifactVersion(old), { groupId: first.id, number: 1 });
  assert.equal((await h.save(first.id)).version!.number, 2);
  assert.equal(await fs.readFile(metadataPath, 'utf8'), legacy);
});
