import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { URL, URLSearchParams } from "node:url";
import type { TestContext } from "node:test";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function oauthServer(t: TestContext) {
  const codes = new Map<string, { challenge: string; redirect: string; client: string }>();
  const validTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const requests: Array<{ path: string; url: string; headers: Record<string, unknown>; body: string }> = [];
  const registrations: Array<Record<string, unknown>> = [];
  const redirects: string[] = [];
  let origin = "";
  let tokenNumber = 0;
  let refreshCalls = 0;
  let tokenCalls = 0;
  let allowRegistration = true;
  let tokenGate: ReturnType<typeof deferred> | undefined;
  const tokenEntered = deferred();
  let unauthorizedGate: { seen: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const send = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, origin);
      let body = "";
      for await (const chunk of request) body += String(chunk);
      requests.push({ path: url.pathname, url: request.url!, headers: request.headers, body });
      if (url.pathname === "/mcp" || url.pathname === "/other") {
        const token = request.headers.authorization?.replace(/^Bearer /u, "");
        if (!token || !validTokens.has(token)) {
          const gate = body && JSON.parse(body).method === "tools/list" ? unauthorizedGate : undefined;
          if (gate) unauthorizedGate = undefined;
          if (gate) { gate.seen.resolve(); await gate.release.promise; }
          response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/resource", scope="tools"` });
          response.end("unauthorized");
          return;
        }
        if (request.method === "GET") { response.writeHead(405); response.end(); return; }
        if (request.method === "DELETE") { response.writeHead(200); response.end(); return; }
        const message = JSON.parse(body);
        if (message.method === "server/discover") return send(response, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "legacy" } });
        if (message.method === "notifications/initialized") { response.writeHead(202); response.end(); return; }
        const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "oauth-local", version: "1" } }
          : message.method === "tools/list" ? { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }
          : { content: [{ type: "text", text: String(message.params?.arguments?.text ?? "") }] };
        return send(response, 200, { jsonrpc: "2.0", id: message.id, result });
      }
      if (url.pathname === "/resource" || url.pathname.startsWith("/.well-known/oauth-protected-resource")) return send(response, 200, {
        resource: `${origin}/mcp`, authorization_servers: [`${origin}/issuer`], scopes_supported: ["tools"],
      });
      if (url.pathname.startsWith("/.well-known/") || url.pathname === "/issuer/.well-known/openid-configuration") return send(response, 200, {
        issuer: `${origin}/issuer`, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        ...(allowRegistration ? { registration_endpoint: `${origin}/register` } : {}),
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      });
      if (url.pathname === "/register") {
        const metadata = JSON.parse(body);
        registrations.push(metadata);
        return send(response, 201, { ...metadata, client_id: `client-${registrations.length}` });
      }
      if (url.pathname === "/token") {
        tokenCalls++;
        tokenEntered.resolve();
        if (tokenGate) await tokenGate.promise;
        const parameters = new URLSearchParams(body);
        if (parameters.get("grant_type") === "authorization_code") {
          const record = codes.get(parameters.get("code")!);
          assert.ok(record);
          assert.equal(parameters.get("redirect_uri"), record.redirect);
          assert.equal(parameters.get("client_id"), record.client);
          assert.equal(createHash("sha256").update(parameters.get("code_verifier")!).digest("base64url"), record.challenge);
          assert.equal(parameters.get("resource"), `${origin}/mcp`);
        } else {
          refreshCalls++;
          const old = parameters.get("refresh_token")!;
          if (!refreshTokens.delete(old)) return send(response, 400, { error: "invalid_grant", error_description: "private-error-body" });
        }
        const access = `private-access-${++tokenNumber}`;
        const refresh = `private-refresh-${tokenNumber}`;
        validTokens.add(access);
        refreshTokens.add(refresh);
        return send(response, 200, { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "tools" });
      }
      send(response, 404, {});
    } catch (error) { send(response, 500, { error: "server_error", error_description: String(error) }); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return {
    origin, requests, registrations, redirects, tokenEntered,
    get tokenCalls() { return tokenCalls; }, get refreshCalls() { return refreshCalls; },
    disableRegistration() { allowRegistration = false; },
    expire() { validTokens.clear(); },
    holdTokens() { tokenGate = deferred(); return tokenGate; },
    holdNextUnauthorized() {
      const gate = { seen: deferred(), release: deferred() };
      unauthorizedGate = gate;
      return gate;
    },
    async authorize(raw: string, options: { wrongIssuer?: boolean; checkState?: boolean } = {}) {
      const url = new URL(raw);
      assert.equal(url.origin, origin);
      assert.equal(url.pathname, "/authorize");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const redirect = url.searchParams.get("redirect_uri")!;
      redirects.push(redirect);
      const callback = new URL(redirect);
      callback.searchParams.set("code", `code-${codes.size + 1}`);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("iss", options.wrongIssuer ? `${origin}/wrong-issuer` : `${origin}/issuer`);
      codes.set(callback.searchParams.get("code")!, { challenge: url.searchParams.get("code_challenge")!, redirect,
        client: url.searchParams.get("client_id")! });
      if (options.checkState) {
        const wrong = new URL(callback);
        wrong.searchParams.set("state", "wrong-state");
        assert.equal((await fetch(wrong)).status, 400);
      }
      assert.equal((await fetch(callback)).status, 200);
    },
  };
}
