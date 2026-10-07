import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import test from "node:test";
import { SunoLyricsOutcomeUnknownError } from "../../../../src/audio-services/suno/suno-lyrics.js";
import { createSession } from "../../../../src/storage/sessions.js";
import { SunoSessions } from "../../../../src/storage/suno-sessions.js";
import { listAudioJobs } from "../../../../src/storage/audio-jobs.js";
import { loadSessionEvents } from "../../../../src/storage/events.js";
import { saveIntegrationConnection } from "../../plugins/support/integration-connection-test-helpers.js";
import { loadAudioParameterGroups, runAudioParameterTool } from "../../../../src/app/audio/audio-parameter-tool.js";
import { ChatBridgeCommandOutcomeUnknownError } from "../../../../src/app/chat/chat-bridge.js";

const authorize = async <T>(_signal: AbortSignal, operation: () => Promise<T>): Promise<T> => operation();
async function harness(t: { after(fn: () => Promise<void>): void }) {
  const storage = await fs.mkdtemp("/private/tmp/live-smith-suno-lyrics-");
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const session = await createSession(storage, { title: "Lyrics", projectKey: "project", scope: { kind: "selection", identity: "selection", label: "Audio" } });
  await saveIntegrationConnection(storage, "0", { id: "website", name: "Suno", provider: "suno", enabled: true, apiKey: "" });
  const token = ["{}", JSON.stringify({ fixture: true }), "signature"].map((part) => Buffer.from(part).toString("base64url")).join(".");
  await new SunoSessions(storage).save("website", { accountId: "user_fixture", clientToken: token });
  const catalog = await loadAudioParameterGroups(storage, session.id);
  const panel = catalog.groups.flatMap((group) => group.tools).find((tool) => tool.name.endsWith("write_lyrics"))!.audioPanel!;
  const input = { context: {} as never, storageDirectory: storage, sessionId: session.id, target: {},
    signal: new AbortController().signal, onProgress() {}, onAssets() {},
    withAdmissionAuthorization: authorize, withGenerationAuthorization: authorize,
    toolName: panel.toolName, signature: panel.signature, arguments: { connectionId: "website", selected: "", instruction: "Write a verse" } };
  return { storage, session, input };
}

test("manual lyric writing records confirmed text in history without creating an audio job", async (t) => {
  const h = await harness(t);
  let calls = 0, leases = 0;
  assert.deepEqual(await runAudioParameterTool({ assertLiveSetCurrent: () => {}, ...{ ...h.input,
    withGenerationAuthorization: async (signal, operation) => { leases++; return authorize(signal, operation); },
    processing: { pluginOverrides: { plugin: { writeLyrics: async (session, request) => {
      calls++; assert.equal(session.sunoSession!.accountId, "user_fixture"); assert.equal(request.selected, "");
      return { status: "completed", lyrics: "A new verse" };
    } } } },
  } }), { failed: false });
  assert.equal(calls, 1);
  assert.equal(leases, 1);
  assert.deepEqual(await listAudioJobs(h.storage, h.session.id), []);
  const events = await loadSessionEvents(h.storage, h.session.id);
  assert.deepEqual(events.map((event) => event.kind), ["tool_call", "tool_result"]);
  assert.deepEqual(JSON.parse(events[1]!.content), { status: "completed", lyrics: "A new verse" });
});

test("manual lyric writing records and reports an unknown outcome without an automatic retry", async (t) => {
  const h = await harness(t);
  let calls = 0;
  await assert.rejects(runAudioParameterTool({ assertLiveSetCurrent: () => {}, ...{ ...h.input, processing: { pluginOverrides: { plugin: { writeLyrics: async () => {
    calls++; throw new SunoLyricsOutcomeUnknownError();
  } } } } } }), ChatBridgeCommandOutcomeUnknownError);
  assert.equal(calls, 1);
  assert.equal(JSON.parse((await loadSessionEvents(h.storage, h.session.id))[1]!.content).status, "unknown");
  assert.deepEqual(await listAudioJobs(h.storage, h.session.id), []);
});


test("lyric model reads keep query provenance without entering the paid generation fence", async (t) => {
  const h = await harness(t);
  const panel = (await loadAudioParameterGroups(h.storage, h.session.id)).groups
    .flatMap((group) => group.tools).find((tool) => tool.name.endsWith("inspect_lyric_models"))!.audioPanel!;
  let reads = 0;
  assert.deepEqual(await runAudioParameterTool({ assertLiveSetCurrent: () => {}, ...{ ...h.input,
    toolName: panel.toolName, signature: panel.signature, arguments: { connectionId: "website" },
    withGenerationAuthorization: async () => { throw new Error("Read must not enter a paid fence"); },
    processing: { pluginOverrides: { plugin: { inspectLyricModels: async (connection) => {
      reads++;
      assert.equal(connection.sunoSession!.accountId, "user_fixture");
      return { query: "lyric_models", models: [{ id: "lyric-model", name: "Lyric model", supportsThinking: false }] };
    } } } },
  } }), { failed: false });
  assert.equal(reads, 1);
  const result = JSON.parse((await loadSessionEvents(h.storage, h.session.id)).at(-1)!.content);
  assert.equal(result.models[0].id, "lyric-model");
  assert.equal(result.provenance.connectionId, "website");
  assert.deepEqual(await listAudioJobs(h.storage, h.session.id), []);
});

test("a lyric model read revalidates its connection before publishing private results", async (t) => {
  const h = await harness(t);
  const panel = (await loadAudioParameterGroups(h.storage, h.session.id)).groups
    .flatMap((group) => group.tools).find((tool) => tool.name.endsWith("inspect_lyric_models"))!.audioPanel!;
  assert.deepEqual(await runAudioParameterTool({ assertLiveSetCurrent: () => {}, ...{ ...h.input,
    toolName: panel.toolName, signature: panel.signature, arguments: { connectionId: "website" },
    processing: { pluginOverrides: { plugin: { inspectLyricModels: async () => {
      await saveIntegrationConnection(h.storage, "1", { id: "website", name: "Suno", provider: "suno", enabled: false, apiKey: "" });
      return { query: "lyric_models", models: [{ id: "private-model", name: "Private model", supportsThinking: false }] };
    } } } },
  } }), { failed: true });
  assert.doesNotMatch(JSON.stringify(await loadSessionEvents(h.storage, h.session.id)), /private-model/);
});
