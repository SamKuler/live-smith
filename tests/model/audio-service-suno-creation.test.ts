import assert from "node:assert/strict";
import test from "node:test";
import type { AudioGenerationRequest, AudioJob } from "../../src/audio-services/contracts.js";
import { readSunoMusicService } from "../../src/audio-services/suno.js";
import { createHostAbortController } from "../../src/runtime/host.js";
import {
  A, B, C, MODEL, MUSIC, accountId, session, signal, model, catalog, clip, receipt,
  replay, accountStep, gateStep, submitStep, pollStep, safeFailure, preparedSubmit,
} from "./support/audio-service-suno-harness.js";

const supported = (extra: Record<string, unknown> = {}) => catalog([model({
  capabilities: ["sound", "cover"], features: ["create_control_sliders"],
  allowed_condition_combinations: [["cover"], ["extend"]], ...extra,
})]);
const sample: AudioGenerationRequest = { operation: "generate_sound_sample", prompt: "Dry woodblock", loop: true, bpm: 120, key: "F#m" };
const cover: AudioGenerationRequest = { operation: "cover_music", clipId: C, startSeconds: 2, endSeconds: 20,
  prompt: "A new verse", instrumental: false,
  options: { mode: "custom", styles: "Acoustic folk", audioInfluence: 70, weirdness: 20 } };
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const owner = () => ({ path: "/api/session/", value: { user: { id: ownerId, clerk_id: accountId } } });
const source = (extra: Record<string, unknown> = {}) => pollStep([clip(C, "complete", { user_id: ownerId, ...extra })], C);
const soundManifest = [{ key: A, role: "sound_effect" }, { key: B, role: "sound_effect_alternative" }] satisfies AudioJob["expectedOutputs"];
const remasterModel = "chirp-halibut-fixture";
const remasterCatalog = () => catalog([], { remaster_model_types: [model({ external_key: remasterModel })] });

test("Sounds uses the website task and sound_configs envelope without an invented duration", async () => {
  const h = replay([accountStep(supported()), gateStep(), submitStep()]);
  assert.deepEqual(await preparedSubmit(h, sample), { kind: "task", taskId: A, expectedOutputs: soundManifest });
  const body = h.api().at(-1)!.body as Record<string, any>;
  assert.equal(body.mv, MODEL);
  assert.equal(body.task, "sound");
  assert.equal(body.tags, sample.prompt);
  assert.equal(body.prompt, "");
  assert.equal(body.make_instrumental, true);
  assert.equal(Object.hasOwn(body, "duration"), false);
  assert.equal(Object.hasOwn(body, "gpt_description_prompt"), false);
  assert.equal(body.metadata.create_mode, "custom");
  assert.deepEqual(body.metadata.sound_configs, { user_loop: true, user_tempo: 120, user_key: "F#m" });
  assert.equal(Object.hasOwn(body.metadata, "control_sliders"), false);
  h.done();
});

test("one-shot Sounds leaves automatic tempo/key absent and polls both stable sound roles", async () => {
  const h = replay([accountStep(supported()), gateStep(), submitStep(), pollStep([clip(B), clip(A)])]);
  const result = await preparedSubmit(h, { operation: "generate_sound_sample", prompt: "Door click", loop: false });
  assert.equal(result.kind, "task");
  const body = h.api().at(-1)!.body as Record<string, any>;
  assert.deepEqual(body.metadata.sound_configs, { user_loop: false });
  const status = await h.adapter.inspect!(A, signal(), soundManifest);
  assert.equal(status.status, "completed");
  if (status.status === "completed") assert.deepEqual(status.outputs.map(({ key, role }) => ({ key, role })), soundManifest);
  h.done();
});

test("new operations require affirmative catalog evidence before challenge or submission", async () => {
  for (const request of [sample, cover]) {
    for (const capabilities of [undefined, [], ["extend"]]) {
      const h = replay([accountStep(supported({ capabilities }))]);
      await safeFailure(h.adapter.prepare!(request, signal()), /catalog does not confirm/);
      assert.equal(h.api().length, 1);
      h.done();
    }
  }
  const legacy = replay([accountStep(), gateStep(), submitStep()]);
  await preparedSubmit(legacy, MUSIC);
  legacy.done();
});

test("sound input limits are checked before authentication and cannot carry arbitrary fields", async () => {
  for (const fields of [{ prompt: "" }, { prompt: "x".repeat(501) }, { bpm: 0 }, { bpm: 301 },
    { bpm: 120.5 }, { key: "Cb" }, { key: "Any" }, { loop: 1 }, { durationSeconds: 3 }]) {
    const h = replay();
    await safeFailure(h.adapter.prepare!({ ...sample, ...fields } as AudioGenerationRequest, signal()));
    assert.equal(h.requests.length, 0);
  }
});

test("Cover observes the completed account-owned clip and maps lyrics, interval and audio influence", async () => {
  const h = replay([accountStep(supported()), owner(), source(), gateStep(), submitStep()]);
  await preparedSubmit(h, cover);
  const body = h.api().at(-1)!.body as Record<string, any>;
  assert.equal(body.task, "cover");
  assert.equal(body.cover_clip_id, C);
  assert.equal(body.cover_start_s, 2);
  assert.equal(body.cover_end_s, 20);
  assert.equal(body.continue_clip_id, null);
  assert.equal(body.prompt, "A new verse");
  assert.equal(body.tags, "Acoustic folk");
  assert.equal(body.metadata.is_remix, true);
  assert.deepEqual(body.metadata.control_sliders, { audio_weight: 0.7, weirdness_constraint: 0.2 });
  h.done();
});

test("Cover rejects foreign/missing owners, incomplete clips and source intervals before paid dispatch", async () => {
  for (const extra of [{ user_id: "other-account" }, { user_id: undefined }, { status: "streaming" },
    { metadata: { duration: 10 } }, { metadata: { duration: 2 } }]) {
    const h = replay([accountStep(supported()), owner(), source(extra)]);
    await safeFailure(h.adapter.prepare!(cover, signal()));
    assert.equal(h.api().length, 3);
    h.done();
  }
  const combinations = replay([accountStep(supported({ allowed_condition_combinations: [["persona", "cover"]] }))]);
  await safeFailure(combinations.adapter.prepare!(cover, signal()), /cover condition/);
});

test("Cover accepts explicitly remixable non-owned clips while Remaster keeps the website ownership rule", async () => {
  const remixable = { user_id: "other-account", metadata: { duration: 30, can_remix: true } };
  const allowed = replay([accountStep(supported()), owner(), source(remixable), gateStep(), submitStep()]);
  await preparedSubmit(allowed, cover);
  allowed.done();
  const trashed = replay([accountStep(supported()), owner(), source({ ...remixable, is_trashed: true })]);
  await safeFailure(trashed.adapter.prepare!(cover, signal()), /does not permit covers/);
  const remaster = replay([accountStep(remasterCatalog()), owner(), source(remixable)]);
  await safeFailure(remaster.adapter.prepare!({ operation: "remaster_music", clipId: C }, signal()), /does not permit remastering/);
});

test("server action visibility and disabled overrides reject otherwise permitted sources before submission", async () => {
  for (const operation of ["cover_music", "remaster_music"] as const) {
    const action_type = operation === "cover_music" ? "remix_cover" : "remaster";
    for (const state of [{ visible: false }, { disabled: true }, { visible: true, disabled: true }]) {
      const h = replay([accountStep(operation === "cover_music" ? supported() : remasterCatalog()), owner(),
        source({ action_config: { actions: [{ action_type, ...state }] } })]);
      await safeFailure(h.adapter.prepare!(operation === "cover_music" ? cover : { operation, clipId: C }, signal()), /does not permit/);
      assert.equal(h.api().length, 3);
      h.done();
    }
  }
});

test("server action entries default to visible while absent entries retain source fallback", async () => {
  for (const operation of ["cover_music", "remaster_music"] as const) {
    const action_type = operation === "cover_music" ? "remix_cover" : "remaster";
    const request: AudioGenerationRequest = operation === "cover_music" ? cover : { operation, clipId: C };
    for (const state of [{}, { disabled: false }, { visible: true }, { visible: true, disabled: false }]) {
      const h = replay([accountStep(operation === "cover_music" ? supported() : remasterCatalog()), owner(),
        source({ user_id: "other-account", action_config: { actions: [{ action_type, ...state }] } }),
        ...(operation === "cover_music" ? [gateStep(), submitStep()] : [{ path: "/api/generate/upsample", value: receipt() }])]);
      assert.equal((await preparedSubmit(h, request)).kind, "task");
      h.done();
    }
    const missing = replay([accountStep(operation === "cover_music" ? supported() : remasterCatalog()), owner(),
      source({ user_id: "other-account", action_config: { actions: [] } })]);
    await safeFailure(missing.adapter.prepare!(request, signal()), /does not permit/);
    missing.done();
    const own = replay([accountStep(operation === "cover_music" ? supported() : remasterCatalog()), owner(),
      source({ action_config: { actions: [{ action_type }] } }),
      ...(operation === "cover_music" ? [gateStep(), submitStep()] : [{ path: "/api/generate/upsample", value: receipt() }])]);
    assert.equal((await preparedSubmit(own, request)).kind, "task");
    own.done();
  }
});

test("website ownership is bound to the authenticated Clerk principal, not a guessed user-ID equivalence", async () => {
  const h = replay([accountStep(supported()), { path: "/api/session/", value: { user: { id: ownerId, clerk_id: "user_other" } } }]);
  await safeFailure(h.adapter.prepare!(cover, signal()), /ownership could not be verified/);
  assert.equal(h.api().length, 2);
});

test("Audio Influence requires a reference and an affirmative control-sliders feature", async () => {
  const plain = replay();
  await safeFailure(plain.adapter.prepare!({ ...MUSIC, options: { mode: "custom", audioInfluence: 25 } }, signal()), /requires a source/);
  assert.equal(plain.requests.length, 0);
  const unsupported = replay([accountStep(supported({ features: [] }))]);
  await safeFailure(unsupported.adapter.prepare!(cover, signal()), /audio-influence support/);
  const persona = replay([accountStep(supported()),
    { path: `/api/persona/get-persona-paginated/${C}/?page=0`, value: { persona: { id: C, name: "Voice" } } }, gateStep(), submitStep()]);
  await preparedSubmit(persona, { ...MUSIC, options: { mode: "custom", personaId: C, audioInfluence: 0 } });
  assert.deepEqual((persona.api().at(-1)!.body as Record<string, any>).metadata.control_sliders, { audio_weight: 0 });
  persona.done();
});

test("Remaster selects its separate catalog and sends the first-party upsample request", async () => {
  const h = replay([accountStep(remasterCatalog()), owner(), source(), { path: "/api/generate/upsample", value: receipt() }], "unrelated-music-model");
  const request: AudioGenerationRequest = { operation: "remaster_music", clipId: C, modelId: remasterModel, variation: "subtle" };
  const result = await preparedSubmit(h, request);
  assert.equal(result.kind, "task");
  assert.deepEqual(h.api().at(-1)!.body, { clip_id: C, model_name: remasterModel, variation_category: "subtle" });
  h.done();
});

test("Remaster requires an available model and rejects unsupported strength evidence", async () => {
  for (const data of [catalog(), catalog([], { remaster_model_types: [] }),
    catalog([], { remaster_model_types: [model({ external_key: remasterModel, can_use: false })] }),
    catalog([], { remaster_model_types: [model({ external_key: "unknown-remaster" })] })]) {
    const h = replay([accountStep(data)]);
    await safeFailure(h.adapter.prepare!({ operation: "remaster_music", clipId: C, variation: "normal" }, signal()));
    assert.equal(h.api().length, 1);
  }
});

test("Remaster preparation uses its endpoint's catalog and source checks without requesting a text-generation challenge", async () => {
  const h = replay([accountStep(remasterCatalog()), owner(), source()]);
  await h.adapter.prepare!({ operation: "remaster_music", clipId: C }, signal());
  assert.deepEqual(h.api().map((entry) => entry.path), ["/api/billing/info/", "/api/session/", `/api/feed/?ids=${C}`]);
  h.done();
});

test("a completed Remaster receipt racing Stop preserves both identities without repeating the charge", async () => {
  const controller = createHostAbortController();
  const h = replay([accountStep(remasterCatalog()), owner(), source(), { path: "/api/generate/upsample", run: async () => {
    controller.abort();
    return Response.json(receipt());
  } }]);
  const request: AudioGenerationRequest = { operation: "remaster_music", clipId: C };
  await h.adapter.prepare!(request, controller.signal);
  const result = await h.adapter.submit(request, controller.signal);
  assert.equal(result.kind, "task");
  if (result.kind === "task") assert.equal(result.expectedOutputs?.length, 2);
  assert.equal(h.api().filter((entry) => entry.path === "/api/generate/upsample").length, 1);
  h.done();
});

test("catalog preserves explicit empty/unknown task evidence and projects a distinct remaster catalog", async () => {
  const h = replay([accountStep({ ...supported(), remaster_model_types: [model({ external_key: remasterModel })] })]);
  const result = await readSunoMusicService(session, { query: "catalog" }, signal(), h.fetchImpl);
  assert.equal(result.query, "catalog");
  if (result.query !== "catalog") return;
  assert.deepEqual(result.models[0]?.capabilities, ["sound", "cover"]);
  assert.deepEqual(result.models[0]?.features, ["create_control_sliders"]);
  assert.deepEqual(result.models[0]?.allowedConditionCombinations, [["cover"], ["extend"]]);
  assert.equal(result.remasterModels?.[0]?.id, remasterModel);
  assert.equal(result.remasterModels?.[0]?.supportsVariation, true);
});
