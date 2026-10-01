import assert from "node:assert/strict";
import test from "node:test";
import type { AudioGenerationRequest } from "../../src/audio-services/contracts.js";
import {
  A, B, C, accountId, signal, model, catalog, clip, replay,
  accountStep, gateStep, submitStep, pollStep, safeFailure, preparedSubmit,
} from "./support/audio-service-suno-harness.js";

const ownerId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const owner = () => ({ path: "/api/session/", value: { user: { id: ownerId, clerk_id: accountId } } });
const account = (extra: Record<string, unknown> = {}) => accountStep(catalog([model({ capabilities: ["all"], features: ["create_control_sliders"], ...extra })]));
const source = (metadata: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => pollStep([clip(C, "complete", {
  user_id: ownerId, metadata: { duration: 60, prompt: "", ...metadata }, ...extra,
})], C);
const replacement: Extract<AudioGenerationRequest, { operation: "replace_music_section" }> = {
  operation: "replace_music_section", clipId: C, startSeconds: 10.01, endSeconds: 25.01,
  contextStartSeconds: 2, contextEndSeconds: 40, replacementDurationSeconds: 12,
  prompt: "New chorus", options: { mode: "custom", styles: "Folk", audioInfluence: 30 },
};
const alignment = (value: unknown = { aligned_words: [
  { word: "[Verse]\n", start_s: 0, end_s: 0 }, { word: "Old introduction.\n", start_s: 2, end_s: 8 },
  { word: "Original chorus.\n", start_s: 11, end_s: 20 }, { word: "Closing words.", start_s: 30, end_s: 35 },
] }) => ({ path: `/api/gen/${C}/aligned_lyrics/v2`, value });

test("Add Vocals and Add Instrumental use website painting tasks with the observed source", async () => {
  for (const operation of ["add_vocals", "add_instrumental"] as const) {
    const h = replay([account(), owner(), source(operation === "add_vocals" ? {} : { type: "upload" }), gateStep(), submitStep()]);
    await preparedSubmit(h, { operation, clipId: C, prompt: operation === "add_vocals" ? "New vocal line" : "",
      options: { mode: "custom", styles: "Soul", audioInfluence: 80 } });
    const body = h.api().at(-1)!.body as Record<string, any>;
    assert.equal(body.task, operation === "add_vocals" ? "overpainting" : "underpainting");
    assert.equal(body[operation === "add_vocals" ? "overpainting_clip_id" : "underpainting_clip_id"], C);
    assert.equal(body.metadata.is_remix, true);
    assert.deepEqual(body.metadata.control_sliders, { audio_weight: 0.8 });
    assert.equal(body.cover_clip_id, null);
    assert.equal(body.continue_clip_id, null);
    h.done();
  }
});

test("painting operations respect actual source kinds and server action overrides", async () => {
  for (const operation of ["add_vocals", "add_instrumental"] as const) {
    const request: AudioGenerationRequest = { operation, clipId: C, prompt: "New words" };
    const rejected = replay([account(), owner(), source({ prompt: "Existing vocals" })]);
    await safeFailure(rejected.adapter.prepare!(request, signal()), /does not permit/);
    const allowed = replay([account(), owner(), source({ prompt: "Existing vocals" }, {
      action_config: { actions: [{ action_type: operation === "add_vocals" ? "add_vocal" : "add_instrumental", visible: true, disabled: false }] },
    }), gateStep(), submitStep()]);
    await preparedSubmit(allowed, request);
    allowed.done();
    const modelDenied = replay([account({ capabilities: [] })]);
    await safeFailure(modelDenied.adapter.prepare!(request, signal()), /catalog does not confirm/);
    assert.equal(modelDenied.api().length, 1);
  }
});

test("smart replacement reads existing alignment, quantizes ranges and preserves distinct context/new lyrics", async () => {
  const h = replay([account(), owner(), source({ prompt: "Original source lyrics" }), alignment(), gateStep(), submitStep()]);
  const result = await preparedSubmit(h, replacement);
  assert.equal(result.kind, "task");
  const body = h.api().at(-1)!.body as Record<string, any>;
  assert.equal(body.task, "infill");
  assert.equal(body.continue_clip_id, C);
  assert.equal(body.prompt, "[Verse]\nOld introduction.\n");
  assert.equal(body.continued_aligned_prompt, "New chorus");
  assert.equal(body.metadata.infill_lyrics, "New chorus");
  assert.equal(body.metadata.lyrics_updated, true);
  assert.equal(body.metadata.is_remix, true);
  assert.equal(body.infill_start_s, 10);
  assert.equal(body.infill_end_s, 25.04);
  assert.equal(body.infill_dur_s, 12);
  assert.equal(body.infill_context_start_s, 2);
  assert.equal(body.infill_context_end_s, 40);
  assert.equal(Object.hasOwn(body, "make_instrumental"), false);
  assert.equal(h.api().filter((entry) => entry.path.includes("aligned_lyrics") && entry.init.method === "POST").length, 0);
  assert.equal(h.api().filter((entry) => entry.path.includes("concat")).length, 0);
  h.done();
});

test("empty replacement lyrics retain the aligned section and instrumental sources need no alignment", async () => {
  const vocal = replay([account(), owner(), source({ prompt: "Source lyrics" }), alignment(), gateStep(), submitStep()]);
  await preparedSubmit(vocal, { ...replacement, prompt: "" });
  const vocalBody = vocal.api().at(-1)!.body as Record<string, any>;
  assert.equal(vocalBody.metadata.infill_lyrics, "Original chorus.");
  assert.equal(vocalBody.metadata.lyrics_updated, false);
  const instrumental = replay([account(), owner(), source(), gateStep(), submitStep()]);
  await preparedSubmit(instrumental, { ...replacement, prompt: "" });
  assert.equal((instrumental.api().at(-1)!.body as Record<string, any>).prompt, "");
  instrumental.done();
});

test("missing alignment, invalid bounds and unconfirmed model tasks stop before generation", async () => {
  const missing = replay([account(), owner(), source({ prompt: "Words" }), alignment({ detail: "Processing lyrics. Please try again later." })]);
  await safeFailure(missing.adapter.prepare!(replacement, signal()), /alignment is unavailable/);
  assert.equal(missing.api().some((entry) => entry.path === "/api/c/check"), false);
  for (const fields of [{ endSeconds: 15 }, { contextStartSeconds: 12 }, { contextEndSeconds: 20 }, { replacementDurationSeconds: 0 }]) {
    const h = replay();
    await safeFailure(h.adapter.prepare!({ ...replacement, ...fields }, signal()));
    assert.equal(h.requests.length, 0);
  }
  const outside = replay([account(), owner(), source({ duration: 20 })]);
  await safeFailure(outside.adapter.prepare!(replacement, signal()), /within the completed/);
  const unknown = replay([account({ capabilities: ["cover"] })]);
  await safeFailure(unknown.adapter.prepare!(replacement, signal()), /catalog does not confirm/);
});

test("classic v4.5 smart infill uses the first-party dedicated model route", async () => {
  const h = replay([account({ external_key: "chirp-auk" }), owner(), source(), gateStep(), submitStep()], "chirp-auk");
  await preparedSubmit(h, replacement);
  assert.equal((h.api().at(-1)!.body as Record<string, unknown>).mv, "chirp-auk-infill");
  h.done();
});

test("finishing an explicitly selected candidate concatenates only that clip and acknowledges one whole song", async () => {
  const editSession = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const h = replay([owner(), source({ task: "infill", edited_clip_id: B, edit_session_id: editSession }),
    { path: "/api/generate/concat/v2/", value: clip(A, "submitted") }]);
  const result = await preparedSubmit(h, { operation: "finish_music_replacement", clipId: C });
  assert.deepEqual(result, { kind: "task", taskId: A, expectedOutputs: [{ key: A, role: "music" }] });
  assert.deepEqual(h.api().at(-1)!.body, { clip_id: C, is_infill: true, edit_session_id: editSession });
  assert.equal(h.api().some((entry) => entry.path === "/api/c/check" || entry.path === "/api/generate/v2-web/"), false);
  h.done();
});

test("finalization rejects ordinary songs, wrong lineage and server-disabled candidates before concat", async () => {
  for (const metadata of [{}, { task: "extend", edited_clip_id: B }, { task: "infill" },
    { task: "infill", edited_clip_id: C }, { task: "infill", edited_clip_id: B, edit_session_id: "bad" }]) {
    const h = replay([owner(), source(metadata)]);
    await safeFailure(h.adapter.prepare!({ operation: "finish_music_replacement", clipId: C }, signal()));
    assert.equal(h.api().length, 2);
  }
  const disabled = replay([owner(), source({ task: "infill", edited_clip_id: B }, {
    action_config: { actions: [{ action_type: "confirm_section", disabled: true }] },
  })]);
  await safeFailure(disabled.adapter.prepare!({ operation: "finish_music_replacement", clipId: C }, signal()), /replacement candidate/);
});

test("unknown section generation and finalization are never automatically resubmitted", async () => {
  for (const finish of [false, true]) {
    const request: AudioGenerationRequest = finish ? { operation: "finish_music_replacement", clipId: C } : replacement;
    const path = finish ? "/api/generate/concat/v2/" : "/api/generate/v2-web/";
    const h = replay([...(finish ? [] : [account()]), owner(), source(finish ? { task: "infill", edited_clip_id: B } : {}),
      ...(finish ? [] : [gateStep()]), { path, run: async () => { throw new Error("connection closed"); } }]);
    const abort = signal();
    await h.adapter.prepare!(request, abort);
    await safeFailure(h.adapter.submit(request, abort));
    await safeFailure(h.adapter.submit(request, abort), /not submitted|No generation was submitted/);
    assert.equal(h.api().filter((entry) => entry.path === path).length, 1);
    h.done();
  }
});

test("replacement uses normalized point tags, multiline words and untimed whitespace", async () => {
  const h = replay([account(), owner(), source({ prompt: "Intro\n[Chorus]\nHello world!\nOutro" }), alignment({ aligned_words: [
    { word: "Intro ", start_s: 2, end_s: 8 },
    { word: "[Chorus]", start_s: 0, end_s: 0 },
    { word: "\nHello ", start_s: 11, end_s: 16 },
    { word: "world", start_s: 16, end_s: 22 },
    { word: "!", start_s: 22, end_s: 22.2 },
    { word: "\n", start_s: 22.2, end_s: 22.2 },
    { word: "Outro", start_s: 30, end_s: 35 },
  ] }), gateStep(), submitStep()]);
  await preparedSubmit(h, { ...replacement, prompt: "" });
  const body = h.api().at(-1)!.body as Record<string, any>;
  assert.equal(body.prompt, "Intro \n");
  assert.equal(body.metadata.infill_lyrics, "[Chorus]\nHello world!");
  assert.equal(body.continued_aligned_prompt, "");
  assert.equal(body.metadata.lyrics_updated, false);
  h.done();
});

test("lyric selection uses requested boundaries before audio interval quantization", async () => {
  const h = replay([account(), owner(), source({ prompt: "Before After Next" }), alignment({ aligned_words: [
    { word: "Before ", start_s: 10, end_s: 10.01 },
    { word: "After ", start_s: 10.01, end_s: 12 },
    { word: "Next", start_s: 25.01, end_s: 30 },
  ] }), gateStep(), submitStep()]);
  await preparedSubmit(h, { ...replacement, prompt: "" });
  const body = h.api().at(-1)!.body as Record<string, any>;
  assert.equal(body.infill_start_s, 10); assert.equal(body.infill_end_s, 25.04);
  assert.equal(body.prompt, "Before ");
  assert.equal(body.metadata.infill_lyrics, "After");
  h.done();
});
