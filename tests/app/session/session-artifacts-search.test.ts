import assert from "node:assert/strict";
import test from "node:test";
import { audioStorageHarness, waveBytes } from "../../storage/support/audio-storage-test-helpers.js";
import { midiBytes, noteTrack } from "../../attachments/support/midi-test-helpers.js";
import { saveMidiArtifact } from "../../../src/storage/midi-artifacts.js";
import { savePluginAudioArtifact } from "../../../src/storage/audio-artifacts.js";
import { createSession } from "../../../src/storage/sessions.js";
import { listSessionArtifacts, selectSessionArtifact } from "../../../src/app/session/session-artifacts.js";
import { isSessionArtifacts } from "../../../src/ui/client/wire-contracts/artifacts.js";

test("artifact search finds complete-catalog matches before paging and stays scoped to its Session", async (t) => {
  const h = await audioStorageHarness(t);
  const input = { storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal };
  const save = (label: string) => saveMidiArtifact(h.storage, h.session.id, {
    connectionId: "generator", serverId: "midi", toolName: "make", label,
    bytes: midiBytes({ tracks: [noteTrack()] }), signal: h.signal,
  });
  const oldest = await save("晨光 [Verse]");
  for (let index = 0; index < 26; index++) await save(`Other ${index}`);
  const all = await listSessionArtifacts(input);
  assert.equal(all.total, 27);
  assert.equal(all.artifacts.some((entry) => entry.ref.id === oldest.id), false);
  for (const query of [" 晨光 ", "[vErSe]"]) {
    const found = await listSessionArtifacts({ ...input, query });
    assert.equal(found.query, query.trim());
    assert.equal(found.total, 1);
    assert.deepEqual(found.artifacts.map((entry) => entry.ref.id), [oldest.id]);
    assert.equal(isSessionArtifacts(found), true);
  }
  assert.equal((await listSessionArtifacts({ ...input, query: ".*" })).total, 0);
  const sources = await listSessionArtifacts({ ...input, query: "PLUGIN-GENERATED", offset: 24 });
  assert.equal(sources.total, 27); assert.equal(sources.artifacts.length, 3);
  assert.deepEqual(await listSessionArtifacts({ ...input, query: " \t " }), all);
  const other = await createSession(h.storage, { title: "Other", projectKey: "test-project", scope: { kind: "selection", identity: "other", label: "Other" } });
  assert.equal((await listSessionArtifacts({ ...input, sessionId: other.id, query: "晨光" })).total, 0);
});

test("a matching older version overrides a nonmatching primary while retaining full work metadata", async (t) => {
  const h = await audioStorageHarness(t);
  const input = { storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal };
  const save = (label: string, pitch: number, revisionOf?: string) => saveMidiArtifact(h.storage, h.session.id, {
    connectionId: "generator", serverId: "midi", toolName: "make", label, signal: h.signal,
    bytes: midiBytes({ tracks: [noteTrack({ pitch })] }), ...(revisionOf ? { revisionOf } : {}),
  });
  const first = await save("Theme", 60);
  const matching = await save("琶音 sketch", 64, first.id);
  const latest = await save("Final", 67, matching.id);
  const primary = { kind: "midi" as const, id: latest.id };
  await selectSessionArtifact({ ...input, selection: { action: "primary", group: { kind: "midi", id: first.id }, candidate: primary } });
  assert.equal((await listSessionArtifacts(input)).artifacts[0]!.ref.id, latest.id);
  for (const query of ["琶音", " V2 "]) {
    const result = await listSessionArtifacts({ ...input, query });
    assert.equal(result.total, 1);
    const artifact = result.artifacts[0]!;
    assert.equal(artifact.ref.id, matching.id); assert.equal(artifact.midi!.notes[0]!.pitch, 64);
    assert.equal(artifact.version!.groupLabel, "Theme"); assert.deepEqual(artifact.primary, primary);
    assert.deepEqual(artifact.versions!.map((entry) => entry.id), [first.id, matching.id, latest.id]);
  }
  assert.equal((await listSessionArtifacts({ ...input, query: "Theme" })).artifacts[0]!.ref.id, first.id,
    "The original version's own name takes precedence over the shared group label on a differently named primary");
  assert.equal((await listSessionArtifacts({ ...input, query: "Plugin-generated" })).artifacts[0]!.ref.id, latest.id,
    "When all versions match the same source, the saved primary remains the default");
});

test("artifact wire search identity accepts only normalized bounded nonblank queries", () => {
  const page = { sessionId: "session-1", artifacts: [], total: 0, offset: 0, unavailableCount: 0 };
  assert.equal(isSessionArtifacts(page), true);
  assert.equal(isSessionArtifacts({ ...page, query: "晨光" }), true);
  for (const query of [1, null, "", " ", " word ", "x".repeat(201)]) assert.equal(isSessionArtifacts({ ...page, query }), false);
});

test("source search accepts supported UI translations without translating authored artifact names", async (t) => {
  const h = await audioStorageHarness(t);
  const input = { storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal };
  const midi = await saveMidiArtifact(h.storage, h.session.id, { connectionId: "generator", serverId: "midi", toolName: "make",
    label: "Prelude", bytes: midiBytes({ tracks: [noteTrack()] }), signal: h.signal });
  const audio = await savePluginAudioArtifact(h.storage, h.session.id, { connectionId: "generator", serverId: "audio", toolName: "make",
    label: "Texture", bytes: waveBytes(), format: "wav", signal: h.signal });
  const model = await saveMidiArtifact(h.storage, h.session.id, { source: { kind: "model", profileId: "profile-1", model: "model-1" },
    serverId: "model", toolName: "make", label: "Primary", bytes: midiBytes({ tracks: [noteTrack()] }), signal: h.signal });
  for (const query of ["插件生成", "PLUGIN-GENERATED"]) {
    const result = await listSessionArtifacts({ ...input, query });
    assert.deepEqual(new Set(result.artifacts.map((artifact) => artifact.ref.id)), new Set([midi.id, audio.id]));
  }
  assert.deepEqual((await listSessionArtifacts({ ...input, query: "插件生成的音频" })).artifacts.map((artifact) => artifact.ref.id), [audio.id]);
  assert.deepEqual((await listSessionArtifacts({ ...input, query: "AI 生成" })).artifacts.map((artifact) => artifact.ref.id), [model.id]);
  assert.equal((await listSessionArtifacts({ ...input, query: "主版本" })).total, 0);
  assert.equal((await listSessionArtifacts({ ...input, query: "Primary" })).artifacts[0]!.label, "Primary");
});
