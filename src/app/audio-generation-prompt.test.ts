import assert from "node:assert/strict";
import test from "node:test";
import { parseAudioToolRequest, validateAudioServiceRequest } from "../agent/audio-tools.js";
import { createElevenLabsAudioAdapter } from "../audio-services/elevenlabs.js";
import { createSunoApiAudioAdapter } from "../audio-services/sunoapi.js";
import { mp3Bytes } from "../storage/audio-storage-test-helpers.js";
import { generateAudio } from "./audio-generation.js";
import { audioRecoveryHarness } from "./audio-recovery-test-helpers.js";
import { createRequestAudioTools } from "./request-audio-tools.js";
import { builtInAudioToolName } from "../plugins/builtins/audio-toolsets.js";
import { builtInAudioPlugin } from "../plugins/builtins/index.js";

for (const provider of ["sunoapi", "elevenlabs"] as const) {
  test(`${provider} uses the advertised Unicode character boundary through chat, app and adapter`, async (t) => {
    const h = await audioRecoveryHarness(t, provider);
    const limit = provider === "sunoapi" ? 3000 : 4100;
    const prompt = "𝄞".repeat(limit);
    const posts: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        if (provider === "sunoapi") return Response.json({ code: 200, msg: "success", data: { taskId: "fixture-task" } });
        return new Response(mp3Bytes().slice().buffer, { headers: { "content-type": "audio/mpeg" } });
      }
      return Response.json({ code: 200, msg: "success", data: { taskId: "fixture-task", status: "SUCCESS", response: {
        taskId: "fixture-task", sunoData: [{ id: "fixture-track", audio_url: "https://file.aiquickdraw.com/music.mp3" }],
      } } });
    };
    const adapter = provider === "sunoapi"
      ? createSunoApiAudioAdapter(h.connection.apiKey, { fetchImpl, callbackUrl: h.connection.callbackUrl! })
      : createElevenLabsAudioAdapter(h.connection.apiKey, { fetchImpl });
    // Keep the real submit/inspect mapping and supply a small valid fixture download.
    if (provider === "sunoapi") adapter.download = async () => mp3Bytes();
    const tools = await createRequestAudioTools({
      context: {} as never, storageDirectory: h.storage, sessionId: h.session.id,
      requestId: "request", attachmentRefs: [], target: {}, signal: h.context.signal,
      onProgress() {}, onAssets() {}, processing: { generationAdapter: adapter },
    });
    const args = { serviceId: h.connection.id, prompt, instrumental: true };
    const toolName = builtInAudioToolName(
      builtInAudioPlugin(h.connection.provider),
      "generate_music",
    );
    const schema = tools.tools.find((tool) => tool.function.name === toolName)!.function.parameters!;
    const branches = schema.oneOf as Array<{ properties: { prompt: { maxLength: number } } }>;
    assert.equal(Array.from(prompt).length, branches[0]!.properties.prompt.maxLength);
    const result = await tools.execute({ id: "generate", name: toolName, arguments: JSON.stringify(args) });
    assert.equal(result.failed, undefined);
    assert.equal(JSON.parse(result.content).status, "completed");
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.prompt, prompt);

    const tooLong = { ...args, prompt: prompt + "𝄞" };
    const rejected = await tools.execute({ id: "too-long", name: toolName, arguments: JSON.stringify(tooLong) });
    assert.equal(rejected.invalidArguments, true);
    assert.throws(() => validateAudioServiceRequest({ kind: "generate_music", ...tooLong }, [h.connection]));
    const request = { operation: "generate_music" as const, prompt: tooLong.prompt, instrumental: true };
    await assert.rejects(generateAudio({ ...h.context, generationAdapter: adapter }, h.connection.id, request), /limit/);
    await assert.rejects(adapter.submit(request, h.context.signal), /characters/);
    assert.equal(posts.length, 1, "over-limit prompts must not issue a paid request");
  });
}

test("sound-effect tool parsing counts supplementary characters without changing its own limit", () => {
  const args = { serviceId: "fixture", prompt: "🌧️".repeat(2050), durationSeconds: 1, loop: false };
  assert.equal(Array.from(args.prompt).length, 4100);
  assert.equal(parseAudioToolRequest("generate_sound_effect", JSON.stringify(args)).kind, "generate_sound_effect");
  assert.throws(() => parseAudioToolRequest("generate_sound_effect", JSON.stringify({ ...args, prompt: args.prompt + "a" })));
});
