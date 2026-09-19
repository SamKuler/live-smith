import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import type { TestContext } from "node:test";
import type { AudioGenerationAdapter } from "../audio-services/contracts.js";
import { createSession } from "../storage/sessions.js";
import { SunoSessions } from "../storage/suno-sessions.js";
import { listAudioJobs } from "../storage/audio-jobs.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { createHostAbortController } from "../runtime/host.js";
import { saveIntegrationConnection } from "./integration-connection-test-helpers.js";

export const clipIds = ["aaaaaaaa-1111-4111-8111-111111111111", "bbbbbbbb-2222-4222-8222-222222222222"];
export const manifest = clipIds.map((key, index) => ({ key, role: index === 0 ? "music" as const : "music_alternative" as const }));
export const connection = { id: "website", name: "Suno fixture", provider: "suno" as const, enabled: true, apiKey: "" };
export const fixtureToken = (value: string) => ["{}", value, "fixture-signature"].map((part) => Buffer.from(part).toString("base64url")).join(".");

export async function retrievalHarness(t: TestContext) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-retrieval-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Retrieval", projectKey: "fixture",
    scope: { kind: "selection", identity: "selection", label: "Audio" } });
  await saveIntegrationConnection(directory, "0", connection);
  const sessions = new SunoSessions(directory);
  await sessions.save(connection.id, { accountId: "user_fixture", clientToken: fixtureToken("first") });
  const controller = createHostAbortController();
  const calls = { prepare: 0, submit: 0, inspect: 0, downloads: [] as string[] };
  const mode = { locked: new Set<string>(), failed: new Set<string>(), invalid: new Set<string>(), stop: false, changed: false };
  const adapter: AudioGenerationAdapter = {
    provider: "suno",
    async prepare() { calls.prepare++; throw new Error("Retrieval must not prepare generation."); },
    async submit() { calls.submit++; throw new Error("Retrieval must not submit generation."); },
    async inspect(taskId, _signal, expected) {
      calls.inspect++;
      assert.ok(expected);
      assert.equal(taskId, expected[0]!.key);
      const saved = (await listAudioJobs(directory, session.id)).find((job) => job.remoteTaskId === taskId)!;
      assert.deepEqual(saved.expectedOutputs, expected, "IDs are durable before collection");
      if (mode.stop) { controller.abort(); return { status: "running" }; }
      return { status: "completed", outputs: expected.filter((entry) => !mode.failed.has(entry.key)).map((entry) => ({
        ...entry, key: mode.changed ? "cccccccc-3333-4333-8333-333333333333" : entry.key,
        url: `/api/download/clip/${entry.key}?format=mp3`,
      })), failedOutputKeys: [...mode.failed] };
    },
    async download(output) {
      calls.downloads.push(output.key);
      if (mode.locked.has(output.key)) throw new Error("Authorize this song's download on Suno, then resume.");
      return mode.invalid.has(output.key) ? new Uint8Array([1, 2, 3]) : waveBytes();
    },
    async downloadSelected(output, signal) {
      return adapter.download!({ ...output, url: `fixture:${output.key}` }, signal);
    },
  };
  const context = { storageDirectory: directory, sessionId: session.id, signal: controller.signal,
    generationAdapter: adapter, wait: async () => {} };
  return { directory, session, sessions, controller, calls, mode, adapter, context };
}
