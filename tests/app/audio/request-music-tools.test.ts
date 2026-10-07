import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createRequestAudioTools } from "../../../src/app/audio/request-audio-tools.js";
import { createSession } from "../../../src/storage/sessions.js";
import { SunoSessions } from "../../../src/storage/suno-sessions.js";
import type { AudioGenerationRequest } from "../../../src/audio-services/contracts.js";
import { waveBytes } from "../../storage/support/audio-storage-test-helpers.js";
import { builtInAudioToolName } from "../../../src/plugins/builtins/audio-toolsets.js";
import { sunoWebsitePlugin } from "../../../src/plugins/builtins/suno-website.js";
import { saveIntegrationConnection } from "../plugins/support/integration-connection-test-helpers.js";

const clipId = "11111111-1111-4111-8111-111111111111";
const token = ["{}", "fixture-client", "fixture-signature"].map((part) => Buffer.from(part).toString("base64url")).join(".");

async function harness(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-request-music-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Music tools", projectKey: "project", scope: { kind: "selection", identity: "selection", label: "Audio" } });
  for (const [index, id] of ["personal", "work"].entries()) {
    await saveIntegrationConnection(directory, String(index), {
      id, name: id, provider: "suno", enabled: true, apiKey: "",
    });
    await new SunoSessions(directory).save(id, { accountId: `user_${id}`, clientToken: token });
  }
  const calls: { queries: unknown[]; submissions: AudioGenerationRequest[] } = { queries: [], submissions: [] };
  const mode = { changeCredential: false };
  const tools = await createRequestAudioTools({ assertLiveSetCurrent: () => {}, ...{
    context: {} as never, storageDirectory: directory, sessionId: session.id, requestId: "request",
    attachmentRefs: [], target: {}, signal: new AbortController().signal, onProgress() {}, onAssets() {},
    processing: {
      pluginOverrides: { plugin: { inspectMusicService: async (credential, query) => {
        calls.queries.push(query);
        assert.equal(credential.sunoSession!.accountId, "user_personal");
        if (mode.changeCredential) await new SunoSessions(directory).clear("personal");
        return { query: "library" as const, hasMore: false, clips: [{ id: clipId, title: "An observed song", status: "complete", modelId: "catalog-model", styles: "piano", durationSeconds: 60 }] };
      } } },
      generationAdapter: {
        provider: "suno", submit: async (request) => {
          calls.submissions.push(request);
          return { kind: "audio", outputs: [{ role: "music", bytes: waveBytes() }] };
        },
      },
    },
  } });
  const execute = (name: string, args: unknown) => tools.execute({
    id: "call",
    name: builtInAudioToolName(sunoWebsitePlugin, name),
    arguments: JSON.stringify(args),
  });
  return { directory, tools, calls, execute, mode };
}

test("library tools strip host routing fields and admit only observed clip references on their connection", async (t) => {
  const h = await harness(t);
  const extension = { connectionId: "personal", clipId, startSeconds: 10, prompt: "new verse", instrumental: false };
  assert.equal((await h.execute("extend_music", extension)).invalidArguments, true);
  assert.equal(h.calls.submissions.length, 0);
  const library = await h.execute("inspect_music_service", { connectionId: "personal", query: "library", search: "piano" });
  assert.equal(library.failed, undefined);
  assert.deepEqual(h.calls.queries, [{ query: "library", search: "piano" }]);
  assert.doesNotMatch(library.content, new RegExp(token.replaceAll(".", "\\.")));
  assert.equal((await h.execute("extend_music", { ...extension, connectionId: "work" })).invalidArguments, true);
  const result = await h.execute("extend_music", extension);
  assert.equal(result.failed, undefined);
  assert.equal(JSON.parse(result.content).operation, "extend_music");
  assert.deepEqual(h.calls.submissions, [{ operation: "extend_music", clipId, startSeconds: 10, prompt: "new verse", instrumental: false }]);
});

test("custom parameters survive the chat-to-runtime boundary without connection data", async (t) => {
  const h = await harness(t);
  const fields = { prompt: "my lyrics", instrumental: false, options: { mode: "custom", styles: "piano", weirdness: 40, styleInfluence: 60 } };
  const result = await h.execute("generate_music", { connectionId: "personal", ...fields });
  assert.equal(result.failed, undefined);
  assert.deepEqual(h.calls.submissions, [{ operation: "generate_music", ...fields }]);
  assert.doesNotMatch(JSON.stringify(h.tools.tools), /clientToken|user_personal|fixture-client/);
});

test("Cover and Remaster require an observed source on the exact connection", async (t) => {
  const h = await harness(t);
  const requests = [
    { kind: "cover_music", clipId, startSeconds: 1, endSeconds: 10, prompt: "New verse", instrumental: false,
      options: { mode: "custom", styles: "Jazz", audioInfluence: 60 } },
    { kind: "remaster_music", clipId, modelId: "chirp-halibut-fixture", variation: "normal" },
  ];
  for (const { kind, ...fields } of requests) {
    assert.equal((await h.execute(kind, { connectionId: "personal", ...fields })).invalidArguments, true);
  }
  assert.equal(h.calls.submissions.length, 0);
  await h.execute("inspect_music_service", { connectionId: "personal", query: "library" });
  for (const { kind, ...fields } of requests) {
    assert.equal((await h.execute(kind, { connectionId: "work", ...fields })).invalidArguments, true);
    const result = await h.execute(kind, { connectionId: "personal", ...fields });
    assert.equal(result.failed, undefined);
    assert.deepEqual(h.calls.submissions.at(-1), { operation: kind, ...fields });
  }
});

test("painting, replacement candidates and explicit finalization all require connection-bound observed clips", async (t) => {
  const h = await harness(t);
  const requests = [
    { kind: "add_vocals", clipId, prompt: "A vocal line" },
    { kind: "add_instrumental", clipId, prompt: "" },
    { kind: "replace_music_section", clipId, startSeconds: 5, endSeconds: 20, prompt: "New chorus" },
    { kind: "finish_music_replacement", clipId },
  ];
  for (const { kind, ...fields } of requests) {
    assert.equal((await h.execute(kind, { connectionId: "personal", ...fields })).invalidArguments, true);
  }
  await h.execute("inspect_music_service", { connectionId: "personal", query: "library" });
  for (const { kind, ...fields } of requests) {
    assert.equal((await h.execute(kind, { connectionId: "work", ...fields })).invalidArguments, true);
    assert.equal((await h.execute(kind, { connectionId: "personal", ...fields })).failed, undefined);
    assert.deepEqual(h.calls.submissions.at(-1), { operation: kind, ...fields });
  }
  assert.equal(h.calls.submissions.filter((request) => request.operation === "finish_music_replacement").length, 1);
});

test("a connection cleared during a library read cannot release that account's results or enable editing", async (t) => {
  const h = await harness(t);
  h.mode.changeCredential = true;
  const library = await h.execute("inspect_music_service", { connectionId: "personal", query: "library" });
  assert.equal(library.failed, true);
  assert.equal(library.stop, true);
  assert.doesNotMatch(library.content, /An observed song|11111111/);
  assert.equal((await h.execute("get_whole_song", { connectionId: "personal", clipId })).invalidArguments, true);
  assert.equal(h.calls.submissions.length, 0);
});
