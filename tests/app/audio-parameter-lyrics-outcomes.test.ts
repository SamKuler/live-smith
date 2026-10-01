import assert from "node:assert/strict";
import test from "node:test";
import { retrievalHarness } from "./support/audio-retrieval-test-helpers.js";
import { saveIntegrationConnection } from "./support/integration-connection-test-helpers.js";
import { loadAudioParameterGroups, runAudioParameterTool } from "../../src/app/audio-parameter-tool.js";
import { generateMurekaLyrics, MurekaLyricsOutcomeUnknownError } from "../../src/audio-services/mureka.js";
import { ChatBridgeCommandOutcomeUnknownError } from "../../src/app/chat-bridge.js";
import { loadSessionEvents } from "../../src/storage/events.js";

for (const response of ["lost", "invalid", "rejected", "rejected-stop", "stopped"] as const) test(`manual Mureka lyrics preserves ${response} submission evidence`, async (t) => {
  const h = await retrievalHarness(t);
  await saveIntegrationConnection(h.directory, "1", { id: "lyrics", name: "Lyrics", provider: "mureka", enabled: true, apiKey: "fixture-mureka-key" });
  const panel = (await loadAudioParameterGroups(h.directory, h.session.id)).groups.flatMap((group) => group.tools)
    .find((tool) => tool.name === "builtin_mureka_generate_lyrics")!.audioPanel!;
  let submissions = 0;
  const run = () => runAudioParameterTool({
    context: {} as never, storageDirectory: h.directory, sessionId: h.session.id, target: {},
    signal: h.controller.signal, onProgress() {}, onAssets() {},
    withAdmissionAuthorization: async (_signal, work) => work(),
    withGenerationAuthorization: async (_signal, work) => work(),
    toolName: panel.toolName, signature: panel.signature, arguments: { connectionId: "lyrics", prompt: "A verse about rain" },
    processing: { murekaLyricsGenerator: (key, prompt, signal) => generateMurekaLyrics(key, prompt, signal, {
      fetchImpl: async (url, init) => {
        assert.equal(String(url), "https://api.mureka.ai/v1/lyrics/generate");
        assert.equal(init?.method, "POST"); submissions++;
        if (response === "lost") throw new Error("fixture private transport detail");
        if (response === "rejected-stop") { h.controller.abort(); return Response.json({}, { status: 402 }); }
        if (response === "stopped") {
          h.controller.abort();
          return Response.json({ title: "Rain", lyrics: "Rain falls over the city" });
        }
        return new Response(JSON.stringify({}), { status: response === "rejected" ? 422 : 200,
          headers: { "Content-Type": "application/json" } });
      },
    }) },
  });
  if (response === "rejected" || response === "rejected-stop") assert.deepEqual(await run(), { failed: true });
  else if (response === "stopped") assert.deepEqual(await run(), { failed: false });
  else await assert.rejects(run(), ChatBridgeCommandOutcomeUnknownError);
  assert.equal(submissions, 1);
  const events = await loadSessionEvents(h.directory, h.session.id);
  assert.equal(events.at(-1)?.kind, "tool_result");
  if (response === "lost" || response === "invalid") assert.equal(JSON.parse(events.at(-1)!.content).status, "unknown");
  if (response === "stopped") assert.equal(JSON.parse(events.at(-1)!.content).lyrics, "Rain falls over the city");
  if (response === "rejected-stop") assert.equal(JSON.parse(events.at(-1)!.content).status, "failed");
  assert.doesNotMatch(JSON.stringify(events), /fixture-mureka-key|private transport detail/);
});

test("invalid lyric input is rejected before dispatch without an unknown outcome", async () => {
  let requests = 0;
  await assert.rejects(generateMurekaLyrics("fixture-key", "", new AbortController().signal, {
    fetchImpl: async () => { requests++; throw new Error("Unexpected request"); },
  }), (error) => error instanceof Error && !(error instanceof MurekaLyricsOutcomeUnknownError));
  assert.equal(requests, 0);
});
