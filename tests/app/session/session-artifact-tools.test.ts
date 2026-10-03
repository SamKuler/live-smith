import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";

import { createSessionArtifactToolset } from "../../../src/app/session/session-artifact-tools.js";
import { listSessionArtifacts, selectSessionArtifact } from "../../../src/app/session/session-artifacts.js";
import { readSessionAudioArtifact, savePluginAudioArtifact } from "../../../src/storage/audio-artifacts.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import { saveMidiArtifact } from "../../../src/storage/midi-artifacts.js";
import { createSession } from "../../../src/storage/sessions.js";
import { midiBytes, noteTrack } from "../../attachments/support/midi-test-helpers.js";
import { audioStorageHarness, generationJobCases, waveBytes } from "../../storage/support/audio-storage-test-helpers.js";

test("shared artifact reads recover saved Plugin audio without a confirmed tool result and preserve exact defaults", async (t) => {
  const h = await audioStorageHarness(t, generationJobCases[0]!.input);
  const save = (revisionOf?: string) => savePluginAudioArtifact(h.storage, h.session.id, {
    connectionId: "renderer", serverId: "local", toolName: "render", label: "Rendered theme", format: "wav", bytes: waveBytes(),
    signal: h.signal, ...(revisionOf ? { revisionOf: { kind: "audio" as const, id: revisionOf } } : {}),
  });
  const first = await save(); const revision = await save(first.id);
  const builtIn = await h.saveResult("music");
  const host = await saveMidiArtifact(h.storage, h.session.id, { source: { kind: "host", operation: "midi-conditioning-context" },
    serverId: "host", toolName: "observe", label: "Conditioning", bytes: midiBytes({ tracks: [noteTrack()] }), signal: h.signal });
  assert.deepEqual(await loadSessionEvents(h.storage, h.session.id), [], "recovery does not rely on a tool result event");
  const input = { storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal };
  const read = () => createSessionArtifactToolset(input).callTool({ id: "recover", name: "list_session_artifacts", arguments: "{}" });
  const initial = JSON.parse((await read()).content);
  assert.deepEqual(new Set(initial.map((entry: { artifactRef: string }) => entry.artifactRef)), new Set([first.id, revision.id, builtIn.id, host.id]));
  assert.equal(initial.find((entry: { artifactRef: string }) => entry.artifactRef === revision.id).defaultForWork, true);
  assert.equal(initial.find((entry: { artifactRef: string }) => entry.artifactRef === first.id).defaultForWork, false);
  assert.deepEqual(initial.find((entry: { artifactRef: string }) => entry.artifactRef === host.id).parts,
    [{ id: "track-0-channel-1", sourceTrackIndex: 0, channel: 1, durationBeats: 1, noteCount: 1 }]);
  assert.doesNotMatch(JSON.stringify(initial), /sha256|connectionId|serverId|toolName|storageDirectory|jobId|\/private\//);
  assert.equal((await listSessionArtifacts(input)).artifacts.some((entry) => entry.ref.id === host.id), false);
  const ref = { kind: "audio" as const, id: first.id };
  await selectSessionArtifact({ ...input, selection: { action: "primary", group: ref, candidate: ref } });
  const selected = JSON.parse((await read()).content);
  assert.deepEqual(selected.find((entry: { artifactRef: string }) => entry.artifactRef === revision.id).primary, ref);
  assert.equal(selected.find((entry: { artifactRef: string }) => entry.artifactRef === first.id).defaultForWork, true);
  assert.equal(selected.find((entry: { artifactRef: string }) => entry.artifactRef === revision.id).defaultForWork, false);
  assert.deepEqual(new Set(selected.filter((entry: { defaultForWork: boolean }) => entry.defaultForWork)
    .map((entry: { artifactRef: string }) => entry.artifactRef)), new Set([first.id, builtIn.id, host.id]));
  const other = await createSession(h.storage, { title: "Other", projectKey: "test-project", scope: { kind: "selection", identity: "other", label: "Other" } });
  assert.deepEqual(JSON.parse((await createSessionArtifactToolset({ ...input, sessionId: other.id }).callTool({ id: "other", name: "list_session_artifacts", arguments: "{}" })).content), []);
});

test("listing audio reads metadata and leaves byte integrity validation at the consumption boundary", async (t) => {
  const h = await audioStorageHarness(t);
  const saved = await savePluginAudioArtifact(h.storage, h.session.id, { pluginId: "renderer", serverId: "local", toolName: "render",
    label: "Saved audio", format: "wav", bytes: waveBytes(), signal: h.signal });
  await fs.writeFile(path.join(h.storage, "live-smith-audio-artifacts", h.session.id, `${saved.id}.audio`), new Uint8Array(saved.byteLength));
  const listed = await createSessionArtifactToolset({ storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal })
    .callTool({ id: "list", name: "list_session_artifacts", arguments: "{}" });
  assert.equal(listed.failed, undefined);
  assert.equal(JSON.parse(listed.content)[0].artifactRef, saved.id);
  await assert.rejects(readSessionAudioArtifact(h.storage, h.session.id, saved.id, h.signal));
});
