import assert from "node:assert/strict";
import test from "node:test";

import { createAnthropicOAuthAdapter } from "./anthropic.js";
import type { LoopbackAuthorization } from "./oauth-utils.js";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("Anthropic OAuth uses PKCE browser login and exchanges a Claude credential", async () => {
  let expectedState = "";
  let tokenRequest: RequestInit | undefined;
  const adapter = createAnthropicOAuthAdapter({
    fetchImpl: async (_input, init) => {
      tokenRequest = init;
      return response({
        access_token: "sk-ant-oat-access",
        refresh_token: "refresh-1",
        expires_in: 3_600,
      });
    },
    startLoopback: async (options): Promise<LoopbackAuthorization> => {
      expectedState = options.expectedState;
      return {
        redirectUri: "http://localhost:53692/callback",
        completion: Promise.resolve("authorization-code"),
        cancel() {},
      };
    },
  });

  const attempt = await adapter.beginLogin(new AbortController().signal);
  const authorization = new URL(attempt.pending.verificationUrl);
  assert.equal(authorization.hostname, "claude.ai");
  assert.equal(authorization.searchParams.get("state"), expectedState);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual({ ...(await attempt.completion), expiresAt: 0 }, {
    provider: "anthropic",
    accessToken: "sk-ant-oat-access",
    refreshToken: "refresh-1",
    expiresAt: 0,
  });
  assert.match(String(tokenRequest?.body), /authorization-code/u);
});

test("Anthropic OAuth refresh uses the rotated refresh token", async () => {
  let requestBody = "";
  const adapter = createAnthropicOAuthAdapter({
    fetchImpl: async (_input, init) => {
      requestBody = String(init?.body);
      return response({
        access_token: "sk-ant-oat-next",
        refresh_token: "refresh-next",
        expires_in: 3_600,
      });
    },
  });
  const credential = await adapter.refresh({
    provider: "anthropic",
    accessToken: "sk-ant-oat-old",
    refreshToken: "refresh-old",
    expiresAt: 1,
  }, new AbortController().signal);
  assert.equal(credential.accessToken, "sk-ant-oat-next");
  assert.match(requestBody, /refresh-old/u);
});
