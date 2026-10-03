import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { URL } from "node:url";
import test, { type TestContext } from "node:test";
import { createMcpOAuthAuthProvider, signInMcpOAuth, signOutMcpOAuth, mcpOAuthStates } from "../../../src/app/plugins/mcp-oauth.js";
import { connectPluginMcpServer } from "../../../src/plugins/mcp/client.js";
import { McpAuthorizationRequiredError } from "../../../src/plugins/mcp/oauth-contract.js";
import { integrationConnectionsView, type StandaloneMcpConnection } from "../../../src/plugins/integration-connections.js";
import { loadAgentSettings, saveGlobalSettings } from "../../../src/storage/settings.js";
import { readMcpOAuthCredentialInTransaction } from "../../../src/storage/mcp-oauth.js";
import { withStorageTransaction } from "../../../src/storage/persistence.js";
import { oauthServer } from "./support/mcp-oauth-server.js";

async function directory(t: TestContext) {
  const path = await fs.mkdtemp("/private/tmp/live-smith-mcp-oauth-");
  t.after(() => fs.rm(path, { recursive: true, force: true }));
  return path;
}
async function save(path: string, origin: string, id = "account", extra: Partial<StandaloneMcpConnection> = {}) {
  const settings = await loadAgentSettings(path);
  return saveGlobalSettings(path, { integrationConnections: { action: "upsert", expectedRevision: settings.integrationConnections?.revision ?? "0",
    connection: { id, name: id, enabled: true, mcp: { type: "streamable-http", url: `${origin}/mcp` },
      oauth: {}, secrets: { "X-Tenant": `tenant-${id}` }, artifactInputApproved: false, artifactOutputApproved: false, ...extra } } });
}
const credential = (path: string, id = "account") => withStorageTransaction(path, (transaction) => readMcpOAuthCredentialInTransaction(transaction, path, id));
const login = (path: string, server: Awaited<ReturnType<typeof oauthServer>>, id = "account", signal = new AbortController().signal) => signInMcpOAuth({
  storageDirectory: path, connectionId: id, signal, openBrowser: (url) => server.authorize(url, { checkState: true }),
});

test("SDK OAuth DCR uses PKCE/state/issuer; MCP tools refresh once, reuse registered callbacks, and keep credentials private", async (t) => {
  const path = await directory(t);
  const server = await oauthServer(t);
  await save(path, server.origin);
  const signal = new AbortController().signal;
  await assert.rejects(createMcpOAuthAuthProvider(path, "account", signal).token(), McpAuthorizationRequiredError);
  assert.equal(server.requests.length, 0);
  await login(path, server);
  const stored = await credential(path);
  assert.ok(stored?.tokens?.issuer);
  assert.equal(stored.tokens.issuer, `${server.origin}/issuer`);
  assert.equal(server.registrations.length, 1);
  assert.equal(server.registrations[0]?.token_endpoint_auth_method, "none");
  assert.equal((await fs.stat(`${path}/live-smith-mcp-oauth.json`)).mode & 0o777, 0o600);
  const beforeView = server.requests.length;
  assert.equal((await mcpOAuthStates(path))[0]?.status, "signed-in");
  assert.equal(server.requests.length, beforeView);
  assert.doesNotMatch(JSON.stringify(integrationConnectionsView((await loadAgentSettings(path)).integrationConnections)), /private-access|private-refresh|client-1/u);
  assert.ok(server.requests.filter((request) => request.path === "/mcp").every((request) => request.headers["x-tenant"] === "tenant-account"));
  assert.ok(server.requests.filter((request) => request.path !== "/mcp").every((request) => request.headers["x-tenant"] === undefined));
  const connect = () => connectPluginMcpServer({ id: "server", type: "streamable-http", url: `${server.origin}/mcp`, headers: { "X-Tenant": "tenant-account" } },
    undefined, signal, { authProvider: createMcpOAuthAuthProvider(path, "account", signal) });
  const first = await connect();
  const second = await connect();
  t.after(() => Promise.all([first.close(), second.close()]));
  server.expire();
  const listed = await Promise.all([first.listTools(signal), second.listTools(signal)]);
  assert.deepEqual(listed.map((tools) => tools.map((tool) => tool.name)), [["echo"], ["echo"]]);
  assert.equal(server.refreshCalls, 1);
  assert.deepEqual((await first.callTool("echo", { text: "music" }, signal)).content, [{ type: "text", text: "music" }]);
  await first.close(); await second.close();
  await login(path, server);
  assert.equal(server.registrations.length, 1);
  assert.equal(server.redirects[0], server.redirects[1]);
  assert.notEqual((await credential(path))?.generation, stored.generation);
});

test("each connection owns its account; logout and target changes fence delayed refreshes", async (t) => {
  const path = await directory(t);
  const server = await oauthServer(t);
  await save(path, server.origin);
  await save(path, server.origin, "other");
  await login(path, server);
  await login(path, server, "other");
  const first = await credential(path);
  const other = await credential(path, "other");
  assert.notEqual(first?.tokens?.access_token, other?.tokens?.access_token);
  const provider = createMcpOAuthAuthProvider(path, "account", new AbortController().signal);
  await provider.token();
  const gate = server.holdTokens();
  const requestsBefore = server.requests.length;
  const rejectedResponse = new Response(null, { status: 401 });
  provider.recordResponse!(rejectedResponse, { Authorization: `Bearer ${await provider.token()}` });
  const refresh = provider.onUnauthorized!({ response: rejectedResponse, serverUrl: new URL(`${server.origin}/mcp`), fetchFn: fetch });
  for (let attempt = 0; !server.requests.slice(requestsBefore).some((request) => request.path === "/token"); attempt += 1) {
    assert.ok(attempt < 200, "refresh must enter the local token endpoint");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await signOutMcpOAuth(path, "account");
  gate.resolve();
  await assert.rejects(refresh);
  assert.equal(await credential(path), undefined);
  assert.deepEqual(await credential(path, "other"), other);
  await login(path, server);
  const obsolete = createMcpOAuthAuthProvider(path, "account", new AbortController().signal);
  await obsolete.token();
  await save(path, server.origin, "account", { mcp: { type: "streamable-http", url: `${server.origin}/other` } });
  await save(path, server.origin);
  await assert.rejects(obsolete.token(), /changed/u);
  assert.equal(await credential(path), undefined);
});

test("a mismatched callback issuer never reaches token exchange", async (t) => {
  const path = await directory(t);
  const server = await oauthServer(t);
  await save(path, server.origin);
  await assert.rejects(signInMcpOAuth({ storageDirectory: path, connectionId: "account", signal: new AbortController().signal,
    openBrowser: (url) => server.authorize(url, { wrongIssuer: true }) }), /MCP sign-in failed/u);
  assert.equal(server.tokenCalls, 0);
  assert.equal((await credential(path))?.tokens, undefined);
});

test("canceling a code exchange cannot persist a late token response", async (t) => {
  const path = await directory(t);
  const server = await oauthServer(t);
  await save(path, server.origin);
  const controller = new AbortController();
  const gate = server.holdTokens();
  const pending = login(path, server, "account", controller.signal);
  const rejected = assert.rejects(pending, /canceled/u);
  await server.tokenEntered.promise;
  controller.abort(new Error("canceled"));
  gate.resolve();
  await rejected;
  assert.equal((await credential(path))?.tokens, undefined);
  assert.equal((await mcpOAuthStates(path))[0]?.status, "signed-out");
});

test("manual Authorization conflicts are explicit; unsupported DCR can use a registered public client", async (t) => {
  const path = await directory(t);
  const server = await oauthServer(t);
  await assert.rejects(save(path, server.origin, "conflict", { secrets: { Authorization: "manual-secret" } }), /Authorization/u);
  await save(path, server.origin);
  server.disableRegistration();
  await assert.rejects(login(path, server), /registered public client/u);
  assert.equal(server.tokenCalls, 0);
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const address = reserve.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  await save(path, server.origin, "account", { oauth: { clientId: "public-client", callbackPort: address.port } });
  await login(path, server);
  assert.equal(server.registrations.length, 0);
  assert.match(server.redirects[0]!, new RegExp(`:${address.port}/mcp/oauth/callback$`));
  assert.equal((await mcpOAuthStates(path))[0]?.status, "signed-in");
});


test("a late 401 is bound to its HTTP request token after another RPC refreshes the same client", async (t) => {
  const path = await directory(t);
  const server = await oauthServer(t);
  await save(path, server.origin);
  await login(path, server);
  const signal = new AbortController().signal;
  const connection = await connectPluginMcpServer({ id: "server", type: "streamable-http", url: `${server.origin}/mcp`, headers: {} },
    undefined, signal, { authProvider: createMcpOAuthAuthProvider(path, "account", signal) });
  t.after(() => connection.close());
  server.expire();
  const late = server.holdNextUnauthorized();
  const list = connection.listTools(signal);
  await late.seen.promise;
  assert.deepEqual((await connection.callTool("echo", { text: "new token" }, signal)).content, [{ type: "text", text: "new token" }]);
  assert.equal(server.refreshCalls, 1);
  late.release.resolve();
  assert.equal((await list)[0]?.name, "echo");
  assert.equal(server.refreshCalls, 1);
});

test("protected anonymous servers report sign-in required and empty Authorization cannot override OAuth", async (t) => {
  const server = await oauthServer(t);
  const signal = new AbortController().signal;
  await assert.rejects(connectPluginMcpServer({ id: "anonymous", type: "streamable-http", url: `${server.origin}/mcp`, headers: {} }, undefined, signal), McpAuthorizationRequiredError);
  const count = server.requests.length;
  await assert.rejects(connectPluginMcpServer({ id: "empty-header", type: "streamable-http", url: `${server.origin}/mcp`, headers: { authorization: "" } },
    undefined, signal, { authProvider: { token: async () => "private-token" } }), /Authorization/u);
  assert.equal(server.requests.length, count);
});

test("a registered dynamic callback port is reused after reload and occupation preserves the existing account", async (t) => {
  const path = await directory(t);
  const server = await oauthServer(t);
  await save(path, server.origin);
  await login(path, server);
  const before = await credential(path);
  const port = Number(new URL(before!.redirectUri).port);
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  await assert.rejects(login(path, server), /callback port is unavailable/u);
  assert.deepEqual(await credential(path), before);
});

test("OAuth body limits are total even for SSE, while the initial challenge body is canceled", async (t) => {
  const path = await directory(t);
  const server = await oauthServer(t);
  await save(path, server.origin);
  let challengeCanceled = false;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url === `${server.origin}/mcp` && init?.method === "GET") {
      return new Response(new ReadableStream({ cancel() { challengeCanceled = true; } }), {
        status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${server.origin}/resource"` },
      });
    }
    if (url === `${server.origin}/resource`) return new Response("data: x\n\n".repeat(80_000), { headers: { "content-type": "text/event-stream" } });
    return fetch(input, init);
  }) as typeof fetch;
  await assert.rejects(signInMcpOAuth({ storageDirectory: path, connectionId: "account", signal: new AbortController().signal,
    fetchImpl, openBrowser: async () => { throw new Error("Oversized metadata must not open a browser"); } }), /byte limit/u);
  assert.equal(challengeCanceled, true);
  assert.equal(server.tokenCalls, 0);
});

test("transient refresh failures retain the account for a later request", async (t) => {
  const path = await directory(t);
  const server = await oauthServer(t);
  await save(path, server.origin);
  await login(path, server);
  const before = await credential(path);
  let failure: "server" | "network" | undefined = "server";
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === `${server.origin}/token` && failure) {
      if (failure === "network") throw new TypeError("private network failure");
      return new Response(JSON.stringify({ error: "server_error", error_description: "private response" }), {
        status: 503, headers: { "content-type": "application/json" },
      });
    }
    return fetch(input, init);
  }) as typeof fetch;
  const provider = createMcpOAuthAuthProvider(path, "account", new AbortController().signal, fetchImpl);
  const rejected = new Response(null, { status: 401 });
  provider.recordResponse!(rejected, { Authorization: `Bearer ${await provider.token()}` });
  const refresh = () => provider.onUnauthorized!({ response: rejected, serverUrl: new URL(`${server.origin}/mcp`), fetchFn: fetch });
  await assert.rejects(refresh(), /MCP sign-in failed/u);
  assert.deepEqual(await credential(path), before);
  failure = "network";
  await assert.rejects(refresh(), /MCP sign-in failed/u);
  assert.deepEqual(await credential(path), before);
  assert.equal((await mcpOAuthStates(path))[0]?.status, "signed-in");
  failure = undefined;
  await refresh();
  assert.notEqual(await provider.token(), before?.tokens?.access_token);
  assert.equal(server.refreshCalls, 1);
});

test("a rejected refresh grant clears the account without starting interactive authorization", async (t) => {
  const path = await directory(t);
  const server = await oauthServer(t);
  await save(path, server.origin);
  await login(path, server);
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => String(input) === `${server.origin}/token`
    ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } })
    : fetch(input, init)) as typeof fetch;
  const provider = createMcpOAuthAuthProvider(path, "account", new AbortController().signal, fetchImpl);
  const rejected = new Response(null, { status: 401 });
  provider.recordResponse!(rejected, { Authorization: `Bearer ${await provider.token()}` });
  await assert.rejects(provider.onUnauthorized!({ response: rejected, serverUrl: new URL(`${server.origin}/mcp`), fetchFn: fetch }), McpAuthorizationRequiredError);
  assert.equal((await credential(path))?.tokens, undefined);
  assert.equal((await mcpOAuthStates(path))[0]?.status, "signed-out");
  assert.equal(server.redirects.length, 1);
});

test("logout supersedes an admitted first sign-in before it creates a credential record", async (t) => {
  const path = await directory(t);
  const server = await oauthServer(t);
  await save(path, server.origin);
  const realpath = fs.realpath;
  const canonicalize = t.mock.method(fs, "realpath", (target: Parameters<typeof realpath>[0], ...args: unknown[]) =>
    target === path ? Promise.resolve(path) : Reflect.apply(realpath, fs, [target, ...args]));
  syncBuiltinESMExports();
  t.after(() => { canonicalize.mock.restore(); syncBuiltinESMExports(); });
  const [signIn, signOut] = await Promise.allSettled([login(path, server), signOutMcpOAuth(path, "account")]);
  assert.equal(signOut.status, "fulfilled");
  assert.equal(signIn.status, "rejected");
  assert.equal(await credential(path), undefined);
  assert.equal((await mcpOAuthStates(path))[0]?.status, "signed-out");
  await login(path, server);
  assert.equal((await mcpOAuthStates(path))[0]?.status, "signed-in");
});

test("refresh responses without token rotation retain the previous refresh token", async (t) => {
  const path = await directory(t);
  const server = await oauthServer(t);
  await save(path, server.origin);
  await login(path, server);
  const before = await credential(path);
  let omitRefreshToken = true;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === `${server.origin}/token` && omitRefreshToken) {
      omitRefreshToken = false;
      return new Response(JSON.stringify({ access_token: "renewed-access", token_type: "Bearer", expires_in: 3600 }), {
        headers: { "content-type": "application/json" },
      });
    }
    return fetch(input, init);
  }) as typeof fetch;
  const provider = createMcpOAuthAuthProvider(path, "account", new AbortController().signal, fetchImpl);
  const refresh = async () => {
    const rejected = new Response(null, { status: 401 });
    provider.recordResponse!(rejected, { Authorization: `Bearer ${await provider.token()}` });
    await provider.onUnauthorized!({ response: rejected, serverUrl: new URL(`${server.origin}/mcp`), fetchFn: fetch });
  };
  await refresh();
  assert.equal(await provider.token(), "renewed-access");
  assert.equal((await credential(path))?.tokens?.refresh_token, before?.tokens?.refresh_token);
  await refresh();
  assert.equal(server.refreshCalls, 1);
  assert.notEqual((await credential(path))?.tokens?.refresh_token, before?.tokens?.refresh_token);
});
