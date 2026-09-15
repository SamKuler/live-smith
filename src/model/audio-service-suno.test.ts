import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import type { AudioGenerationRequest, AudioJob, RemoteAudioOutput } from "../audio-services/contracts.js";
import { readSunoMusicService, type SunoMusicServiceRequest } from "../audio-services/suno.js";
import { createHostAbortController } from "../runtime/host.js";

import {
  A, B, C, MODEL, accountId, clientToken, session, MUSIC, MANIFEST, single,
  signal, token, model, catalog, clip, downloadPath, receipt, replay, accountStep, gateStep, submitStep,
  pollStep, safeFailure, preparedSubmit,
} from "./audio-service-suno-harness.js";

test("library projection never releases an echoed minted bearer through an opaque cursor", async () => {
  let reflected: string;
  const h = replay([{ path: "/api/feed/v3", run: async () => Response.json({ clips: [], has_more: true, next_cursor: reflected }) }]);
  reflected = h.jwt;
  await assert.rejects(readSunoMusicService(session, { query: "library" }, signal(), h.fetchImpl), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /credential/i);
    assert.ok(!String(error.stack).includes(h.jwt));
    assert.ok(!String(error.stack).includes(clientToken));
    return true;
  });
});

test("prepare selects the catalog default, gates once, and submit sends the complete v2-web envelope", async () => {
  const h = replay([accountStep(), gateStep(), submitStep()]);
  const request = { ...MUSIC };
  const abort = signal();
  await h.adapter.prepare!(request, abort);
  assert.deepEqual(h.api().map((entry) => entry.path), ["/api/billing/info/", "/api/c/check"]);
  assert.deepEqual(await h.adapter.submit(request, abort), { kind: "task", taskId: A, expectedOutputs: MANIFEST });
  assert.equal(h.adapter.provider, "suno");
  assert.equal(h.adapter.cancel, undefined);
  const body = h.api()[2]!.body as Record<string, unknown>;
  const metadata = body.metadata as Record<string, unknown>;
  assert.match(String(body.transaction_uuid), /^[0-9a-f-]{36}$/u);
  assert.match(String(metadata.create_session_token), /^[0-9a-f-]{36}$/u);
  assert.notEqual(body.transaction_uuid, metadata.create_session_token);
  assert.deepEqual(body, {
    token: null, token_provider: null, generation_type: "TEXT", mv: MODEL,
    prompt: "", gpt_description_prompt: MUSIC.prompt, make_instrumental: true, user_uploaded_images_b64: null,
    metadata: { web_client_pathname: "/create", is_max_mode: false, is_mumble: false, create_mode: "simple",
      user_tier: "", create_session_token: metadata.create_session_token, disable_volume_normalization: false },
    override_fields: [], cover_clip_id: null, cover_start_s: null, cover_end_s: null, persona_id: null,
    artist_clip_id: null, artist_start_s: null, artist_end_s: null, continue_clip_id: null,
    continued_aligned_prompt: null, continue_at: null, transaction_uuid: body.transaction_uuid,
  });
  assert.deepEqual(h.api()[1]!.body, { ctype: "generation" });
  let deviceId: string | undefined;
  for (const entry of h.api()) {
    assert.equal(entry.init.redirect, "error");
    assert.equal(entry.init.credentials, "omit");
    assert.equal(entry.init.referrerPolicy, "no-referrer");
    const headers = Object.fromEntries(entry.headers);
    const currentDeviceId = headers["device-id"]!;
    assert.match(currentDeviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    deviceId ??= currentDeviceId;
    assert.equal(currentDeviceId, deviceId);
    assert.deepEqual(headers, {
      accept: "application/json", authorization: `Bearer ${h.jwt}`,
      "browser-token": headers["browser-token"], "device-id": currentDeviceId,
      origin: "https://suno.com", referer: "https://suno.com/",
      ...(entry.init.method === "POST" ? { "content-type": "application/json" } : {}),
    });
    const browser = JSON.parse(headers["browser-token"]!);
    assert.match(browser.token, /^[A-Za-z0-9_-]+$/u);
    assert.equal(typeof JSON.parse(Buffer.from(browser.token, "base64url").toString()).timestamp, "number");
  }
  h.done();
});

test("custom fields, percent sliders and exact existing persona are preserved with a configured usable model", async () => {
  const chosen = "future-catalog-model";
  const h = replay([
    accountStep(catalog([model(), model({ external_key: chosen, is_default_model: false })])),
    { path: `/api/persona/get-persona-paginated/${C}/?page=0`, value: { persona: { id: C, name: "Singer" } } },
    gateStep(), submitStep(receipt([A])),
  ], chosen);
  const request: AudioGenerationRequest = { operation: "generate_music", prompt: "[Verse]\nSing this", durationSeconds: 120,
    instrumental: false, options: { mode: "custom", title: "New song", styles: "folk", negativeStyles: "drums",
      weirdness: 25, styleInfluence: 80, vocalGender: "female", personaId: C } };
  assert.deepEqual(await preparedSubmit(h, request), { kind: "task", taskId: A, expectedOutputs: single });
  const body = h.api().at(-1)!.body as Record<string, unknown>;
  assert.equal(body.mv, chosen);
  assert.equal(body.prompt, request.prompt);
  assert.equal(Object.hasOwn(body, "gpt_description_prompt"), false);
  assert.equal(body.title, "New song");
  assert.equal(body.tags, "folk");
  assert.equal(body.negative_tags, "drums");
  assert.equal(body.persona_id, C);
  assert.equal(body.make_instrumental, false);
  assert.equal(body.duration, 120);
  assert.deepEqual((body.metadata as Record<string, unknown>).control_sliders, { weirdness_constraint: 0.25, style_weight: 0.8 });
  assert.equal((body.metadata as Record<string, unknown>).vocal_gender, "f");
  assert.equal((body.metadata as Record<string, unknown>).create_mode, "custom");
  h.done();
});

test("empty lyrics are accepted for instrumental custom requests and implicitly custom Extend", async () => {
  const h = replay([accountStep(), gateStep(), submitStep()]);
  await preparedSubmit(h, { ...MUSIC, prompt: "", options: { mode: "custom", styles: "jazz" } });
  const extend = replay([accountStep(), pollStep([clip(C)], C), gateStep(), submitStep()]);
  await preparedSubmit(extend, { operation: "extend_music", clipId: C, startSeconds: 0, prompt: "", instrumental: true });
  for (const request of [{ ...MUSIC, prompt: "" }, { ...MUSIC, prompt: "   " },
    { ...MUSIC, prompt: "", instrumental: false, options: { mode: "custom" } }]) {
    const empty = replay();
    await safeFailure(empty.adapter.prepare!(request as AudioGenerationRequest, signal()));
    assert.equal(empty.requests.length, 0);
  }
});

test("local operation and option validation precedes any authentication or paid request", async () => {
  const invalid: unknown[] = [null, {}, { ...MUSIC, durationSeconds: 9 }, { ...MUSIC, durationSeconds: 481 },
    { ...MUSIC, durationSeconds: NaN }, { ...MUSIC, instrumental: "true" },
    { ...MUSIC, operation: "generate_sound_effect", durationSeconds: 3, loop: true },
    { ...MUSIC, operation: "cover" }, { ...MUSIC, prompt: 2 }, { ...MUSIC, prompt: "🎵".repeat(5001) },
    { ...MUSIC, prompt: "x".repeat(3001) }, { ...MUSIC, prompt: "nul\0byte" },
    ...[null, {}, { mode: "simple" }, { mode: "custom", audioInfluence: 10 }, { mode: "custom", vocal_gender: "m" },
      { mode: "custom", vocalGender: "unspecified" },
      { mode: "custom", title: 2 }, { mode: "custom", title: "x".repeat(101) }, { mode: "custom", styles: "x".repeat(1001) },
      ...["title", "styles", "negativeStyles"].map((key) => ({ mode: "custom", [key]: "nul\0byte" })),
      { mode: "custom", personaId: A.toUpperCase().replace("000000000001", "00000000000A") },
      ...[-1, 101, NaN, Infinity, null, "1"].flatMap((value) => [
        { mode: "custom", weirdness: value }, { mode: "custom", styleInfluence: value },
      ])].map((options) => ({ ...MUSIC, options })),
    { operation: "get_whole_song", clipId: "../../" }, { operation: "get_whole_song", clipId: A, prompt: "x" },
    ...[-1, NaN, Infinity, "1"].map((startSeconds) => ({ ...MUSIC, operation: "extend_music", clipId: A, startSeconds })),
    { operation: "extend_music", clipId: A, startSeconds: 1, prompt: "Continue", instrumental: false,
      options: { mode: "custom", personaId: C } },
  ];
  const h = replay();
  for (const request of invalid) await safeFailure(h.adapter.prepare!(request as AudioGenerationRequest, signal()));
  assert.equal(h.requests.length, 0);
});

test("unknown, unusable, duplicate and ambiguous model selections fail before CAPTCHA or generation", async () => {
  for (const [models, configured] of [
    [[], undefined], [[model({ can_use: false })], undefined], [[model({ can_use: "true" })], undefined],
    [[model({ is_default_model: false })], undefined], [[model()], "missing"],
    [[model({ can_use: false })], MODEL], [[model(), model()], MODEL],
    [[model(), model({ external_key: "another-model" })], undefined],
  ] as Array<[unknown[], string | undefined]>) {
    const h = replay([accountStep(catalog(models))], configured);
    await safeFailure(h.adapter.prepare!({ ...MUSIC }, signal()));
    assert.equal(h.api().length, 1);
  }
});

test("requested duration requires current catalog model support", async () => {
  const supported = replay([accountStep(), gateStep(), submitStep()]);
  await preparedSubmit(supported, { ...MUSIC, durationSeconds: 10 });
  assert.equal((supported.api().at(-1)!.body as Record<string, unknown>).duration, 10);
  const unsupported = replay([accountStep(catalog([model({ major_version: 5 })]))]);
  await safeFailure(unsupported.adapter.prepare!({ ...MUSIC, durationSeconds: 10 }, signal()));
  assert.equal(unsupported.api().length, 1);
});

test("catalog character limits count code points and map description versus custom lyrics correctly", async () => {
  const limits = { prompt: 2, gpt_description_prompt: 1, title: 1, tags: 1, negative_tags: 1 };
  const custom: AudioGenerationRequest = { ...MUSIC, prompt: "🎵🎵", options: { mode: "custom", title: "🎵", styles: "🎵", negativeStyles: "🎵" } };
  const h = replay([accountStep(catalog([model({ max_lengths: limits })])), gateStep(), submitStep()]);
  await preparedSubmit(h, custom);
  for (const request of [{ ...MUSIC, prompt: "🎵🎵" }, { ...custom, prompt: "🎵🎵🎵" },
    ...["title", "styles", "negativeStyles"].map((key) => ({ ...custom, options: { ...custom.options, [key]: "🎵🎵" } }))]) {
    const rejected = replay([accountStep(catalog([model({ max_lengths: limits })]))]);
    await safeFailure(rejected.adapter.prepare!(request as AudioGenerationRequest, signal()));
    assert.equal(rejected.api().length, 1);
  }
  for (const value of [-1, 1.5, NaN, "10", null]) {
    const bad = replay([accountStep(catalog([model({ max_lengths: { prompt: value } })]))]);
    await safeFailure(bad.adapter.prepare!({ ...MUSIC }, signal()));
  }
});

test("only explicit required false passes CAPTCHA and unknown/failed checks cannot submit", async () => {
  for (const gate of [{ required: true }, {}, { required: 0 }, { required: "false" }, { required: null },
    { captcha_required: false }, null, [], { required: true, message: `remote-secret ${clientToken}` }]) {
    const h = replay([accountStep(), gateStep(gate)]);
    const request = { ...MUSIC };
    const abort = signal();
    await safeFailure(h.adapter.prepare!(request, abort));
    await safeFailure(h.adapter.submit(request, abort));
    assert.equal(h.api().length, 2);
  }
  for (const status of [401, 403, 404, 429, 500]) {
    const h = replay([accountStep(), { path: "/api/c/check", response: new Response("remote-secret", { status }) }]);
    await safeFailure(h.adapter.prepare!({ ...MUSIC }, signal()));
    assert.equal(h.api().length, 2);
  }
});

test("required human verification without a handler cannot submit", async () => {
  const h = replay([accountStep(), gateStep({ required: true, captcha_version: 2 })]);
  await safeFailure(h.adapter.prepare!({ ...MUSIC }, signal()), /human verification is unavailable\. No generation was submitted\./);
  assert.deepEqual(h.api().map(entry => entry.path), ["/api/billing/info/", "/api/c/check"]);
});

test("a prepared request is bound to its values and cancellation signal, and is consumed once", async () => {
  const h = replay([accountStep(), gateStep(), submitStep()]);
  const request = { ...MUSIC };
  const abort = signal();
  await safeFailure(h.adapter.submit(request, abort));
  assert.equal(h.requests.length, 0);
  await h.adapter.prepare!(request, abort);
  await h.adapter.submit(request, abort);
  await safeFailure(h.adapter.submit(request, abort));
  assert.equal(h.api().length, 3);
  for (const change of ["prompt", "signal", "options"] as const) {
    const other = replay([accountStep(), gateStep()]);
    const mutable = { ...MUSIC, options: { mode: "custom" as const, styles: "jazz" } };
    await other.adapter.prepare!(mutable, abort);
    if (change === "prompt") mutable.prompt = "changed";
    if (change === "options") mutable.options.styles = "changed";
    await safeFailure(other.adapter.submit(mutable, change === "signal" ? signal() : abort));
    assert.equal(other.api().length, 2);
  }
});

test("failed validation invalidates previous preparation even when the caller restores the old parameters", async () => {
  for (const action of ["prepare", "submit"] as const) {
    const h = replay([accountStep(), gateStep()]);
    const request = { ...MUSIC };
    const abort = signal();
    await h.adapter.prepare!(request, abort);
    request.prompt = "invalid\0prompt";
    await safeFailure(h.adapter[action]!(request, abort));
    request.prompt = MUSIC.prompt;
    await safeFailure(h.adapter.submit(request, abort));
    assert.equal(h.api().length, 2);
  }
});

test("mutation or cancellation during preparation never leaves a usable submission", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response>();
  const h = replay([accountStep(), { path: "/api/c/check", run: async () => { started.resolve(); return release.promise; } }]);
  const request = { ...MUSIC };
  const abort = signal();
  const preparing = h.adapter.prepare!(request, abort);
  await started.promise;
  request.prompt = "changed while awaiting gate";
  release.resolve(Response.json({ required: false }));
  await safeFailure(preparing);
  await safeFailure(h.adapter.submit(request, abort));
  const controller = createHostAbortController();
  controller.abort(new Error(clientToken));
  const cancelled = replay();
  await safeFailure(cancelled.adapter.prepare!({ ...MUSIC }, controller.signal));
  assert.equal(cancelled.requests.length, 0);
});

test("extend observes the exact completed source and sends seconds plus custom continuation fields", async () => {
  const h = replay([accountStep(), pollStep([clip(C)], C), gateStep(), submitStep()]);
  await preparedSubmit(h, { operation: "extend_music", clipId: C, startSeconds: 12.5, prompt: "[Chorus]", instrumental: false,
    options: { mode: "custom", styles: "folk" } });
  const body = h.api().at(-1)!.body as Record<string, unknown>;
  assert.equal(body.continue_clip_id, C);
  assert.equal(body.continue_at, 12.5);
  assert.equal(body.make_instrumental, false);
  assert.equal(body.prompt, "[Chorus]");
  assert.equal(body.task, "extend");
  assert.equal((body.metadata as Record<string, unknown>).create_mode, "custom");
  assert.equal((body.metadata as Record<string, unknown>).is_remix, true);
  assert.equal((body.metadata as Record<string, unknown>).lyrics_updated, false);
});

test("extend rejects absent, mismatched, duplicate, unfinished and invalid-duration sources before submit", async () => {
  for (const source of [[], [clip(A)], [clip(C), clip(C)], [clip(C, "streaming")],
    ...[undefined, null, 0, 12, "30", Infinity].map((duration) => [clip(C, "complete", { metadata: { duration } })])]) {
    const h = replay([accountStep(), pollStep(source, C)]);
    await safeFailure(h.adapter.prepare!({ operation: "extend_music", clipId: C, startSeconds: 12, prompt: "Continue", instrumental: true }, signal()));
    assert.equal(h.api().length, 2);
  }
});

test("get whole song acknowledges a single clip and does not read a generation model catalog", async () => {
  const h = replay([pollStep([clip(C, "complete", { metadata: { duration: 30, task: "extend" } })], C), gateStep(),
    { path: "/api/generate/concat/v2/", value: clip(A, "submitted") }]);
  assert.deepEqual(await preparedSubmit(h, { operation: "get_whole_song", clipId: C }), { kind: "task", taskId: A, expectedOutputs: single });
  assert.deepEqual(h.api().at(-1)!.body, { clip_id: C });
});

test("get whole song rejects a completed clip without extension lineage before submission", async () => {
  const h = replay([pollStep([clip(C)], C)]);
  await safeFailure(h.adapter.prepare!({ operation: "get_whole_song", clipId: C }, signal()));
  assert.equal(h.api().length, 1);
});

test("submission receipts require one or two unique canonical UUIDs and never reflect remote messages", async () => {
  for (const value of [null, {}, [], { clips: [] }, receipt([A, B, C]), receipt([A, A]),
    receipt(["arbitrary"]), receipt(["00000000-0000-4000-8000-00000000000A"]),
    { clips: [null] }, { clips: [{ id: clientToken }] },
    { status: "error", clips: [clip(A)], message: `remote-secret ${clientToken}` }]) {
    const h = replay([accountStep(), gateStep(), submitStep(value)]);
    await safeFailure(preparedSubmit(h));
    assert.equal(h.api().length, 3);
  }
});

test("the acknowledged manifest cannot lose a sibling or change a role through caller mutation", async () => {
  const h = replay([accountStep(), gateStep(), submitStep(), pollStep([clip(A), clip(B)])]);
  const result = await preparedSubmit(h);
  assert.ok(result.kind === "task");
  assert.ok(result.expectedOutputs);
  assert.throws(() => result.expectedOutputs!.pop(), TypeError);
  assert.throws(() => { result.expectedOutputs![1]!.key = C; }, TypeError);
  assert.throws(() => { result.expectedOutputs![1]!.role = "music"; }, TypeError);
  const status = await h.adapter.inspect!(result.taskId, signal(), result.expectedOutputs);
  assert.ok(status.status === "completed");
  assert.deepEqual(status.outputs.map(({ key, role }) => ({ key, role })), MANIFEST);
  assert.equal(h.api().at(-1)!.path, `/api/feed/?ids=${A},${B}`);
});

test("an uncertain paid submission is never retried and its preparation cannot be reused", async () => {
  const h = replay([accountStep(), gateStep(), { path: "/api/generate/v2-web/", run: async () => { throw new Error(`remote-secret ${clientToken}`); } }]);
  const request = { ...MUSIC }; const abort = signal();
  await h.adapter.prepare!(request, abort);
  await safeFailure(h.adapter.submit(request, abort));
  await safeFailure(h.adapter.submit(request, abort));
  assert.equal(h.api().length, 3);
});

test("Stop racing a complete paid response preserves its full validated receipt and manifest", async () => {
  const controller = createHostAbortController();
  const h = replay([accountStep(), gateStep(), { path: "/api/generate/v2-web/", run: async () => {
    controller.abort(new Error(clientToken));
    return Response.json(receipt());
  } }]);
  const request = { ...MUSIC };
  await h.adapter.prepare!(request, controller.signal);
  assert.deepEqual(await h.adapter.submit(request, controller.signal), { kind: "task", taskId: A, expectedOutputs: MANIFEST });
  assert.equal(h.api().length, 3);
});

test("Stop cannot turn a malformed paid response into an acknowledged task", async () => {
  const controller = createHostAbortController();
  const h = replay([accountStep(), gateStep(), { path: "/api/generate/v2-web/", run: async () => {
    controller.abort(new Error(clientToken));
    return Response.json({ clips: [{ id: "remote-secret" }] });
  } }]);
  const request = { ...MUSIC };
  await h.adapter.prepare!(request, controller.signal);
  await safeFailure(h.adapter.submit(request, controller.signal));
  assert.equal(h.api().length, 3);
});

test("inspect requires the original sorted UUID and role manifest before any network access", async () => {
  const h = replay();
  for (const manifest of [undefined, [], [MANIFEST[1]], [...MANIFEST].reverse(), [MANIFEST[0], MANIFEST[0]],
    [...MANIFEST, { key: C, role: "music" }], [{ key: A, role: "sound_effect" }], [{ key: "bad", role: "music" }],
    [{ ...MANIFEST[0], url: "https://untrusted.test" }]]) {
    await safeFailure(h.adapter.inspect!(A, signal(), manifest as AudioJob["expectedOutputs"]));
  }
  await safeFailure(h.adapter.inspect!(B, signal(), MANIFEST));
  assert.equal(h.requests.length, 0);
});

test("every acknowledged clip is polled and missing or streaming siblings remain running", async () => {
  const h = replay([pollStep([]), pollStep([clip(A)]), pollStep([clip(B, "streaming"), clip(A)]),
    pollStep([clip(A, "error")]), pollStep([clip(A, "complete"), clip(B, "queued")])]);
  for (let index = 0; index < 5; index++) assert.deepEqual(await h.adapter.inspect!(A, signal(), MANIFEST), { status: "running" });
  assert.ok(h.api().every((entry) => entry.path === `/api/feed/?ids=${A},${B}` && entry.init.method === "GET"));
  h.done();
});

test("reordered final clips retain receipt roles and failed siblings retain their manifest keys", async () => {
  const failed = clip(A, "error", { error_message: `remote-secret ${clientToken}`, metadata: { error_message: clientToken } });
  const h = replay([pollStep([clip(B), clip(A)]), pollStep([failed, clip(B)]), pollStep([clip(A), clip(B, "error")]),
    pollStep([failed, clip(B, "error")])]);
  assert.deepEqual(await h.adapter.inspect!(A, signal(), MANIFEST), { status: "completed", outputs: [
    { ...MANIFEST[0], url: downloadPath(A) }, { ...MANIFEST[1], url: downloadPath(B) },
  ] });
  assert.deepEqual(await h.adapter.inspect!(A, signal(), MANIFEST), { status: "completed", outputs: [
    { ...MANIFEST[1], url: downloadPath(B) },
  ], failedOutputKeys: [A] });
  assert.deepEqual(await h.adapter.inspect!(A, signal(), MANIFEST), { status: "completed", outputs: [
    { ...MANIFEST[0], url: downloadPath(A) },
  ], failedOutputKeys: [B] });
  const allFailed = await h.adapter.inspect!(A, signal(), MANIFEST);
  assert.equal(allFailed.status, "failed");
  assert.doesNotMatch(JSON.stringify(allFailed), /remote-secret|error_message/u);
  assert.ok(!JSON.stringify(allFailed).includes(clientToken));
});

test("polling rejects extra identities, duplicates, invalid statuses and malformed envelopes", async () => {
  for (const value of [null, {}, { clips: [clip(A)] }, [clip(C)], [clip(A), clip(A)],
    [clip(A), clip(B), clip(C)], [null], ...["", " ", "x".repeat(65), "nul\0byte", 42, null]
      .map((status) => [clip(A, "complete", { status })])]) {
    const h = replay([pollStep(value)]);
    await safeFailure(h.adapter.inspect!(A, signal(), MANIFEST));
    assert.equal(h.api().length, 1);
  }
  const h = replay([pollStep([clip(A, "future-state"), clip(B)]), pollStep([clip(A, "COMPLETE"), clip(B)])]);
  for (let index = 0; index < 2; index++) assert.deepEqual(await h.adapter.inspect!(A, signal(), MANIFEST), { status: "running" });
});

test("download accepts only a locator bound to its exact clip ID before any network call", async () => {
  for (const url of [undefined, "", "https://untrusted.test/a.mp3", "http://cdn1.suno.ai/a.mp3",
    `https://cdn1.suno.ai/${A}.mp3`, downloadPath(B), `${downloadPath(A)}&unlock=true`,
    downloadPath(A).replace("mp3", "wav"), "/api/download/authorize"]) {
    const h = replay();
    await safeFailure(h.adapter.download!({ key: A, role: "music", url } as RemoteAudioOutput, signal()));
    assert.equal(h.requests.length, 0);
  }
});

test("complete but download-locked clips do not prevent discovering a successful sibling", async () => {
  const locked = clip(A, "complete", { is_download_unlocked: false, audio_url: "https://studio-api.prod.suno.com/api/forbidden" });
  const h = replay([pollStep([locked, clip(B)]), pollStep([locked], A)]);
  const status = await h.adapter.inspect!(A, signal(), MANIFEST);
  assert.deepEqual(status, { status: "completed", outputs: MANIFEST.map(entry => ({ ...entry, url: downloadPath(entry.key) })) });
  if (status.status !== "completed") return;
  await safeFailure(h.adapter.download!(status.outputs[0]!, signal()), /download.*locked/);
  assert.equal(h.api().length, 2);
  assert.ok(h.api().every(entry => entry.init.method === "GET" && entry.path.startsWith("/api/feed/")));
  h.done();
});

test("download rechecks exact completed clip identity and explicit download permission", async () => {
  for (const value of [[], [clip(B)], [clip(A), clip(A)], [clip(A, "streaming")],
    ...[undefined, false, null, "true"].map(is_download_unlocked => [clip(A, "complete", { is_download_unlocked })])]) {
    const h = replay([pollStep(value, A)]);
    await safeFailure(h.adapter.download!({ ...MANIFEST[0]!, url: downloadPath() }, signal()));
    assert.equal(h.api().length, 1);
    h.done();
  }
});

test("authorized MP3 preparation resolves approved CDN URLs and never sends credentials to media", async () => {
  for (const host of ["cdn1.suno.ai", "cdn2.suno.ai", "cdn.suno.ai", "suno-data-uploads.s3.amazonaws.com"]) {
    const url = `https://${host}/${A}.mp3`;
    const h = replay([pollStep([clip(A)], A), pollStep([clip(A)], A),
      { path: downloadPath(), value: { ok: true, status: "ready", download_url: url } },
      { path: url, response: new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } }) }]);
    const status = await h.adapter.inspect!(A, signal(), single);
    assert.equal(status.status, "completed");
    if (status.status !== "completed") return;
    assert.equal(status.outputs[0]!.url, downloadPath());
    assert.deepEqual(Array.from(await h.adapter.download!(status.outputs[0]!, signal())), [1]);
    assert.ok(h.api().every(entry => entry.init.method === "GET"));
    assert.deepEqual(Object.fromEntries(h.requests.at(-1)!.headers), { accept: "audio/mpeg, audio/wav, application/octet-stream" });
    h.done();
  }
});

test("prepared downloads reject invalid responses and untrusted URLs without falling back to audio_url", async () => {
  for (const value of [null, {}, { ok: false, status: "ready", download_url: `https://cdn1.suno.ai/${A}.mp3` },
    { ok: true, status: "error", detail: `remote-secret ${clientToken}` },
    { ok: true, status: "future-state" },
    ...[undefined, "", "http://cdn1.suno.ai/a.mp3", "https://untrusted.test/a.mp3",
      "https://cdn1.suno.ai.evil.test/a.mp3", "https://user:pass@cdn1.suno.ai/a.mp3",
      "https://cdn1.suno.ai:444/a.mp3", "https://cdn1.suno.ai/a.mp3#fragment",
      "https://cdn1.suno.ai/a%0db.mp3", `https://cdn1.suno.ai/${clientToken}.mp3`,
    ].map(download_url => ({ ok: true, status: "ready", download_url }))]) {
    const h = replay([pollStep([clip(A)], A), { path: downloadPath(), value }]);
    await safeFailure(h.adapter.download!({ ...MANIFEST[0]!, url: downloadPath() }, signal()));
    assert.equal(h.api().length, 2);
    h.done();
  }
  const h = replay([pollStep([clip(A)], A), { path: downloadPath(), run: async () => Response.json({
    ok: true, status: "ready", download_url: `https://cdn1.suno.ai/${A}.mp3?secret=${encodeURIComponent(h.jwt)}`,
  }) }]);
  await safeFailure(h.adapter.download!({ ...MANIFEST[0]!, url: downloadPath() }, signal()));
});

test("MP3 preparation waits for its existing file without submitting generation or download authorization", async () => {
  const url = `https://cdn1.suno.ai/${A}.mp3`;
  const h = replay([pollStep([clip(A)], A),
    { path: downloadPath(), value: { ok: true, status: "processing" } },
    { path: downloadPath(), value: { ok: true, status: "ready", download_url: url } },
    { path: url, response: new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } }) }]);
  await h.adapter.download!({ ...MANIFEST[0]!, url: downloadPath() }, signal());
  assert.ok(h.api().every(entry => entry.init.method === "GET"));
  h.done();
});

test("download preparation honors cancellation and its API deadline without leaking reasons", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  for (const mode of ["stop", "deadline"]) {
    const started = Promise.withResolvers<void>();
    const controller = createHostAbortController();
    const h = replay([pollStep([clip(A)], A), { path: downloadPath(), run: async () => {
      started.resolve();
      return new Promise<Response>(() => {});
    } }]);
    const pending = h.adapter.download!({ ...MANIFEST[0]!, url: downloadPath() }, controller.signal);
    await started.promise;
    if (mode === "stop") controller.abort(new Error(clientToken));
    else t.mock.timers.tick(120_000);
    await safeFailure(pending, mode === "stop" ? /cancelled/ : /request timed out/);
    assert.equal(h.api().length, 2);
    assert.equal(h.api().at(-1)!.init.signal?.aborted, true);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("library download permission preserves true, false and unknown evidence", async () => {
  for (const evidence of [true, false, undefined, null, "true"]) {
    const h = replay([{ path: "/api/feed/v3", value: {
      clips: [clip(A, "complete", { is_download_unlocked: evidence })], has_more: false,
    } }]);
    const result = await readSunoMusicService(session, { query: "library" }, signal(), h.fetchImpl);
    assert.ok(result.query === "library");
    assert.equal(result.clips[0]!.downloadUnlocked, typeof evidence === "boolean" ? evidence : undefined);
    assert.equal(Object.hasOwn(result.clips[0]!, "downloadUnlocked"), typeof evidence === "boolean");
  }
});

test("catalog projection keeps bounded model evidence and omits account metadata, URLs and credentials", async () => {
  const h = replay([accountStep(catalog([model({ name: `Model ${clientToken} https://untrusted.test/a`,
    api_key: "remote-secret", description: "remote-secret" })], { authorization: clientToken, user: { email: "private@example.test" } }))]);
  const result = await readSunoMusicService(session, { query: "catalog" }, signal(), h.fetchImpl);
  assert.equal(result.query, "catalog");
  if (result.query !== "catalog") return;
  assert.deepEqual(result.models[0]?.maxLengths, model().max_lengths);
  assert.equal(result.models[0]?.supportsDuration, true);
  assert.equal(result.models[0]?.canUse, true);
  assert.equal(result.models[0]?.id, MODEL);
  assert.equal(result.creditsLeft, 123);
  assert.doesNotMatch(JSON.stringify(result), /remote-secret|untrusted\.test|private@example|authorization/u);
  assert.ok(!JSON.stringify(result).includes(clientToken));
});

test("library captures bounded cursor search and returns only sanitized clip fields", async () => {
  const h = replay([{ path: "/api/feed/v3", value: {
    clips: [clip(A, "complete", { title: "T".repeat(300), metadata: { duration: 10, tags: `jazz ${clientToken} https://untrusted.test`,
      prompt: "private lyrics", error_message: "remote-secret", has_stem: true, can_remix: false, make_instrumental: true },
      user_id: "unrelated-account", cookie: clientToken })], has_more: true, next_cursor: "next-page_2==",
  } }]);
  const result = await readSunoMusicService(session, { query: "library", search: "jazz", cursor: "previous-page==" }, signal(), h.fetchImpl);
  assert.deepEqual(h.api()[0]!.body, { limit: 20, cursor: "previous-page==", filters: { trashed: "False", searchText: "jazz" } });
  assert.equal(result.query, "library");
  if (result.query !== "library") return;
  assert.equal(result.clips[0]?.title.length, 160);
  assert.equal(result.clips[0]?.id, A);
  assert.equal(result.clips[0]?.durationSeconds, 10);
  assert.equal(result.clips[0]?.hasStems, true);
  assert.equal(result.clips[0]?.canRemix, false);
  assert.equal(result.nextCursor, "next-page_2==");
  assert.doesNotMatch(JSON.stringify(result), /https:|untrusted\.test|private lyrics|remote-secret|unrelated-account|audio_url/u);
  assert.ok(!JSON.stringify(result).includes(clientToken));
});

test("library has one-page bounds, exact IDs and finite cursor progress", async () => {
  const values = [
    { clips: Array.from({ length: 21 }, () => clip()), has_more: false },
    { clips: [clip(), clip()], has_more: false }, { clips: [clip("bad-id")], has_more: false },
    { clips: [], has_more: true }, { clips: [], has_more: "false" }, { clips: [], has_more: true, next_cursor: "same" },
    ...["x".repeat(2049), clientToken, "line\nbreak"].map((next_cursor) => ({ clips: [], has_more: true, next_cursor })),
  ];
  for (const value of values) {
    const h = replay([{ path: "/api/feed/v3", value }]);
    await safeFailure(readSunoMusicService(session, { query: "library", cursor: "same" }, signal(), h.fetchImpl));
    assert.equal(h.api().length, 1);
  }
  const h = replay([{ path: "/api/feed/v3", value: { clips: [], has_more: false, next_cursor: null } }]);
  assert.deepEqual(await readSunoMusicService(session, { query: "library" }, signal(), h.fetchImpl), { query: "library", clips: [], hasMore: false });
  assert.deepEqual(h.api()[0]!.body, { limit: 20, filters: { trashed: "False" } });
});

test("a full library page bounds each safe display field and cannot reflect provider or query-only fields", async () => {
  const clips = Array.from({ length: 20 }, (_, index) => clip(`00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, "complete", {
    title: `${clientToken} https://untrusted.test/a ${"🎵".repeat(300)}`,
    model_name: "M".repeat(300), metadata: { tags: `Bearer remote-secret\n${"j".repeat(1000)}`, duration: 12,
      prompt: "private-lyrics", token: clientToken },
    raw_provider_error: "remote-secret", url: "https://untrusted.test/a", accountId, search: "private-search",
  }));
  const h = replay([{ path: "/api/feed/v3", value: { query: "provider-secret", clips, has_more: false,
    search: "private-search", cursor: "private-cursor", authorization: clientToken, message: "remote-secret" } }]);
  const result = await readSunoMusicService(session, { query: "library" }, signal(), h.fetchImpl);
  assert.ok("clips" in result);
  assert.deepEqual(Object.keys(result).sort(), ["clips", "hasMore", "query"]);
  assert.equal(result.clips.length, 20);
  for (const item of result.clips) {
    assert.deepEqual(Object.keys(item).sort(), ["downloadUnlocked", "durationSeconds", "id", "modelId", "status", "styles", "title"]);
    assert.ok(Array.from(item.title).length <= 160);
    assert.ok(Array.from(item.styles).length <= 500);
    assert.ok(Array.from(item.modelId).length <= 128);
  }
  assert.doesNotMatch(JSON.stringify(result), /remote-secret|https:|untrusted\.test|private-|provider-secret|user_synthetic/u);
  assert.ok(!JSON.stringify(result).includes(clientToken));
});

test("persona lookup checks its exact ID and excludes clips, image URLs and unbounded metadata", async () => {
  const path = `/api/persona/get-persona-paginated/${C}/?page=0`;
  const h = replay([{ path, value: { persona: { id: C, name: "Persona", description: "D".repeat(1000),
    persona_clips: [clip()], image_s3_id: "https://untrusted.test", secret: clientToken } } }]);
  assert.deepEqual(await readSunoMusicService(session, { query: "persona", personaId: C }, signal(), h.fetchImpl), {
    query: "persona", persona: { id: C, name: "Persona", description: "D".repeat(500) },
  });
  const wrong = replay([{ path, value: { persona: { id: A, name: "Wrong" } } }]);
  await safeFailure(readSunoMusicService(session, { query: "persona", personaId: C }, signal(), wrong.fetchImpl));
});

test("invalid read parameters and unsupported query modes perform no HTTP requests", async () => {
  const h = replay();
  for (const request of [null, {}, { query: "all" }, { query: "persona" }, { query: "persona", personaId: "../" },
    { query: "catalog", cursor: "x" }, { query: "library", personaId: C }, { query: "library", url: "https://untrusted.test" },
    ...["x".repeat(201), "a\nb", clientToken, 5].map((search) => ({ query: "library", search })),
    ...["x".repeat(2049), "a\nb", clientToken, 5].map((cursor) => ({ query: "library", cursor }))]) {
    await safeFailure(readSunoMusicService(session, request as SunoMusicServiceRequest, signal(), h.fetchImpl));
  }
  assert.equal(h.requests.length, 0);
});

test("catalog distinguishes missing availability from explicit false and preserves ordinary dotted names", async () => {
  const h = replay([accountStep(catalog([
    model({ external_key: "unknown-model", can_use: undefined, name: "sam.kuler.music" }),
    model({ external_key: "disabled-model", can_use: false }),
  ]))]);
  const result = await readSunoMusicService(session, { query: "catalog" }, signal(), h.fetchImpl);
  assert.ok("models" in result);
  assert.equal(Object.hasOwn(result.models[0]!, "canUse"), false);
  assert.equal(result.models[1]!.canUse, false);
  assert.equal(result.models[0]!.name, "sam.kuler.music");
  const unknown = replay([accountStep(catalog([model({ can_use: undefined })]))]);
  await safeFailure(unknown.adapter.prepare!({ ...MUSIC }, signal()));
  assert.equal(unknown.api().length, 1);
});

test("opaque cursor bytes are preserved up to the ASCII bound, including JWT-shaped provider cursors", async () => {
  const cursor = token({ cursor: "opaque-provider-page" });
  const nextCursor = "x".repeat(2048);
  const h = replay([{ path: "/api/feed/v3", value: { clips: [], has_more: true, next_cursor: nextCursor } }]);
  const result = await readSunoMusicService(session, { query: "library", cursor }, signal(), h.fetchImpl);
  assert.ok("clips" in result);
  assert.deepEqual(result.clips, []);
  assert.equal(result.nextCursor, nextCursor);
  assert.equal((h.api()[0]!.body as Record<string, unknown>).cursor, cursor);
});
