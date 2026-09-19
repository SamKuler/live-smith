import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createRequestAudioTools } from "./request-audio-tools.js";
import { createSession } from "../storage/sessions.js";
import { SunoSessions } from "../storage/suno-sessions.js";
import type { AudioGenerationRequest } from "../audio-services/contracts.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { builtInAudioToolName } from "../plugins/builtins/audio-toolsets.js";
import { sunoWebsitePlugin } from "../plugins/builtins/suno-website.js";
import { saveIntegrationConnection } from "./integration-connection-test-helpers.js";

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
  const tools = await createRequestAudioTools({
    context: {} as never, storageDirectory: directory, sessionId: session.id, requestId: "request",
    attachmentRefs: [], target: {}, signal: new AbortController().signal, onProgress() {}, onAssets() {},
    processing: {
      musicServiceReader: async (credential, query) => {
        calls.queries.push(query);
        assert.equal(credential.accountId, "user_personal");
        if (mode.changeCredential) await new SunoSessions(directory).clear("personal");
        return { query: "library" as const, hasMore: false, clips: [{ id: clipId, title: "An observed song", status: "complete", modelId: "catalog-model", styles: "piano", durationSeconds: 60 }] };
      },
      generationAdapter: {
        provider: "suno", submit: async (request) => {
          calls.submissions.push(request);
          return { kind: "audio", outputs: [{ role: "music", bytes: waveBytes() }] };
        },
      },
    },
  });
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
