import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { ReadableStream } from "node:stream/web";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { createSunoSessionResolver, createSunoSessionVerifier, normalizeSunoSessionValue, SunoSessionExpiredError } from "../../../src/audio-services/suno/suno-session.js";

const jwt = (claims: unknown, header: unknown = { alg: "RS256", typ: "JWT" }) =>
  [Buffer.from(JSON.stringify(header)), Buffer.from(JSON.stringify(claims)), Buffer.from("synthetic-signature")]
    .map((part) => part.toString("base64url")).join(".");
const token = jwt({ sub: "client_synthetic" }, { alg: "HS256" });
const accessToken = (accountId = "user_selected") => jwt({ sub: accountId, sid: "sess_selected", exp: Math.floor(Date.now() / 1000) + 3600 });
const sessionToken = (accountId = "user_selected") => jwt({ sub: accountId, sid: "sess_selected", exp: Math.floor(Date.now() / 1000) + 120 });
const endpoint = "https://auth.suno.com/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0";
const mintEndpoint = "https://auth.suno.com/v1/client/sessions/sess_selected/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0";
const touchEndpoint = "https://auth.suno.com/v1/client/sessions/sess_selected/touch?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0";
const legacyTouchEndpoint = "https://clerk.suno.com/v1/client/sessions/sess_selected/touch?__clerk_api_version=2025-04-10&_clerk_js_version=5.103.1";
const signal = () => createHostAbortController().signal;
const session = (id = "sess_selected", accountId = "user_selected") => ({
  object: "session", id, status: "active", expire_at: Date.now() + 60_000,
  user: { object: "user", id: accountId, first_name: "Ada", last_name: "Lovelace", username: "ada" },
});
const payload = (sessions: unknown[] = [session()], selected: unknown = "sess_selected") => ({
  response: { object: "client", id: "client_synthetic", last_active_session_id: selected, sessions },
});
function verifier(value: unknown, minted: unknown = { jwt: accessToken() }) {
  let calls = 0;
  return createSunoSessionVerifier(async () => Response.json(++calls === 1 ? value : minted));
}
function safeFailure(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.ok(!String(error.stack).includes(token));
  assert.equal(error.cause, undefined);
  return true;
}

function generatedClientSession(value: unknown, expectedToken = token): void {
  assert.equal(typeof value, "string");
  const prefix = `__client=${expectedToken}; ajs_anonymous_id=`;
  assert.ok((value as string).startsWith(prefix));
  assert.match((value as string).slice(prefix.length), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
}

test("normalization accepts client or session Cookies and discards unrelated browser cookies", () => {
  const canonicalClient = `__client=${token}`;
  assert.equal(normalizeSunoSessionValue(`  ${token}  `), canonicalClient);
  assert.equal(normalizeSunoSessionValue(canonicalClient), canonicalClient);
  assert.equal(normalizeSunoSessionValue(`Cookie: ignored=private; ${canonicalClient}; __client_uat=123; __cf_bm=private`),
    `${canonicalClient}; __client_uat=123`);
  const currentSession = sessionToken();
  assert.equal(normalizeSunoSessionValue(`__client_uat=123; __session=${currentSession}; ajs_anonymous_id=%22AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA%22`),
    `__session=${currentSession}; __client_uat=123; ajs_anonymous_id=%22AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA%22`);
  assert.equal(normalizeSunoSessionValue(currentSession), `__session=${currentSession}`);
  for (const value of [null, {}, 1, "", "a.b.c", `Bearer ${token}`,
    `__client=${token}; __client=${token}`, `__client=${token}\r\nX-Test: injected`,
    `__client =${token}`, `${token}=`, `${token}.extra`, "a".repeat(17_000),
    `__client_uat=123`, `__session=${jwt({ sub: "user_selected" })}`, `__session=${sessionToken()}; __client_uat=not-a-time`]) {
    assert.throws(() => normalizeSunoSessionValue(value), safeFailure);
  }
});

test("client Cookie verification selects one account and mints a matching bearer without forwarding unrelated cookies", async () => {
  let calls = 0;
  const verify = createSunoSessionVerifier(async (url, init) => {
    calls++;
    assert.equal(url, calls === 1 ? endpoint : mintEndpoint);
    assert.equal(init?.method, calls === 1 ? "GET" : "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.body, calls === 1 ? undefined : "");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), token);
    assert.equal(headers.get("Cookie"), `__client=${token}`);
    assert.equal(headers.get("User-Agent"), null);
    assert.equal(headers.get("browser-token"), null);
    return calls === 1 ? Response.json(payload([session("sess_other", "user_other"), session()]))
      : Response.json({ jwt: accessToken() });
  });
  const result = await verify(token, signal());
  assert.equal(result.accountId, "user_selected");
  assert.equal(result.accountName, "Ada Lovelace");
  generatedClientSession(result.sessionValue);
  assert.equal(calls, 2);
});

test("Clerk session route IDs are bounded opaque identifiers rather than a sess_ naming contract", async () => {
  const opaqueSessionId = "opaque-session-id_123";
  let calls = 0;
  const verify = createSunoSessionVerifier(async () => Response.json(++calls === 1
    ? payload([session(opaqueSessionId)], opaqueSessionId)
    : { jwt: jwt({ sub: "user_selected", sid: opaqueSessionId, exp: Math.floor(Date.now() / 1000) + 3600 }) }));
  const result = await verify(token, signal());
  assert.equal(result.accountId, "user_selected");
  generatedClientSession(result.sessionValue);
  assert.equal(calls, 2);
});

test("bounded provider account IDs do not require the legacy user_ prefix", async () => {
  const accountId = "account-selected";
  const clientResult = await verifier(
    payload([session("sess_selected", accountId)]),
    { jwt: accessToken(accountId) },
  )(token, signal());
  assert.equal(clientResult.accountId, accountId);
  assert.equal(clientResult.accountName, "Ada Lovelace");

  const imported = sessionToken(accountId);
  const fresh = accessToken(accountId);
  const sessionResult = await createSunoSessionResolver(async () =>
    Response.json({
      response: {
        object: "session",
        id: "sess_selected",
        status: "active",
        user: session("sess_selected", accountId).user,
        last_active_token: { jwt: fresh },
      },
    })
  )(`__session=${imported}`, signal());
  assert.equal(sessionResult.accountId, accountId);
  assert.equal(sessionResult.accountName, "Ada Lovelace");
});

test("session Cookie plus __client_uat uses Clerk touch, rotates the private session and preserves its device", async () => {
  const imported = sessionToken();
  const fresh = accessToken();
  const cookie = `__session=${imported}; __client_uat=123; ajs_anonymous_id=%22AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA%22`;
  let calls = 0;
  const resolve = createSunoSessionResolver(async (url, init) => {
    calls++;
    assert.equal(url, touchEndpoint);
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0&active_organization_id=");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), null);
    assert.equal(headers.get("Cookie"), cookie);
    assert.equal(headers.get("Origin"), "https://suno.com");
    return Response.json({ response: { object: "session", id: "sess_selected", status: "active",
      user: session().user, last_active_token: { jwt: fresh } } }, { headers: { "set-cookie": "__client_uat=456; Path=/; Secure" } });
  });
  assert.deepEqual(await resolve(cookie, signal()), {
    accountId: "user_selected", accountName: "Ada Lovelace", sessionId: "sess_selected", accessToken: fresh,
    sessionValue: `__session=${fresh}; __client_uat=456; ajs_anonymous_id=%22AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA%22`,
    deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expiresAt: JSON.parse(Buffer.from(fresh.split(".")[1]!, "base64url").toString()).exp * 1000,
  });
  assert.equal(calls, 1);
});

test("session Cookie touch falls back only between Suno's two observed Clerk hosts", async () => {
  const imported = sessionToken();
  const fresh = accessToken();
  const cookie = `__session=${imported}; __client_uat=123`;
  const calls: string[] = [];
  const resolve = createSunoSessionResolver(async (url, init) => {
    calls.push(String(url));
    assert.equal(new Headers(init?.headers).get("Cookie"), cookie);
    if (url === touchEndpoint) return new Response(null, { status: 404 });
    assert.equal(url, legacyTouchEndpoint);
    assert.equal(init?.body, "__clerk_api_version=2025-04-10&_clerk_js_version=5.103.1&active_organization_id=");
    return Response.json({ response: { object: "session", id: "sess_selected", status: "active",
      last_active_token: { jwt: fresh } } });
  });
  const result = await resolve(cookie, signal());
  assert.equal(result.accountId, "user_selected");
  assert.equal(result.accessToken, fresh);
  assert.deepEqual(calls, [touchEndpoint, legacyTouchEndpoint]);
});

test("last active session never falls back to another account or a public user stub", async () => {
  for (const value of [payload([session("sess_other")]), payload([session()], null),
    payload([{ ...session(), status: "expired" }]), payload([{ ...session(), expire_at: Date.now() - 1 }])]) {
    await assert.rejects(verifier(value)(token, signal()), SunoSessionExpiredError);
  }
  for (const value of [payload([session(), session()]), payload([{ ...session(), status: "pending" }]),
    payload([{ ...session(), user: undefined, public_user_data: { user_id: "user_stub" } }]),
    payload([{ ...session(), user: { id: "user_wrong_object", object: "organization" } }]),
    payload([{ ...session(), expire_at: "tomorrow" }]), { response: { sessions: [session()] } }]) {
    await assert.rejects(verifier(value)(token, signal()), (error) => {
      assert.ok(!(error instanceof SunoSessionExpiredError)); return safeFailure(error);
    });
  }
});

test("identity excludes metadata, invalid account IDs, controls and credential echoes", async () => {
  for (const user of [{ ...session().user, id: token }, { ...session().user, first_name: token },
    { ...session().user, id: "account/other" }, { ...session().user, first_name: "Ada\nCookie" }]) {
    await assert.rejects(verifier(payload([{ ...session(), user }]))(token, signal()), safeFailure);
  }
  const privateResult = await verifier(payload([{ ...session(), user: {
    object: "user", id: "user_only", first_name: null, last_name: null, username: null,
    private_metadata: { token }, email_addresses: [{ email_address: "private@example.test" }],
  } }]), { jwt: jwt({ sub: "user_only", sid: "sess_selected", exp: Math.floor(Date.now() / 1000) + 3600 }) })
    (token, signal());
  assert.equal(privateResult.accountId, "user_only");
  assert.equal(privateResult.accountName, undefined);
  generatedClientSession(privateResult.sessionValue);
});

test("long verified display names are bounded without discarding the account identity", async () => {
  for (const user of [{ ...session().user, first_name: "A".repeat(150), last_name: "B".repeat(150) },
    { ...session().user, first_name: "A".repeat(500), last_name: null }]) {
    const identity = await verifier(payload([{ ...session(), user }]))(token, signal());
    assert.equal(identity.accountId, "user_selected");
    assert.equal(identity.accountName?.length, 160);
  }
});

test("a dotted username is a valid account label when the full name is absent", async () => {
  const user = { ...session().user, first_name: null, last_name: null, username: "sam.kuler.music" };
  const result = await verifier(payload([{ ...session(), user }]))(token, signal());
  assert.equal(result.accountId, "user_selected");
  assert.equal(result.accountName, "sam.kuler.music");
  generatedClientSession(result.sessionValue);
});

test("401 is expired, other failures are unavailable and discard response bodies and exception causes", async () => {
  for (const status of [401, 403, 429, 500, 302]) {
    let cancelled = false;
    const verify = createSunoSessionVerifier(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(token)); }, cancel() { cancelled = true; },
    }) as unknown as BodyInit, { status, headers: { location: "https://example.test/" } }));
    await assert.rejects(verify(token, signal()), (error) => {
      assert.equal(error instanceof SunoSessionExpiredError, status === 401); return safeFailure(error);
    });
    assert.equal(cancelled, true);
  }
  await assert.rejects(createSunoSessionVerifier(async () => {
    throw new Error(token, { cause: new Error(token) });
  })(token, signal()), safeFailure);
});

test("redirected responses, malformed JSON, media types and both advertised and streamed oversized bodies are rejected", async () => {
  const redirected = Response.json(payload());
  Object.defineProperty(redirected, "redirected", { value: true });
  for (const response of [new Response(token, { headers: { "content-type": "application/json" } }),
    new Response("{}", { headers: { "content-type": "text/html" } }),
    new Response("{}", { headers: { "content-type": "application/json", "content-length": "9999999" } }),
    new Response(" ".repeat(65 * 1024), { headers: { "content-type": "application/json" } }),
    redirected]) {
    await assert.rejects(createSunoSessionVerifier(async () => response)(token, signal()), safeFailure);
  }
});

test("cancellation bounds pending Fetch and pending body reads without echoing abort reasons", async () => {
  const controller = createHostAbortController();
  let requestSignal: AbortSignal | null | undefined;
  const started = Promise.withResolvers<void>();
  const verify = createSunoSessionVerifier(async (_url, init) => {
    requestSignal = init?.signal; started.resolve(); return new Promise<Response>(() => {});
  });
  const pending = verify(token, controller.signal);
  await started.promise;
  controller.abort(new Error(token));
  await assert.rejects(pending, (error) => { assert.equal((error as Error).name, "AbortError"); return safeFailure(error); });
  assert.equal(requestSignal?.aborted, true);

  const bodyController = createHostAbortController();
  const reading = Promise.withResolvers<void>();
  let cancelled = false;
  const bodyPending = createSunoSessionVerifier(async () => new Response(new ReadableStream({
    pull() { reading.resolve(); }, cancel() { cancelled = true; },
  }) as unknown as BodyInit, { headers: { "content-type": "application/json" } }))(token, bodyController.signal);
  await reading.promise;
  bodyController.abort(new Error(token));
  await assert.rejects(bodyPending, safeFailure);
  assert.equal(cancelled, true);
});

test("deadline bounds an unresponsive Fetch and cleans up a late response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  const late = Promise.withResolvers<Response>();
  let requestSignal: AbortSignal | null | undefined;
  const pending = createSunoSessionVerifier(async (_url, init) => {
    requestSignal = init?.signal; return late.promise;
  })(token, signal());
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, (error) => {
    assert.ok(!(error instanceof SunoSessionExpiredError)); return safeFailure(error);
  });
  assert.equal(requestSignal?.aborted, true);
  const cancelled = Promise.withResolvers<void>();
  late.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve(); } }) as unknown as BodyInit));
  await cancelled.promise;
});

test("invalid and pre-cancelled input never reaches Fetch", async () => {
  let calls = 0;
  const verify = createSunoSessionVerifier(async () => { calls++; return Response.json(payload()); });
  await assert.rejects(verify(`__client=${token}; __client=${token}`, signal()), safeFailure);
  const controller = createHostAbortController(); controller.abort(new Error(token));
  await assert.rejects(verify(token, controller.signal), safeFailure);
  assert.equal(calls, 0);
});
