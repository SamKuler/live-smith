import assert from "node:assert/strict";
import test from "node:test";
import { retrievalHarness, connection, clipIds, fixtureToken } from "./audio-retrieval-test-helpers.js";
import { loadAudioParameterGroups, runAudioParameterTool } from "./audio-parameter-tool.js";
import { createSession } from "../storage/sessions.js";
import { loadSessionEvents } from "../storage/events.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import type { AudioGenerationRequest } from "../audio-services/contracts.js";
import { saveIntegrationConnection } from "./integration-connection-test-helpers.js";

const authorize = async <T>(_signal: AbortSignal, operation: () => Promise<T>): Promise<T> => operation();

test("manual music observations survive separate calls but remain bound to Session, connection configuration and account", async (t) => {
  const h = await retrievalHarness(t);
  const observedMusicClips = new Map<string, Set<string>>();
  const submitted: AudioGenerationRequest[] = [];
  const input = { context: {} as never, storageDirectory: h.directory, sessionId: h.session.id, target: {},
    signal: h.controller.signal, observedMusicClips, onProgress() {}, onAssets() {},
    withAdmissionAuthorization: authorize, withGenerationAuthorization: authorize,
    processing: {
      musicServiceReader: async () => ({ query: "library" as const, hasMore: false,
        clips: [{ id: clipIds[0]!, title: "Library clip", status: "complete", modelId: "fixture-model", styles: "piano" }] }),
      generationAdapter: { provider: "suno" as const, submit: async (request: AudioGenerationRequest) => {
        submitted.push(request); return { kind: "audio" as const, outputs: [{ role: "music" as const, bytes: waveBytes() }] };
      } },
    },
  };
  const panel = async (suffix: string) => {
    const { groups } = await loadAudioParameterGroups(h.directory, h.session.id);
    return groups.flatMap((group) => group.tools).find((tool) => tool.name.endsWith(suffix))!.audioPanel!;
  };
  const run = async (suffix: string, args: Record<string, unknown>, observations = observedMusicClips) => {
    const descriptor = await panel(suffix);
    return runAudioParameterTool({ ...input, observedMusicClips: observations,
      toolName: descriptor.toolName, signature: descriptor.signature, arguments: args });
  };
  const extend = { connectionId: connection.id, clipId: clipIds[0], startSeconds: 10, prompt: "", instrumental: true };
  assert.deepEqual(await run("extend_music", extend), { failed: true });
  assert.equal(submitted.length, 0);
  assert.deepEqual(await run("inspect_music_service", { connectionId: connection.id, query: "library" }), { failed: false });
  const before = await panel("extend_music");
  await saveIntegrationConnection(h.directory, "1", { ...connection, modelId: "chirp-crow" });
  assert.notEqual((await panel("extend_music")).signature, before.signature);
  assert.deepEqual(await run("extend_music", extend), { failed: true }, "changed connection configuration needs fresh library evidence");
  await saveIntegrationConnection(h.directory, "2", connection);
  await h.sessions.save(connection.id, { accountId: "user_fixture", clientToken: fixtureToken("rotated") });
  assert.equal((await panel("extend_music")).signature, before.signature);
  const otherSession = await createSession(h.directory, { title: "Other Session", projectKey: "fixture",
    scope: { kind: "selection", identity: "other-selection", label: "Other audio" } });
  const otherCatalog = await loadAudioParameterGroups(h.directory, otherSession.id);
  const otherPanel = otherCatalog.groups.flatMap((group) => group.tools).find((tool) => tool.name.endsWith("extend_music"))!.audioPanel!;
  assert.deepEqual(await runAudioParameterTool({ ...input, sessionId: otherSession.id, observedMusicClips: new Map(),
    toolName: otherPanel.toolName, signature: otherPanel.signature, arguments: extend }), { failed: true }, "another Session cannot reuse the original Session's query history");
  assert.equal(submitted.length, 0);
  assert.deepEqual(await run("extend_music", extend, new Map()), { failed: false }, "the same Session restores owner-bound observations after restart");
  assert.equal(submitted.length, 1);
  assert.deepEqual(await run("extend_music", extend), { failed: false });
  assert.equal(submitted.length, 2);

  await h.sessions.save(connection.id, { accountId: "user_other", clientToken: fixtureToken("other") });
  assert.notEqual((await panel("extend_music")).signature, before.signature);
  assert.deepEqual(await run("extend_music", extend), { failed: true });
  assert.equal(submitted.length, 2);
  assert.match((await loadSessionEvents(h.directory, h.session.id)).at(-1)!.content, /library or saved audio jobs first/);

});
