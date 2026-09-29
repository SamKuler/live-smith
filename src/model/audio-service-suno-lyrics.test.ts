import assert from "node:assert/strict";
import test from "node:test";
import { SunoHttpError } from "../audio-services/suno-http.js";
import { parseLyricWritingRequest, readSunoLyricModels, writeSunoLyrics, SunoLyricsOutcomeUnknownError } from "../audio-services/suno-lyrics.js";
import { createHostAbortController } from "../runtime/host.js";
import { session, replay, signal, clientToken } from "./audio-service-suno-harness.js";

const path = "/api/generate/cowrite-lyrics/";
const modelsPath = "/api/generate/cowrite-lyrics/models/";
const request = { selected: "", instruction: "Write a song about rain" };
const response = { edited_lyrics: "|edit_start|[Verse]\nRain on the window\n|edit_end|", lyrics_request_id: "request-fixture", lyrics_id: "lyrics-fixture" };

test("an empty editor submits apply_user_request and returns editable text with a receipt", async () => {
  const h = replay([{ path, value: response }]);
  const result = await writeSunoLyrics(session, request, signal(), { fetchImpl: h.fetchImpl });
  assert.deepEqual(h.api()[0]!.body, {
    selected: "", context_before: "", context_after: "", instruction: request.instruction,
    title: "", style: "", mode: "apply_user_request", references: [], num_variants: null,
    metadata: { lyrics_model: "default", enable_thinking: false }, create_session_token: null, lyrics_project_id: null,
  });
  assert.deepEqual(result, { status: "completed", lyrics: "[Verse]\nRain on the window\n", lyricsRequestId: "request-fixture", lyricsId: "lyrics-fixture" });
  h.done();
});

test("lyric alternatives preserve selection/context and verify the selected model's thinking evidence", async () => {
  const h = replay([{ path: modelsPath, value: [{ id: "writer-fixture", display_name: "Writer", family: "fixture", supports_thinking: true }] },
    { path, value: { edited_lyrics: "A new line", variants: ["|edit_start|First line|edit_end|", "Second line"] } }]);
  const result = await writeSunoLyrics(session, { ...request, selected: "Old line", contextBefore: "First verse", contextAfter: "Last verse",
    mode: "alternatives", modelId: "writer-fixture", enableThinking: true, styles: "Folk", title: "Song" }, signal(), { fetchImpl: h.fetchImpl });
  const body = h.api()[1]!.body as Record<string, unknown>;
  assert.equal(body.mode, "generate_variants");
  assert.equal(body.selected, "Old line");
  assert.equal(body.context_before, "First verse");
  assert.equal(body.context_after, "Last verse");
  assert.deepEqual(body.metadata, { lyrics_model: "writer-fixture", enable_thinking: true });
  assert.deepEqual(result.variants, ["First line", "Second line"]);
  h.done();
});

test("lyric model inspection projects only bounded public fields and preserves unknown thinking support", async () => {
  const h = replay([{ path: modelsPath, value: [
    { id: "default", display_name: "Default", family: null, internal: "private" },
    { id: "other", display_name: "Other", supports_thinking: false },
  ] }]);
  assert.deepEqual(await readSunoLyricModels(session, signal(), { fetchImpl: h.fetchImpl }), {
    query: "lyric_models", models: [{ id: "default", name: "Default" }, { id: "other", name: "Other", supportsThinking: false }],
  });
  assert.equal(h.api().length, 1);
});

test("unsupported models/thinking and invalid user fields cannot submit a lyric request", async () => {
  for (const fields of [{ modelId: "missing" }, { modelId: "default", enableThinking: true }]) {
    const h = replay([{ path: modelsPath, value: [{ id: "default", display_name: "Default", supports_thinking: false }] }]);
    await assert.rejects(writeSunoLyrics(session, { ...request, ...fields }, signal(), { fetchImpl: h.fetchImpl }), /not available/);
    assert.equal(h.api().length, 1);
  }
  for (const fields of [{ selected: null }, { instruction: "" }, { mode: "fresh_generate" }, { title: "x".repeat(101) }, { endpoint: path }]) {
    assert.throws(() => parseLyricWritingRequest({ ...request, ...fields }));
  }
});

test("a known provider rejection is distinct from an unconfirmed paid lyric outcome", async () => {
  const rejected = replay([{ path, response: new Response("private", { status: 402 }) }]);
  await assert.rejects(writeSunoLyrics(session, request, signal(), { fetchImpl: rejected.fetchImpl }), (error: unknown) => {
    assert.ok(error instanceof SunoHttpError);
    assert.equal(error.status, 402);
    assert.ok(!(error instanceof SunoLyricsOutcomeUnknownError));
    return true;
  });
  const unknown = replay([{ path, run: async () => { throw new Error(clientToken); } }]);
  await assert.rejects(writeSunoLyrics(session, request, signal(), { fetchImpl: unknown.fetchImpl }), (error: unknown) => {
    assert.ok(error instanceof SunoLyricsOutcomeUnknownError);
    assert.ok(!String(error.stack).includes(clientToken));
    return true;
  });
  assert.equal(unknown.api().length, 1);
});

test("malformed or credential-bearing paid responses are unknown and never leak provider data", async () => {
  for (const value of [{ edited_lyrics: 1 }, { edited_lyrics: "" }, { edited_lyrics: clientToken }, { edited_lyrics: "Words", lyrics_id: "https://private.example" }]) {
    const h = replay([{ path, value }]);
    await assert.rejects(writeSunoLyrics(session, request, signal(), { fetchImpl: h.fetchImpl }), SunoLyricsOutcomeUnknownError);
    assert.equal(h.api().length, 1);
  }
});

test("a complete lyric receipt survives Stop racing the response without an automatic retry", async () => {
  const controller = createHostAbortController();
  const h = replay([{ path, run: async () => { controller.abort(); return Response.json(response); } }]);
  const result = await writeSunoLyrics(session, request, controller.signal, { fetchImpl: h.fetchImpl });
  assert.equal(result.status, "completed");
  assert.equal(result.lyricsId, "lyrics-fixture");
  assert.equal(h.api().length, 1);
});
