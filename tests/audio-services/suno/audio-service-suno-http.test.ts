import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { ReadableStream } from "node:stream/web";
import test from "node:test";

import { MAX_AUDIO_ASSET_BYTES } from "../../../src/audio-services/contracts.js";
import { createSunoHttp } from "../../../src/audio-services/suno/suno-http.js";
import { createSunoSessionVerifier } from "../../../src/audio-services/suno/suno-session.js";
import { createHostAbortController } from "../../../src/runtime/host.js";

const CLIENT = "https://auth.suno.com/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0";
const MINT = "https://auth.suno.com/v1/client/sessions/sess_selected/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0";
const API = "https://studio-api-prod.suno.com";
const AUDIO = "https://cdn1.suno.ai/00000000-0000-4000-8000-000000000001.mp3";
const ID = "00000000-0000-4000-8000-000000000001";
const jwt = (claims: unknown, header: unknown = { alg: "RS256", typ: "JWT" }) =>
  [Buffer.from(JSON.stringify(header)), Buffer.from(JSON.stringify(claims)), Buffer.from("synthetic-signature")]
    .map((part) => part.toString("base64url")).join(".");
const clientToken = jwt({ sub: "client_synthetic" });
const credentials = { clientToken, accountId: "user_selected" };
const signal = () => createHostAbortController().signal;
const claims = () => ({ sub: "user_selected", sid: "sess_selected", exp: Math.floor(Date.now() / 1000) + 3600 });
const clientResponse = (accountId = "user_selected", sessionId = "sess_selected") => ({
  response: { object: "client", last_active_session_id: sessionId, sessions: [{
    object: "session", id: sessionId, status: "active", expire_at: Date.now() + 60_000,
    user: { object: "user", id: accountId },
  }] },
});
const json = (value: string, headers: Record<string, string> = {}) => new Response(value, {
  headers: { "content-type": "application/json", ...headers },
});
const audio = () => new Response(Buffer.from([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
function safeFailure(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.cause, undefined);
  assert.match(error.message, /^Suno\.com audio service:/u);
  assert.doesNotMatch(String(error.stack), /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u);
  for (const secret of [clientToken, jwt(claims()), "remote-secret", "private-query"]) {
    assert.ok(!String(error.stack).includes(secret));
  }
  return true;
}

type Call = { url: string; init: RequestInit | undefined };
function harness(reply: (call: Call) => Response | Promise<Response> = () => Response.json({ clips: [] }),
  identity: () => unknown = clientResponse, mint: () => unknown = () => ({ jwt: jwt(claims()) })) {
  const calls: Call[] = [];
  const minted: unknown[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const call = { url: String(url), init }; calls.push(call);
    if (call.url === CLIENT) return Response.json(identity());
    if (call.url === MINT) {
      const value = mint(); minted.push((value as { jwt?: unknown }).jwt);
      return Response.json(value);
    }
    return reply(call);
  };
  return { http: createSunoHttp(credentials, fetcher), calls, fetcher, minted };
}

test("public verification exposes only account identity and a private refreshed session value", async () => {
  const { fetcher } = harness();
  const verified = await createSunoSessionVerifier(fetcher)(clientToken, signal());
  assert.equal(verified.accountId, "user_selected");
  assert.match(verified.sessionValue ?? "", new RegExp(`^__client=${clientToken}; ajs_anonymous_id=[0-9a-f-]{36}$`, "u"));
});

test("HTTP rejection preserves its numeric status without provider body or automatic retry", async () => {
  for (const status of [400, 402, 422, 429, 500, 503]) {
    const h = harness(() => new Response("remote-secret", { status }));
    await assert.rejects(h.http.request("POST", "/api/generate/v2-web/", { prompt: "fixture" }, signal()), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`HTTP ${status}\\b`));
      return safeFailure(error);
    });
    assert.equal(h.calls.filter(call => call.url.startsWith(API)).length, 1);
  }
});

test("generation validation diagnostics retain field/type, never the rejected input or server dump", async () => {
  const h = harness(() => Response.json({ detail: [{
    type: "missing", loc: ["body", "token_provider"], msg: "remote-secret",
    input: { prompt: "private prompt", authorization: clientToken }, ctx: { error: "remote-secret" },
  }] }, { status: 422 }));
  await assert.rejects(h.http.request("POST", "/api/generate/v2-web/", { prompt: "private prompt" }, signal()), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 422/u);
    assert.match(error.message, /body\.token_provider: missing/u);
    assert.doesNotMatch(error.message, /private prompt|authorization|input|ctx/u);
    return safeFailure(error);
  });
  assert.equal(h.calls.filter(call => call.url.startsWith(API)).length, 1);
});

test("structured provider diagnostics exclude arbitrary prose, escaped secrets and request dumps", async () => {
  const prompt = "private\nlyrics";
  const message = `${clientToken.replaceAll(".", "\\u002e")}; prompt=${JSON.stringify(prompt)}; ` +
    '{"api_key":"synthetic-provider-key"}; debug_context=synthetic-dump';
  const diagnostic = { code: "invalid_request", type: "validation_error" };
  for (const payload of [
    { error: { ...diagnostic, message } },
    { ...diagnostic, detail: message, debug: "remote-secret", request: { prompt } },
    { detail: { ...diagnostic, message } },
  ]) {
    const h = harness(() => Response.json(payload, { status: 400 }));
    await assert.rejects(h.http.request("POST", "/api/generate/v2-web/", { prompt }, signal()), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /code=invalid_request; type=validation_error/u);
      assert.doesNotMatch(error.message, /private|lyrics|example\.test|debug|eyJ|synthetic-provider-key/u);
      return safeFailure(error);
    });
  }
});

test("received HTTP rejection survives Stop or the request deadline during diagnostic reading", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  for (const stop of [true, false]) {
    const started = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<void>();
    const headers = Promise.withResolvers<Response>();
    const controller = createHostAbortController();
    let cancelled = false;
    const h = harness(() => { started.resolve(); return headers.promise; });
    const pending = h.http.request("POST", "/api/generate/v2-web/", {}, controller.signal);
    await started.promise;
    if (!stop) t.mock.timers.tick(119_990);
    headers.resolve(new Response(new ReadableStream({
      pull() { reading.resolve(); return new Promise<void>(() => {}); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }, { highWaterMark: 0 }) as unknown as BodyInit, { status: 422, headers: { "content-type": "application/json" } }));
    await reading.promise;
    if (stop) controller.abort(new Error("remote-secret"));
    t.mock.timers.tick(stop ? 25 : 10);
    await assert.rejects(pending, error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 422/u);
      assert.doesNotMatch(error.message, /timed out|request cancelled/u);
      return safeFailure(error);
    });
    assert.equal(cancelled, true);
    assert.equal(h.calls.filter(call => call.url.startsWith(API)).length, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("malformed, oversized and stalled error JSON preserve the HTTP rejection without retry", async () => {
  for (const reply of [
    () => new Response("{", { status: 422, headers: { "content-type": "application/json" } }),
    () => Response.json({ detail: "x".repeat(70_000) }, { status: 422 }),
    () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }) as unknown as BodyInit,
      { status: 422, headers: { "content-type": "application/json" } }),
  ]) {
    const h = harness(reply);
    await assert.rejects(h.http.request("POST", "/api/generate/v2-web/", {}, signal()), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 422/u);
      assert.ok(error.message.length < 900);
      return safeFailure(error);
    });
    assert.equal(h.calls.filter(call => call.url.startsWith(API)).length, 1);
  }
});

test("one exact account session mints a bounded bearer, cached only in the client instance", async () => {
  const state = harness(() => Response.json({ total_credits_left: 10 }));
  assert.deepEqual(await state.http.request("GET", "/api/billing/info/", undefined, signal()), { total_credits_left: 10 });
  await state.http.request("POST", "/api/feed/v3", { limit: 20 }, signal());
  assert.deepEqual(state.calls.map(({ url }) => url), [CLIENT, MINT, `${API}/api/billing/info/`, `${API}/api/feed/v3`]);
  let deviceId: string | undefined;
  for (const call of state.calls) {
    assert.equal(call.init?.redirect, "error");
    assert.equal(call.init?.credentials, "omit");
    assert.equal(call.init?.referrerPolicy, "no-referrer");
    const headers = new Headers(call.init?.headers);
    for (const key of ["user-agent", "x-suno-client", "sec-ch-ua"]) assert.equal(headers.get(key), null);
    if (call.url.startsWith(API)) {
      assert.equal(headers.get("Authorization"), `Bearer ${state.minted[0]}`);
      assert.equal(headers.get("Cookie"), null);
      assert.equal(headers.get("Origin"), "https://suno.com");
      assert.equal(headers.get("Referer"), "https://suno.com/");
      const currentDeviceId = headers.get("Device-Id")!;
      assert.match(currentDeviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      deviceId ??= currentDeviceId;
      assert.equal(currentDeviceId, deviceId);
      const browser = JSON.parse(headers.get("Browser-Token")!);
      assert.equal(typeof browser.token, "string");
      assert.match(browser.token, /^[A-Za-z0-9_-]+$/u);
      assert.equal(typeof JSON.parse(Buffer.from(browser.token, "base64url").toString()).timestamp, "number");
    } else {
      assert.equal(headers.get("Authorization"), clientToken);
      assert.equal(headers.get("Cookie"), `__client=${clientToken}`);
      assert.equal(headers.get("Browser-Token"), null);
      assert.equal(headers.get("Device-Id"), null);
    }
  }
  assert.equal(state.calls[1]?.init?.method, "POST");
  assert.equal(state.calls[1]?.init?.body, "");
  assert.equal(new Headers(state.calls[1]?.init?.headers).get("Content-Type"), "application/x-www-form-urlencoded");
  assert.equal(state.calls[2]?.init?.body, undefined);
  assert.equal(state.calls[3]?.init?.body, '{"limit":20}');
  await createSunoHttp(credentials, state.fetcher).request("GET", "/api/billing/info/", undefined, signal());
  assert.equal(state.calls.filter(({ url }) => url === MINT).length, 2);
});

test("a generated device identity is reported for private atomic persistence before API use", async () => {
  const state = harness(() => Response.json({ total_credits_left: 10 }));
  const rotations: Array<{ previous: string; next: string }> = [];
  const http = createSunoHttp(credentials, state.fetcher, async (previous, next, refreshSignal) => {
    assert.equal(refreshSignal.aborted, false);
    rotations.push({ previous, next });
  });
  await http.request("GET", "/api/billing/info/", undefined, signal());
  assert.equal(rotations.length, 1);
  assert.equal(rotations[0]!.previous, `__client=${clientToken}`);
  assert.match(rotations[0]!.next, new RegExp(`^__client=${clientToken}; ajs_anonymous_id=[0-9a-f-]{36}$`, "u"));
  assert.equal(state.calls.filter(({ url }) => url.startsWith(API)).length, 1);
});

test("credential admission is bounded and snapshots the exact supplied connection", async () => {
  for (const value of [null, {}, { ...credentials, clientToken: "remote-secret" },
    { ...credentials, clientToken: `__client=${clientToken}; __client=${clientToken}` },
    { ...credentials, accountId: "invalid/account" }, { ...credentials, accountId: "user_selected\n" }]) {
    assert.throws(() => createSunoHttp(value as typeof credentials), safeFailure);
  }
  const state = harness();
  const mutable = { ...credentials };
  const http = createSunoHttp(mutable, state.fetcher);
  mutable.clientToken = "remote-secret"; mutable.accountId = "user_other";
  await http.request("GET", "/api/billing/info/", undefined, signal());
  assert.equal(new Headers(state.calls[0]?.init?.headers).get("Authorization"), clientToken);
});

test("account mismatch or ambiguous selection fails before API access", async () => {
  for (const value of [clientResponse("user_other"), clientResponse("user_selected", "sess_selected\n"),
    { response: { ...clientResponse().response, last_active_session_id: null } },
    { response: { ...clientResponse().response, sessions: [] } },
    { response: { ...clientResponse().response, sessions: [...clientResponse().response.sessions, ...clientResponse().response.sessions] } }]) {
    const state = harness(undefined, () => value);
    await assert.rejects(state.http.request("GET", "/api/billing/info/", undefined, signal()), safeFailure);
    assert.equal(state.calls.filter(({ url }) => url.startsWith(API)).length, 0);
    assert.ok(state.calls.length === 1 || state.calls.length === 2);
  }
});

test("minted JWT must bind sub, sid and a short future expiry with bounded canonical encoding", async () => {
  const badTokens: unknown[] = [undefined, null, 1, "remote-secret", clientToken, "a.b.c", `${jwt(claims())}=`,
    ` ${jwt(claims())}`, `__client=${jwt(claims())}`, jwt({ ...claims(), sub: "user_other" }),
    jwt({ ...claims(), sid: "sess_other" }), jwt({ sub: "user_selected", sid: "sess_selected" }),
    jwt({ ...claims(), exp: String(claims().exp) }), jwt({ ...claims(), exp: Date.now() }),
    jwt({ ...claims(), exp: Math.floor(Date.now() / 1000) - 1 }),
    jwt({ ...claims(), exp: claims().exp + 0.5 }), jwt({ ...claims(), exp: claims().exp + 3600 }),
    jwt(claims(), { alg: "none" }), jwt(claims(), { alg: "HS256" }),
    jwt({ ...claims(), padding: "a".repeat(9000) })];
  for (const token of badTokens) {
    const state = harness(undefined, undefined, () => ({ jwt: token }));
    await assert.rejects(state.http.request("GET", "/api/billing/info/", undefined, signal()), safeFailure);
    assert.equal(state.calls.length, 2);
  }
});

test("expiry revalidates identity and refresh never switches to another active session", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  let selected = "sess_selected";
  const state = harness(undefined, () => clientResponse("user_selected", selected));
  await state.http.request("GET", "/api/billing/info/", undefined, signal());
  t.mock.timers.tick(31 * 60_000);
  await state.http.request("GET", "/api/billing/info/", undefined, signal());
  assert.equal(state.calls.filter(({ url }) => url === MINT).length, 2);
  selected = "sess_other";
  t.mock.timers.tick(31 * 60_000);
  await assert.rejects(state.http.request("POST", "/api/generate/v2-web/", {}, signal()), safeFailure);
  assert.equal(state.calls.filter(({ url }) => url === MINT).length, 2);
  assert.equal(state.calls.filter(({ url }) => url.startsWith(API)).length, 2);
});

test("only the enumerated method and route pairs reach the API", async () => {
  const state = harness();
  const routes: ["GET" | "POST", string][] = [
    ["GET", "/api/billing/info/"], ["GET", `/api/feed/?ids=${ID},${ID}`],
    ["GET", `/api/download/clip/${ID}?format=mp3`],
    ["GET", `/api/persona/get-persona-paginated/${ID}/?page=0`],
    ["GET", `/api/persona/get-persona-paginated/${ID}/?page=12`],
    ["POST", "/api/feed/v3"], ["POST", "/api/c/check"],
    ["POST", "/api/generate/v2-web/"], ["POST", "/api/generate/concat/v2/"],
  ];
  for (const [method, path] of routes) await state.http.request(method, path, method === "POST" ? {} : undefined, signal());
  assert.equal(state.calls.length, routes.length + 2);
});

test("unlisted routes, query injection, malformed or oversized ID lists fail before authentication", async () => {
  const paths = ["https://example.test/", "//example.test/", "/api/billing/info/?x=1", "/api/billing/info",
    "/api/../api/billing/info/", "/api/%62illing/info/", "/api/billing/info/#fragment", "/api/billing/info/\n",
    "/api/playlist/me", "/api/session/?secret=1", "/api/project/me", `/api/gen/${ID}/set_visibility/`,
    "/api/download/authorize", `/api/download/clip/${ID}`, `/api/download/clip/${ID}?format=wav`,
    `/api/download/clip/${ID}?format=mp3&unlock=true`, `/api/download/clip/${ID}/?format=mp3`,
    "/api/feed/", "/api/feed/?ids=", "/api/feed/?ids=not-a-uuid", `/api/feed/?ids=${ID}&page=1`,
    `/api/feed/?ids=${ID}%2C${ID}`, `/api/feed/?ids=${ID}\n`, `/api/feed/?ids=${Array(51).fill(ID).join(",")}`,
    `/api/persona/get-persona-paginated/${ID}/?page=-1`, `/api/persona/get-persona-paginated/${ID}/?page=01`,
    `/api/persona/get-persona-paginated/${ID}/?page=10000`, `/api/persona/get-persona-paginated/${ID}/?page=0&x=1`,
    `/api/persona/get-persona-paginated/${ID}/?page=0\n`];
  const state = harness();
  for (const path of paths) await assert.rejects(state.http.request("GET", path, undefined, signal()), safeFailure);
  for (const [method, path] of [["POST", "/api/billing/info/"], ["GET", "/api/feed/v3"], ["GET", "/api/c/check"],
    ["GET", "/api/generate/v2-web/"], ["DELETE", "/api/feed/v3"], ["POST", "/api/download/authorize"],
    ["POST", `/api/download/clip/${ID}?format=mp3`]]) {
    await assert.rejects(state.http.request(method as "GET", path!, undefined, signal()), safeFailure);
  }
  assert.equal(state.calls.length, 0);
});

test("request JSON rejects cycles, unsupported values, dangerous keys and oversized data before network", async () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const state = harness();
  for (const body of [cycle, { n: Infinity }, { n: NaN }, { n: 1n }, { n: undefined },
    { n: () => {} }, { n: new Date() }, JSON.parse('{"__proto__":{}}'),
    { constructor: {} }, { text: "x".repeat(1024 * 1024) }, Array(40_000).fill(0)]) {
    await assert.rejects(state.http.request("POST", "/api/generate/v2-web/", body, signal()), safeFailure);
  }
  await assert.rejects(state.http.request("GET", "/api/billing/info/", {}, signal()), safeFailure);
  assert.equal(state.calls.length, 0);
});

test("paid POST responses and transport failures are never retried or echoed", async () => {
  for (const status of [401, 403, 429, 500, 302, 204]) {
    let cancelled = false;
    const state = harness(() => new Response(status === 204 ? null : new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(`remote-secret ${clientToken}`)); },
      cancel() { cancelled = true; },
    }) as unknown as BodyInit, { status, headers: { location: "https://example.test/" } }));
    await assert.rejects(state.http.request("POST", "/api/generate/v2-web/", {}, signal()), (error) => {
      safeFailure(error);
      if (status === 401) assert.match((error as Error).message, /session expired/u);
      if (status === 403) assert.match((error as Error).message, /verification required/u);
      return true;
    });
    assert.equal(state.calls.filter(({ url }) => url.startsWith(API)).length, 1);
    if (status !== 204) assert.equal(cancelled, true);
  }
  const state = harness(() => { throw new Error(clientToken, { cause: new Error("remote-secret") }); });
  await assert.rejects(state.http.request("POST", "/api/generate/concat/v2/", {}, signal()), safeFailure);
  assert.equal(state.calls.length, 3);
});

test("authentication HTTP failures discard raw bodies and never proceed to a paid POST", async () => {
  for (const stage of [CLIENT, MINT]) for (const status of [401, 403, 429, 500]) {
    const calls: string[] = [];
    const http = createSunoHttp(credentials, async (url) => {
      calls.push(String(url));
      if (url === stage) return new Response(`remote-secret ${clientToken}`, { status });
      assert.equal(url, CLIENT); return Response.json(clientResponse());
    });
    await assert.rejects(http.request("POST", "/api/generate/v2-web/", {}, signal()), safeFailure);
    assert.equal(calls.length, stage === CLIENT ? 1 : 2);
  }
});

test("a rejected cached token is reminted only on the next explicit request", async () => {
  let reject = true;
  const state = harness(() => reject ? new Response("remote-secret", { status: 401 }) : Response.json({ clips: [] }));
  await assert.rejects(state.http.request("POST", "/api/generate/v2-web/", {}, signal()), safeFailure);
  assert.equal(state.calls.length, 3);
  reject = false;
  await state.http.request("GET", "/api/billing/info/", undefined, signal());
  assert.equal(state.calls.filter(({ url }) => url === MINT).length, 2);
});

test("JSON responses are bounded UTF-8 JSON with depth, node, finite-number and key constraints", async () => {
  const values = ["remote-secret", "", "1e999", '{"constructor":{}}', '{"__proto__":{}}',
    `${"[".repeat(34)}0${"]".repeat(34)}`, JSON.stringify(Array(40_000).fill(0)), " ".repeat(1024 * 1024 + 1)];
  for (const value of values) {
    const state = harness(() => json(value));
    await assert.rejects(state.http.request("GET", "/api/billing/info/", undefined, signal()), safeFailure);
  }
  for (const response of [new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } }),
    new Response("{}", { headers: { "content-type": "text/html" } }), json("{}", { "content-length": "1048577" }),
    json("{}", { "content-length": "-1" }), json("{}", { "content-length": "3" })]) {
    await assert.rejects(harness(() => response).http.request("GET", "/api/billing/info/", undefined, signal()), safeFailure);
  }
  assert.deepEqual(await harness(() => json('[{"id":"ok"}]')).http.request("GET", `/api/feed/?ids=${ID}`, undefined, signal()), [{ id: "ok" }]);
});

test("token mint responses have a separate 64 KiB budget and a strict envelope", async () => {
  for (const response of [json(" ".repeat(64 * 1024 + 1)), json("{}", { "content-length": "65537" }),
    Response.json({ response: { jwt: jwt(claims()) } }), Response.json([]), json('{"jwt":1}'),
    json(`{"jwt":"${jwt(claims())}","__proto__":{}}`)]) {
    let calls = 0;
    const http = createSunoHttp(credentials, async () => ++calls === 1 ? Response.json(clientResponse()) : response);
    await assert.rejects(http.request("GET", "/api/billing/info/", undefined, signal()), safeFailure);
    assert.equal(calls, 2);
  }
});

test("redirected or mismatched response URLs fail at token, API and download boundaries", async () => {
  for (const stage of [MINT, `${API}/api/billing/info/`, AUDIO]) for (const property of ["redirected", "url"]) {
    const http = createSunoHttp(credentials, async (url) => {
      if (url === CLIENT) return Response.json(clientResponse());
      const response = url === AUDIO ? audio() : Response.json(url === MINT ? { jwt: jwt(claims()) } : {});
      if (url === stage) Object.defineProperty(response, property, { value: property === "url" ? "https://example.test/" : true });
      return response;
    });
    await assert.rejects(stage === AUDIO ? http.download(AUDIO, signal()) :
      http.request("GET", "/api/billing/info/", undefined, signal()), safeFailure);
  }
});

test("media downloads are unauthenticated, instance-independent reads on exact approved HTTPS hosts", async () => {
  const state = harness(({ url }) => url.startsWith(API) ? Response.json({}) : audio());
  for (const host of ["cdn1.suno.ai", "cdn2.suno.ai", "cdn.suno.ai", "suno-data-uploads.s3.amazonaws.com"]) {
    assert.deepEqual(await state.http.download(`https://${host}/file.mp3?Signature=signed-asset`, signal()), Buffer.from([1, 2, 3]));
  }
  assert.equal(state.calls.length, 4);
  for (const call of state.calls) {
    assert.equal(call.init?.method, "GET");
    assert.equal(call.init?.credentials, "omit");
    assert.equal(call.init?.redirect, "error");
    assert.equal(call.init?.referrerPolicy, "no-referrer");
    assert.deepEqual([...new Headers(call.init?.headers).keys()], ["accept"]);
  }
  await state.http.request("GET", "/api/billing/info/", undefined, signal());
  await state.http.download(AUDIO, signal());
  assert.deepEqual([...new Headers(state.calls.at(-1)?.init?.headers).keys()], ["accept"]);
});

test("download URLs reject other hosts, authority tricks, non-HTTPS and credential echoes before Fetch", async () => {
  const state = harness(() => audio());
  for (const value of ["http://cdn1.suno.ai/file.mp3", "//cdn1.suno.ai/file.mp3", "file:///tmp/file.mp3",
    "https://other-bucket.s3.amazonaws.com/file.mp3", "https://suno-data-uploads.s3.amazonaws.com.evil.test/file.mp3",
    "https://suno-data-uploads.s3.amazonaws.com@evil.test/file.mp3", "https://suno-data-uploads.s3.amazonaws.com:444/file.mp3",
    "https://cdn1.suno.ai.evil.test/file.mp3", "https://sub.cdn1.suno.ai/file.mp3", "https://cdn1.suno.ai./file.mp3",
    "https://127.0.0.1/file.mp3", "https://cdn1.suno.ai:8443/file.mp3", "https://user@cdn1.suno.ai/file.mp3",
    "https://cdn1.suno.ai@evil.test/file.mp3", "https://cdn1.suno.ai\\@evil.test/file.mp3",
    "https://cdn1.suno.ai/", `${AUDIO}#fragment`, `${AUDIO}?x=%0a`, `${AUDIO}?x=%5c`, `${AUDIO}?x=%zz`,
    `${AUDIO}?token=${clientToken}`, `${AUDIO}?token=${clientToken.replaceAll(".", "%2E")}`, "https://cdn1.suno.ai/" + "x".repeat(4096)]) {
    await assert.rejects(state.http.download(value, signal()), safeFailure);
  }
  assert.equal(state.calls.length, 0);
  const ready = harness(() => Response.json({}));
  await ready.http.request("GET", "/api/billing/info/", undefined, signal());
  await assert.rejects(ready.http.download(`${AUDIO}?token=${ready.minted[0]}`, signal()), safeFailure);
  assert.equal(ready.calls.length, 3);
});

test("audio byte limit applies to both advertised and actual streamed lengths", async () => {
  for (const response of [new Response("abc", { headers: { "content-type": "audio/mpeg", "content-length": String(MAX_AUDIO_ASSET_BYTES + 1) } }),
    new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_AUDIO_ASSET_BYTES + 1)); } }) as unknown as BodyInit,
      { headers: { "content-type": "audio/mpeg" } }),
    new Response("{}", { headers: { "content-type": "application/json" } }),
    new Response("abc", { status: 206, headers: { "content-type": "audio/mpeg" } }),
    new Response("abc", { headers: { "content-type": "audio/mpeg", "content-length": "2" } }),
    new Response(null, { headers: { "content-type": "audio/mpeg" } })]) {
    await assert.rejects(harness(() => response).http.download(AUDIO, signal()), safeFailure);
  }
});

test("trusted local adapter diagnostics retain their useful detail without duplicated message registration", () => {
  const state = harness();
  for (const detail of ["source clip is unavailable.", "all generated clips failed.",
    "the configured model or an unambiguous usable default is unavailable.",
    "access denied or verification required; complete verification on Suno.com."]) {
    const error = state.http.fail(detail);
    assert.equal(error.message, `Suno.com audio service: ${detail}`);
    safeFailure(error);
  }
});

test("pre-cancelled operations never expose abort reasons or reach Fetch", async () => {
  const state = harness();
  const controller = createHostAbortController(); controller.abort(new Error(clientToken));
  await assert.rejects(state.http.request("GET", "/api/billing/info/", undefined, controller.signal), safeFailure);
  await assert.rejects(state.http.download(AUDIO, controller.signal), safeFailure);
  assert.equal(state.calls.length, 0);
});

test("cancellation settles ignored Fetch aborts at every network stage and cleans up late bodies", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  for (const stage of [CLIENT, MINT, `${API}/api/generate/v2-web/`, AUDIO]) {
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Response>();
    const controller = createHostAbortController();
    let requestSignal: AbortSignal | null | undefined;
    const http = createSunoHttp(credentials, async (url, init) => {
      if (url === stage) { requestSignal = init?.signal; started.resolve(); return late.promise; }
      if (url === CLIENT) return Response.json(clientResponse());
      assert.equal(url, MINT); return Response.json({ jwt: jwt(claims()) });
    });
    const pending = stage === AUDIO ? http.download(AUDIO, controller.signal) :
      http.request("POST", "/api/generate/v2-web/", {}, controller.signal);
    await started.promise;
    controller.abort(new Error("remote-secret"));
    if (stage === `${API}/api/generate/v2-web/`) t.mock.timers.tick(3000);
    await assert.rejects(pending, (error) => { assert.equal((error as Error).name, "AbortError"); return safeFailure(error); });
    assert.equal(requestSignal?.aborted, true);
    const cancelled = Promise.withResolvers<void>();
    late.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve(); } }) as unknown as BodyInit));
    await cancelled.promise;
  }
});

test("Stop racing a complete response or EOF retains JSON only for paid submission routes", async () => {
  for (const when of ["headers", "eof"]) for (const path of ["/api/generate/v2-web/", "/api/generate/concat/v2/",
    "/api/billing/info/", "/api/feed/v3", "/api/c/check"]) {
    const controller = createHostAbortController();
    const receipt = { clips: [{ id: ID }] };
    const bytes = Buffer.from(JSON.stringify(receipt));
    const state = harness(() => {
      if (when === "headers") { controller.abort(new Error(clientToken)); return Response.json(receipt); }
      let pulls = 0;
      return new Response(new ReadableStream<Uint8Array>({ pull(stream) {
        if (++pulls === 1) stream.enqueue(bytes);
        else { stream.close(); controller.abort(new Error(clientToken)); }
      } }, { highWaterMark: 0 }) as unknown as BodyInit, { headers: { "content-type": "application/json" } });
    });
    const paid = path === "/api/generate/v2-web/" || path === "/api/generate/concat/v2/";
    const method = path === "/api/billing/info/" ? "GET" : "POST";
    const result = state.http.request(method, path, method === "POST" ? {} : undefined, controller.signal);
    if (paid) assert.deepEqual(await result, receipt);
    else await assert.rejects(result, (error) => { assert.equal((error as Error).name, "AbortError"); return safeFailure(error); });
    assert.equal(controller.signal.aborted, true);
    assert.equal(state.calls.filter(({ url }) => url.startsWith(API)).length, 1);
  }
});

test("Stop during identity or mint response never continues authentication or starts generation", async () => {
  for (const stage of [CLIENT, MINT]) {
    const controller = createHostAbortController();
    const calls: string[] = [];
    const http = createSunoHttp(credentials, async (url) => {
      calls.push(String(url));
      if (url === stage) controller.abort(new Error(clientToken));
      return Response.json(url === CLIENT ? clientResponse() : { jwt: jwt(claims()) });
    });
    await assert.rejects(http.request("POST", "/api/generate/v2-web/", {}, controller.signal), safeFailure);
    assert.deepEqual(calls, stage === CLIENT ? [CLIENT] : [CLIENT, MINT]);
  }
});

test("paid receipt grace accepts completion before three seconds and removes both deadlines", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  const controller = createHostAbortController();
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const state = harness(() => { started.resolve(); return response.promise; });
  const result = state.http.request("POST", "/api/generate/v2-web/", {}, controller.signal);
  await started.promise;
  controller.abort(new Error(clientToken));
  t.mock.timers.tick(2999);
  assert.equal(state.calls.at(-1)?.init?.signal?.aborted, false);
  const receipt = { clips: [{ id: ID }] };
  response.resolve(Response.json(receipt));
  assert.deepEqual(await result, receipt);
  t.mock.timers.tick(120_000);
  assert.equal(state.calls.at(-1)?.init?.signal?.aborted, false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(state.calls.length, 3);
});

test("paid receipt grace is capped by the original deadline and requires actual EOF", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  for (const age of [0, 119_000]) {
    const reading = Promise.withResolvers<void>();
    const controller = createHostAbortController();
    let pulls = 0; let cancels = 0;
    const state = harness(() => new Response(new ReadableStream<Uint8Array>({ pull(stream) {
      if (++pulls === 1) stream.enqueue(Buffer.from(JSON.stringify({ clips: [{ id: ID }] })));
      else reading.resolve();
    }, cancel() { cancels++; } }, { highWaterMark: 0 }) as unknown as BodyInit,
    { headers: { "content-type": "application/json" } }));
    const pending = state.http.request("POST", "/api/generate/concat/v2/", {}, controller.signal);
    await reading.promise;
    t.mock.timers.tick(age); controller.abort(new Error(clientToken));
    const remaining = Math.min(3000, 120_000 - age);
    t.mock.timers.tick(remaining - 1);
    assert.equal(state.calls.at(-1)?.init?.signal?.aborted, false);
    t.mock.timers.tick(1);
    await assert.rejects(pending, (error) => { assert.equal((error as Error).name, "AbortError"); return safeFailure(error); });
    assert.equal(cancels, 1);
    assert.equal(state.calls.length, 3);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("paid receipt grace still rejects malformed, oversized and unsuccessful responses", async () => {
  for (const response of [json("{"), json("remote-secret"), json("{}", { "content-length": "1048577" }),
    new Response("remote-secret", { status: 403 }), new Response("remote-secret", { headers: { "content-type": "text/html" } })]) {
    const controller = createHostAbortController();
    const state = harness(() => { controller.abort(new Error(clientToken)); return response; });
    await assert.rejects(state.http.request("POST", "/api/generate/v2-web/", {}, controller.signal), safeFailure);
    assert.equal(state.calls.length, 3);
  }
});

test("outputUrl is the shared adapter and downloader boundary for all three trusted CDNs", async () => {
  const state = harness(() => audio());
  for (const host of ["cdn1.suno.ai", "cdn2.suno.ai", "cdn.suno.ai"]) {
    const url = `https://${host}/output.mp3?Signature=signed-asset`;
    assert.equal(state.http.outputUrl(url), url);
    await state.http.download(state.http.outputUrl(url), signal());
  }
  for (const value of [undefined, "https://cdn1.suno.ai.evil.test/file.mp3", `${AUDIO}?token=${clientToken}`,
    "https://user@cdn2.suno.ai/file.mp3", `${AUDIO}#fragment`, "https://cdn.suno.ai/file%0a.mp3"]) {
    assert.throws(() => state.http.outputUrl(value), safeFailure);
  }
  assert.equal(state.calls.length, 3);
});

test("cancellation bounds stalled bodies and does not await an uncooperative cancel promise", async () => {
  for (const download of [false, true]) {
    const reading = Promise.withResolvers<void>();
    let cancelled = false;
    const controller = createHostAbortController();
    const state = harness(() => new Response(new ReadableStream({
      pull() { reading.resolve(); }, cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }) as unknown as BodyInit, { headers: { "content-type": download ? "audio/mpeg" : "application/json" } }));
    const pending = download ? state.http.download(AUDIO, controller.signal) :
      state.http.request("GET", "/api/billing/info/", undefined, controller.signal);
    await reading.promise;
    controller.abort(new Error(clientToken));
    await assert.rejects(pending, safeFailure);
    assert.equal(cancelled, true);
  }
});

test("deadlines bound token mint, API and download Fetch without retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  for (const stage of [MINT, `${API}/api/generate/v2-web/`, AUDIO]) {
    const started = Promise.withResolvers<void>();
    let requestSignal: AbortSignal | null | undefined;
    let stageCalls = 0;
    const http = createSunoHttp(credentials, async (url, init) => {
      if (url === stage) { stageCalls++; requestSignal = init?.signal; started.resolve(); return new Promise<Response>(() => {}); }
      if (url === CLIENT) return Response.json(clientResponse());
      assert.equal(url, MINT); return Response.json({ jwt: jwt(claims()) });
    });
    const pending = stage === AUDIO ? http.download(AUDIO, signal()) : http.request("POST", "/api/generate/v2-web/", {}, signal());
    await started.promise;
    t.mock.timers.tick(stage === MINT ? 15_000 : stage === AUDIO ? 10 * 60_000 : 120_000);
    await assert.rejects(pending, (error) => { assert.match((error as Error).message, /timed out/u); return safeFailure(error); });
    assert.equal(requestSignal?.aborted, true);
    assert.equal(stageCalls, 1);
  }
});
