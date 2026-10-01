import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { ReadableStream } from "node:stream/web";
import test from "node:test";
import { createSunoAudioAdapter } from "../../../src/audio-services/suno/suno.js";
import { downloadSunoClip, sunoDownloadPath } from "../../../src/audio-services/suno/suno-download.js";
import { createSunoHttp } from "../../../src/audio-services/suno/suno-http.js";
import { createHostAbortController } from "../../../src/runtime/host.js";

const API = "https://studio-api-prod.suno.com";
const QUERY = "?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0";
const CLIENT = `https://auth.suno.com/v1/client${QUERY}`;
const MINT = `https://auth.suno.com/v1/client/sessions/sess_fixture/tokens${QUERY}`;
const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const FEED = `/api/feed/?ids=${A}`;
const AUTHORIZE = "/api/download/authorize";
const PREPARE = sunoDownloadPath(A);
const MEDIA = "https://suno-data-uploads.s3.amazonaws.com/prepared-fixture.mp3?Signature=fixture";
const FORBIDDEN = `${API}/api/forbidden`;
const output = { key: A, role: "music" as const, url: PREPARE };
const token = (claims: object) => [JSON.stringify({ alg: "RS256" }), JSON.stringify(claims), "synthetic-signature"]
  .map(part => Buffer.from(part).toString("base64url")).join(".");
const session = { clientToken: token({ sub: "client_fixture" }), accountId: "user_fixture" };
const signal = () => createHostAbortController().signal;
const clip = (is_download_unlocked: unknown = false, extra: object = {}) => ({
  id: A, status: "complete", is_download_unlocked, audio_url: FORBIDDEN, ...extra,
});
type Step = { path: string; value?: unknown; run?: () => Response | Promise<Response> };
const feed = (value: unknown = [clip()]): Step => ({ path: FEED, value });
const authorization = (value: unknown = { ok: true }): Step => ({ path: AUTHORIZE, value });
const prepared = (value: unknown = { ok: true, status: "ready", download_url: MEDIA }): Step => ({ path: PREPARE, value });
const media = (): Step => ({ path: MEDIA, run: () => new Response(new Uint8Array([1, 2, 3]), {
  headers: { "content-type": "audio/mpeg" },
}) });

function replay(steps: Step[], authorizeDownloads?: boolean) {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const pending = [...steps];
  const jwt = token({ sub: session.accountId, sid: "sess_fixture", exp: Math.floor(Date.now() / 1000) + 3600 });
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    const path = String(url).startsWith(API) ? String(url).slice(API.length) : String(url);
    calls.push({ path, init });
    if (url === CLIENT) return Response.json({ response: {
      object: "client", last_active_session_id: "sess_fixture", sessions: [{ object: "session", id: "sess_fixture",
        status: "active", expire_at: Date.now() + 600_000, user: { object: "user", id: session.accountId } }],
    } });
    if (url === MINT) return Response.json({ jwt });
    const step = pending.shift();
    assert.ok(step, `unexpected request ${path}`);
    assert.equal(path, step.path);
    return step.run ? step.run() : Response.json(step.value);
  };
  const options = { fetchImpl, ...(authorizeDownloads === undefined ? {} : { authorizeDownloads }) };
  return { adapter: createSunoAudioAdapter(session, options), http: createSunoHttp(session, fetchImpl), options, calls,
    api: () => calls.filter(call => call.path.startsWith("/api/")),
    done: () => assert.equal(pending.length, 0),
  };
}

function safeFailure(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.match(error.message, /^Suno\.com audio service:/u);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(error.message, /resum/iu);
  assert.doesNotMatch(String(error.stack), /remote-secret|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u);
  return true;
}

test("locked downloads require explicit true in both adapter and helper, with no authorization POST by default", async () => {
  for (const flag of [undefined, false, "true", 1, {}]) {
    const h = replay([feed()], flag as boolean);
    await assert.rejects(h.adapter.download!(output, signal()), error => {
      assert.match((error as Error).message, /Use Download for this song and confirm/u);
      return safeFailure(error);
    });
    assert.deepEqual(h.api().map(call => [call.path, call.init.method]), [[FEED, "GET"]]);
    h.done();
  }
  const h = replay([feed()]);
  await assert.rejects(downloadSunoClip(h.http, A, signal()), safeFailure);
  assert.deepEqual(h.api().map(call => [call.path, call.init.method]), [[FEED, "GET"]]);
});

test("explicit download authorizes the exact locked clip once, rechecks permission, then downloads only prepared MP3", async () => {
  for (const helper of [false, true]) {
    const h = replay([feed(), authorization(), feed([clip(true)]), prepared(), media()], true);
    const bytes = helper ? await downloadSunoClip(h.http, A, signal(), true) : await h.adapter.download!(output, signal());
    assert.deepEqual(Array.from(bytes), [1, 2, 3]);
    assert.deepEqual(h.api().map(call => [call.path, call.init.method]), [
      [FEED, "GET"], [AUTHORIZE, "POST"], [FEED, "GET"], [PREPARE, "GET"],
    ]);
    assert.deepEqual(JSON.parse(String(h.api()[1]!.init.body)), { item_id: A, item_type: "clip" });
    for (const { init } of h.api()) {
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      assert.equal(init.referrerPolicy, "no-referrer");
      assert.equal(new Headers(init.headers).get("Cookie"), null);
      assert.match(new Headers(init.headers).get("Authorization")!, /^Bearer /u);
    }
    assert.deepEqual(Object.fromEntries(new Headers(h.calls.at(-1)!.init.headers)), {
      accept: "audio/mpeg, audio/wav, application/octet-stream",
    });
    assert.equal(h.calls.at(-1)!.path, MEDIA);
    h.done();
  }
});

test("already unlocked and repeated downloads recheck feed without charging again, even with forbidden playback URLs", async () => {
  const h = replay([feed(), authorization(), feed([clip(true)]), prepared(), media(),
    feed([clip(true)]), prepared(), media()], true);
  for (let attempt = 0; attempt < 2; attempt++) await h.adapter.download!(output, signal());
  assert.equal(h.api().filter(call => call.init.method === "POST").length, 1);
  h.done();
  const unlocked = replay([feed([clip(true)]), prepared(), media()], true);
  await unlocked.adapter.download!(output, signal());
  assert.ok(unlocked.api().every(call => call.init.method === "GET"));
  unlocked.done();
});

test("adapter snapshots download authority and ignores later option mutation", async () => {
  const h = replay([feed()], false);
  h.options.authorizeDownloads = true;
  await assert.rejects(h.adapter.download!(output, signal()), safeFailure);
  assert.equal(h.api().length, 1);
  const authorized = replay([feed(), authorization(), feed([clip(true)]), prepared(), media()], true);
  authorized.options.authorizeDownloads = false;
  await authorized.adapter.download!(output, signal());
  authorized.done();
});

test("malformed permissions, incomplete sources, wrong IDs and duplicate feed entries never authorize", async () => {
  for (const value of [null, {}, [], [null], [clip(false, { id: B })], [clip(), clip()],
    [clip(false, { status: "streaming" })], [clip(false, { status: "error" })],
    [clip(false, { id: "00000000-0000-4000-8000-00000000000A" })],
    ...[undefined, null, "false", "true", 0, 1, {}, []].map(permission => [clip(false, { is_download_unlocked: permission })])]) {
    const h = replay([feed(value)], true);
    await assert.rejects(h.adapter.download!(output, signal()), safeFailure);
    assert.deepEqual(h.api().map(call => [call.path, call.init.method]), [[FEED, "GET"]]);
    h.done();
  }
});

test("failed or missing authorization receipts cannot advance to permission checks or be retried", async () => {
  for (const value of [null, [], {}, { ok: false }, { ok: "true" }, { ok: 1 }, { success: true },
    { ok: false, message: `remote-secret ${session.clientToken}` }]) {
    const h = replay([feed(), authorization(value)], true);
    await assert.rejects(h.adapter.download!(output, signal()), safeFailure);
    assert.deepEqual(h.api().map(call => call.path), [FEED, AUTHORIZE]);
    h.done();
  }
});

test("a receipt requires fresh exact complete unlocked evidence; revoked, missing and duplicate permissions stop without a second POST", async () => {
  for (const value of [null, {}, [], [clip()], [clip(true, { id: B })], [clip(true), clip(true)],
    [clip(true, { status: "streaming" })], [clip(true, { status: "error" })],
    ...[undefined, null, "true", 1].map(permission => [clip(false, { is_download_unlocked: permission })])]) {
    const h = replay([feed(), authorization(), feed(value)], true);
    await assert.rejects(h.adapter.download!(output, signal()), safeFailure);
    assert.deepEqual(h.api().map(call => call.path), [FEED, AUTHORIZE, FEED]);
    assert.equal(h.api().filter(call => call.init.method === "POST").length, 1);
    h.done();
  }
});

test("authorization rejects malformed JSON, failed HTTP and unknown network outcomes without automatic retries or sensitive errors", async () => {
  const replies: Array<() => Response | Promise<Response>> = [
    ...[401, 403, 429, 500, 302, 204].map(status => () => new Response(status === 204 ? null : "remote-secret", { status })),
    () => new Response("{remote-secret", { headers: { "content-type": "application/json" } }),
    () => new Response("remote-secret", { headers: { "content-type": "text/html" } }),
    () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "1048577" } }),
    () => { throw new Error(session.clientToken, { cause: new Error("remote-secret") }); },
  ];
  for (const run of replies) {
    const h = replay([feed(), { path: AUTHORIZE, run }], true);
    await assert.rejects(h.adapter.download!(output, signal()), safeFailure);
    assert.deepEqual(h.api().map(call => call.path), [FEED, AUTHORIZE]);
    h.done();
  }
});

test("permission revoked by preparation and rejected media never trigger another authorization or playback fallback", async () => {
  for (const step of [prepared({ ok: false, status: "ready", download_url: MEDIA }),
    { path: PREPARE, run: () => new Response("remote-secret", { status: 403 }) },
    ...[FORBIDDEN, "https://cdn1.suno.ai.evil.test/file.mp3", "https://other-bucket.s3.amazonaws.com/file.mp3"]
      .map(download_url => prepared({ ok: true, status: "ready", download_url }))]) {
    const h = replay([feed(), authorization(), feed([clip(true)]), step], true);
    await assert.rejects(h.adapter.download!(output, signal()), safeFailure);
    assert.deepEqual(h.api().map(call => call.path), [FEED, AUTHORIZE, FEED, PREPARE]);
    h.done();
  }
  const h = replay([feed(), authorization(), feed([clip(true)]), prepared(),
    { path: MEDIA, run: () => new Response("remote-secret", { status: 403 }) }], true);
  await assert.rejects(h.adapter.download!(output, signal()), safeFailure);
  assert.equal(h.api().filter(call => call.init.method === "POST").length, 1);
  h.done();
});

test("only the fixed authorization route and exact canonical clip body can reach HTTP", async () => {
  const h = replay([]);
  const body = { item_id: A, item_type: "clip" };
  for (const path of [`${AUTHORIZE}/`, `${AUTHORIZE}?retry=true`, `${AUTHORIZE}#fragment`, `${AUTHORIZE}\n`,
    "/api/download/purchase", "/api/download/topup", "/api/download/top-up", "/api/billing/purchase", "/api/billing/topup"]) {
    await assert.rejects(h.http.request("POST", path, body, signal()), safeFailure);
  }
  await assert.rejects(h.http.request("GET", AUTHORIZE, undefined, signal()), safeFailure);
  for (const value of [undefined, null, [], {}, { item_id: A }, { item_type: "clip" },
    { ...body, item_type: "album" }, { ...body, item_id: B.toUpperCase().replace(/2$/u, "A") },
    ...["../", `${A},${B}`, `${A}\n`, A.replace("-4000-", "-0000-"), A.replace("-8000-", "-0000-"), 1, [A]]
      .map(item_id => ({ ...body, item_id })),
    { ...body, force: true }, { ...body, quantity: 2 }, { ...body, format: "mp3" }, { ...body, token: session.clientToken }]) {
    await assert.rejects(h.http.request("POST", AUTHORIZE, value, signal()), safeFailure);
  }
  assert.equal(h.calls.length, 0);
});

test("explicit authority does not authorize on inspect and rejects forged output locators before network", async () => {
  const h = replay([feed()], true);
  assert.deepEqual(await h.adapter.inspect!(A, signal(), [{ key: A, role: "music" }]), {
    status: "completed", outputs: [output],
  });
  for (const value of [{ ...output, key: B }, { ...output, url: FORBIDDEN },
    { ...output, url: sunoDownloadPath(B) }, { ...output, role: "vocals" as const }]) {
    await assert.rejects(h.adapter.download!(value, signal()), safeFailure);
  }
  assert.deepEqual(h.api().map(call => [call.path, call.init.method]), [[FEED, "GET"]]);
});

test("selected-output collection accepts only key/role and verifies the exact complete clip before its guard", async () => {
  let guards = 0;
  const selected = { key: A, role: "music" as const };
  for (const value of [[], [clip(true, { id: B })], [clip(true), clip(true)], [clip(true, { status: "streaming" })]]) {
    const h = replay([feed(value)], true);
    await assert.rejects(h.adapter.downloadSelected!(selected, signal(), async (_signal, authorize) => {
      guards++; return authorize();
    }), safeFailure);
    h.done();
  }
  assert.equal(guards, 0);
  const h = replay([feed(), authorization(), feed([clip(true)]), prepared(), media()], true);
  const bytes = await h.adapter.downloadSelected!(selected, signal(), async (_signal, authorize) => {
    guards++;
    assert.deepEqual(h.api().map(call => call.path), [FEED]);
    return authorize();
  });
  assert.deepEqual(Array.from(bytes), [1, 2, 3]);
  assert.equal(guards, 1);
  h.done();
});

test("Stop, two-minute API deadlines and the ten-minute download deadline never reauthorize", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  for (const mode of ["stop", "deadline"]) for (let stage = 0; stage < 5; stage++) {
    const controller = createHostAbortController();
    const started = Promise.withResolvers<void>();
    const steps = [feed(), authorization(), feed([clip(true)]), prepared(), media()].slice(0, stage + 1);
    for (const step of steps.slice(0, -1)) step.run = () => {
      t.mock.timers.tick(20_000);
      return Response.json(step.value);
    };
    steps.at(-1)!.run = () => { started.resolve(); return new Promise<Response>(() => {}); };
    const h = replay(steps, true);
    const pending = h.adapter.download!(output, controller.signal);
    await started.promise;
    const requestSignal = h.calls.at(-1)!.init.signal;
    if (mode === "stop") controller.abort(new Error(session.clientToken));
    else {
      const remaining = stage === 4 ? 600_000 - stage * 20_000 : 120_000;
      t.mock.timers.tick(remaining - 1);
      assert.equal(requestSignal?.aborted, false);
      t.mock.timers.tick(1);
    }
    await assert.rejects(pending, error => {
      safeFailure(error);
      assert.match((error as Error).message, mode === "stop" ? /cancelled/u : stage === 4
        ? /download timed out.*Retry Download for this song/u : /request timed out/u);
      if (mode === "stop") assert.equal((error as Error).name, "AbortError");
      return true;
    });
    assert.equal(requestSignal?.aborted, true);
    assert.deepEqual(h.calls.slice(2).map(call => call.path), steps.map(step => step.path));
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    h.done();
  }
});

test("Stop during authorization or revalidation headers and EOF never reaches preparation or another POST", async () => {
  for (const when of ["headers", "eof"]) for (const revalidate of [false, true]) {
    const controller = createHostAbortController();
    const value = revalidate ? [clip(true)] : { ok: true };
    const step: Step = { path: revalidate ? FEED : AUTHORIZE, run: () => {
      if (when === "headers") {
        controller.abort(new Error(session.clientToken));
        return Response.json(value);
      }
      let pulls = 0;
      return new Response(new ReadableStream<Uint8Array>({ pull(stream) {
        if (++pulls === 1) stream.enqueue(Buffer.from(JSON.stringify(value)));
        else { stream.close(); controller.abort(new Error(session.clientToken)); }
      } }, { highWaterMark: 0 }) as unknown as BodyInit, { headers: { "content-type": "application/json" } });
    } };
    const h = replay([feed(), ...(revalidate ? [authorization()] : []), step], true);
    await assert.rejects(h.adapter.download!(output, controller.signal), error => {
      assert.equal((error as Error).name, "AbortError"); return safeFailure(error);
    });
    assert.deepEqual(h.api().map(call => call.path), revalidate ? [FEED, AUTHORIZE, FEED] : [FEED, AUTHORIZE]);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    h.done();
  }
});

test("Stop and timeout require full authorization receipt EOF and bound stalled media bodies", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  for (const mode of ["stop", "deadline"]) for (const transfer of [false, true]) {
    const controller = createHostAbortController();
    const reading = Promise.withResolvers<void>();
    let pulls = 0; let cancels = 0;
    const stalled: Step = { path: transfer ? MEDIA : AUTHORIZE, run: () => new Response(new ReadableStream<Uint8Array>({
      pull(stream) {
        if (++pulls === 1) stream.enqueue(transfer ? new Uint8Array([1, 2, 3]) : Buffer.from('{"ok":true}'));
        else reading.resolve();
      },
      cancel() { cancels++; return new Promise<void>(() => {}); },
    }, { highWaterMark: 0 }) as unknown as BodyInit, {
      headers: { "content-type": transfer ? "audio/mpeg" : "application/json" },
    }) };
    const h = replay([feed(), ...(transfer ? [authorization(), feed([clip(true)]), prepared()] : []), stalled], true);
    const pending = h.adapter.download!(output, controller.signal);
    await reading.promise;
    if (mode === "stop") controller.abort(new Error(session.clientToken));
    else t.mock.timers.tick(transfer ? 600_000 : 120_000);
    await assert.rejects(pending, safeFailure);
    assert.equal(cancels, 1);
    assert.equal(h.api().filter(call => call.init.method === "POST").length, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    h.done();
  }
});

test("Stop cleans up a late authorization response and pre-cancelled downloads make no requests", async () => {
  const controller = createHostAbortController();
  controller.abort(new Error(session.clientToken));
  const cancelled = replay([], true);
  await assert.rejects(cancelled.adapter.download!(output, controller.signal), safeFailure);
  assert.equal(cancelled.calls.length, 0);
  const stop = createHostAbortController();
  const started = Promise.withResolvers<void>();
  const late = Promise.withResolvers<Response>();
  const h = replay([feed(), { path: AUTHORIZE, run: () => { started.resolve(); return late.promise; } }], true);
  const pending = h.adapter.download!(output, stop.signal);
  await started.promise;
  stop.abort(new Error(session.clientToken));
  await assert.rejects(pending, safeFailure);
  const bodyCancelled = Promise.withResolvers<void>();
  late.resolve(new Response(new ReadableStream({ cancel() { bodyCancelled.resolve(); } }) as unknown as BodyInit));
  await bodyCancelled.promise;
  assert.deepEqual(h.api().map(call => call.path), [FEED, AUTHORIZE]);
  h.done();
});

test("explicit retry after an uncertain authorization skips charging when fresh feed is unlocked", async () => {
  const h = replay([feed(), { path: AUTHORIZE, run: () => { throw new Error("remote-secret"); } },
    feed([clip(true)]), prepared(), media()], true);
  await assert.rejects(h.adapter.download!(output, signal()), safeFailure);
  assert.deepEqual(h.api().map(call => call.path), [FEED, AUTHORIZE]);
  await h.adapter.download!(output, signal());
  assert.equal(h.api().filter(call => call.init.method === "POST").length, 1);
  h.done();
});

test("preparation polling after explicit authorization never repeats the allowance request", async () => {
  const h = replay([feed(), authorization(), feed([clip(true)]), prepared({ ok: true, status: "processing" }),
    prepared(), media()], true);
  await h.adapter.download!(output, signal());
  assert.deepEqual(h.api().map(call => [call.path, call.init.method]), [
    [FEED, "GET"], [AUTHORIZE, "POST"], [FEED, "GET"], [PREPARE, "GET"], [PREPARE, "GET"],
  ]);
  h.done();
});

test("download recovery errors direct the user to the selected song Download action", async () => {
  for (const steps of [
    [feed([clip(false, { is_download_unlocked: undefined })])],
    [feed(), authorization({ ok: false })],
    [feed(), authorization(), feed()],
    [feed([clip(true)]), prepared({ ok: false })],
    [feed([clip(true)]), prepared({ ok: true, status: "error" })],
    [feed([clip(true)]), { path: PREPARE, run: () => new Response("remote-secret", { status: 403 }) }],
    [feed([clip(true)]), prepared(), { path: MEDIA, run: () => new Response("remote-secret", { status: 403 }) }],
  ]) {
    const h = replay(steps, true);
    await assert.rejects(h.adapter.download!(output, signal()), error => {
      assert.match((error as Error).message, /Download for this song/u); return safeFailure(error);
    });
    h.done();
  }
});
