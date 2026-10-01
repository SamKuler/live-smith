import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import test from "node:test";
import { SunoLyricsOutcomeUnknownError } from "../../src/audio-services/suno-lyrics.js";
import { createSession } from "../../src/storage/sessions.js";
import { SunoSessions } from "../../src/storage/suno-sessions.js";
import { listAudioJobs } from "../../src/storage/audio-jobs.js";
import { loadSessionEvents } from "../../src/storage/events.js";
import { saveIntegrationConnection } from "./support/integration-connection-test-helpers.js";
import { loadAudioParameterGroups, runAudioParameterTool } from "../../src/app/audio-parameter-tool.js";
import { ChatBridgeCommandOutcomeUnknownError } from "../../src/app/chat-bridge.js";

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
  assert.deepEqual(await runAudioParameterTool({ ...h.input,
    withGenerationAuthorization: async (signal, operation) => { leases++; return authorize(signal, operation); },
    processing: { sunoLyricsWriter: async (session, request) => {
      calls++; assert.equal(session.accountId, "user_fixture"); assert.equal(request.selected, "");
      return { status: "completed", lyrics: "A new verse" };
    } },
  }), { failed: false });
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
  await assert.rejects(runAudioParameterTool({ ...h.input, processing: { sunoLyricsWriter: async () => {
    calls++; throw new SunoLyricsOutcomeUnknownError();
  } } }), ChatBridgeCommandOutcomeUnknownError);
  assert.equal(calls, 1);
  assert.equal(JSON.parse((await loadSessionEvents(h.storage, h.session.id))[1]!.content).status, "unknown");
  assert.deepEqual(await listAudioJobs(h.storage, h.session.id), []);
});
