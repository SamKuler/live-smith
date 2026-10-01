import assert from "node:assert/strict";
import test from "node:test";
import { retrievalHarness, connection, clipIds, fixtureToken } from "./support/audio-retrieval-test-helpers.js";
import { loadAudioParameterGroups, runAudioParameterTool } from "../../../src/app/audio/audio-parameter-tool.js";
import { appendSessionEvent, loadSessionEvents } from "../../../src/storage/events.js";
import { retrieveMusic } from "../../../src/app/audio/audio-generation.js";
import { captureIntegrationConnections, integrationConnectionFingerprint } from "../../../src/app/plugins/integration-connections.js";
import { saveIntegrationConnection } from "../plugins/support/integration-connection-test-helpers.js";
import { waveBytes } from "../../storage/support/audio-storage-test-helpers.js";

const authorize = async <T>(_signal: AbortSignal, operation: () => Promise<T>): Promise<T> => operation();
const currentClip = "cccccccc-3333-4333-8333-333333333333";
const persona = "dddddddd-4444-4444-8444-444444444444";
const legacyClip = "eeeeeeee-5555-4555-8555-555555555555";
const queryName = "builtin_suno_inspect_music_service";
const lyricName = "builtin_suno_inspect_lyric_models";

test("host suggestions bind jobs and query provenance to the current account and configuration", async (t) => {
  const h = await retrievalHarness(t);
  await retrieveMusic(h.context, connection.id, [clipIds[0]!]);
  const beforeConnection = (await captureIntegrationConnections(h.directory))[0]!;
  const panel = async (suffix: string) => (await loadAudioParameterGroups(h.directory, h.session.id)).groups
    .flatMap((group) => group.tools).find((tool) => tool.name.endsWith(suffix))!.audioPanel!;
  const addResult = (value: Record<string, unknown>, name = queryName) => appendSessionEvent(h.directory, h.session.id, {
    kind: "tool_result", name, content: JSON.stringify(value),
  });
  const provenance = { connectionId: connection.id, accountId: "user_fixture" };
  await addResult({ query: "library", clips: [{ id: legacyClip, title: "Legacy without provenance" }] });
  await addResult({ query: "library", provenance, clips: [{ id: clipIds[1], title: "Current A library" }] });
  await addResult({ query: "catalog", provenance, models: [{ id: "music-a", name: "Music A", canUse: true }], remasterModels: [
    { id: "remaster-a", name: "🎵".repeat(160), canUse: true }, { id: "disabled-a", canUse: false }, { id: "unknown-a" },
  ] });
  await addResult({ query: "persona", provenance, persona: { id: persona, name: "Persona A" } });
  await addResult({ query: "lyric_models", provenance, models: [{ id: "lyric-a", name: "Lyric A" }] }, lyricName);
  assert.deepEqual((await panel("cover_music")).suggestions?.clips?.map((entry) => entry.id), clipIds);
  assert.deepEqual((await panel("remaster_music")).suggestions?.models?.map((entry) => entry.id), ["remaster-a"]);
  assert.equal(Array.from((await panel("remaster_music")).suggestions!.models![0]!.label).length, 160);
  assert.deepEqual((await panel("generate_music")).suggestions?.personas?.map((entry) => entry.id), [persona]);
  assert.deepEqual((await panel("write_lyrics")).suggestions?.models?.map((entry) => entry.id), ["lyric-a"]);
  const originalSignature = (await panel("cover_music")).signature;
  await h.sessions.save(connection.id, { accountId: "user_other", clientToken: fixtureToken("other") });
  const switched = await panel("cover_music");
  assert.notEqual(switched.signature, originalSignature);
  assert.deepEqual(switched.suggestions?.clips, []);
  assert.deepEqual((await panel("remaster_music")).suggestions?.models, []);
  assert.deepEqual((await panel("generate_music")).suggestions?.personas, []);
  assert.deepEqual((await panel("write_lyrics")).suggestions?.models, []);
  await addResult({ query: "library", provenance: { connectionId: connection.id, accountId: "user_other" }, clips: [{ id: currentClip, title: "Current B" }] });
  assert.deepEqual((await panel("cover_music")).suggestions?.clips?.map((entry) => entry.id), [currentClip]);
  const signature = (await panel("cover_music")).signature;
  await h.sessions.save(connection.id, { accountId: "user_other", clientToken: fixtureToken("rotated") });
  assert.equal((await panel("cover_music")).signature, signature);
  const serialized = JSON.stringify((await loadAudioParameterGroups(h.directory, h.session.id)).groups);
  assert.ok(!serialized.includes(integrationConnectionFingerprint(beforeConnection)));
  assert.ok(!serialized.includes(fixtureToken("other")));
  assert.ok(!serialized.includes(fixtureToken("rotated")));
  await saveIntegrationConnection(h.directory, "1", { ...connection, modelId: "new-model" });
  assert.deepEqual((await panel("cover_music")).suggestions?.clips, []);
});

test("host-authored query provenance overrides provider fields and restores observations after reopening", async (t) => {
  const h = await retrievalHarness(t);
  const panel = async (suffix: string) => (await loadAudioParameterGroups(h.directory, h.session.id)).groups
    .flatMap((group) => group.tools).find((tool) => tool.name.endsWith(suffix))!.audioPanel!;
  const input = { context: {} as never, storageDirectory: h.directory, sessionId: h.session.id, target: {},
    signal: h.controller.signal, onProgress() {}, onAssets() {}, withAdmissionAuthorization: authorize, withGenerationAuthorization: authorize };
  const query = await panel("inspect_music_service");
  await runAudioParameterTool({ ...input, toolName: query.toolName, signature: query.signature,
    arguments: { connectionId: connection.id, query: "library" }, processing: {
      musicServiceReader: async () => ({ query: "library" as const, hasMore: false, clips: [{ id: currentClip, title: "Current clip", status: "complete", modelId: "model", styles: "" }],
        provenance: { connectionId: "wrong", accountId: "wrong" } }),
    },
  });
  const event = (await loadSessionEvents(h.directory, h.session.id)).at(-1)!;
  assert.deepEqual(JSON.parse(event.content).provenance, { connectionId: connection.id, accountId: "user_fixture" });
  const current = await panel("extend_music");
  assert.deepEqual(current.suggestions?.clips?.map((entry) => entry.id), [currentClip]);
  let submissions = 0;
  const processing = { generationAdapter: { provider: "suno" as const, submit: async () => {
    submissions++; return { kind: "audio" as const, outputs: [{ role: "music" as const, bytes: waveBytes() }] };
  } } };
  // Each invocation constructs a fresh runtime without an in-memory observation map.
  const args = { connectionId: connection.id, clipId: currentClip, startSeconds: 1, prompt: "New verse", instrumental: false };
  assert.deepEqual(await runAudioParameterTool({ ...input, toolName: current.toolName, signature: current.signature, arguments: args, processing }), { failed: false });
  await h.sessions.save(connection.id, { accountId: "user_other", clientToken: fixtureToken("other") });
  const other = await panel("extend_music");
  assert.deepEqual(await runAudioParameterTool({ ...input, toolName: other.toolName, signature: other.signature, arguments: args, processing }), { failed: true });
  assert.equal(submissions, 1);
});
