import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { createOpenAIOAuthAdapter } from "./openai.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function accessToken(
  accountId: string,
  expiresAtSeconds: number | null = Math.floor(Date.now() / 1_000) + 3_600,
): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    ...(expiresAtSeconds === null ? {} : { exp: expiresAtSeconds }),
  })).toString("base64url");
  return `header.${payload}.signature`;
}

test("OpenAI OAuth uses device authorization and preserves ChatGPT account identity", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(init === undefined ? { url } : { url, init });
    if (url.endsWith("/api/accounts/deviceauth/usercode")) {
      return response({
        device_auth_id: "device-1",
        user_code: "ABCD-EFGH",
        interval: 0,
      });
    }
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      return response({ authorization_code: "code-1", code_verifier: "verifier-1" });
    }
    return response({
      access_token: "opaque-access-1",
      id_token: accessToken("account-1", null),
      refresh_token: "refresh-1",
    });
  };
  const adapter = createOpenAIOAuthAdapter({
    fetchImpl,
    wait: async () => undefined,
  });

  const attempt = await adapter.beginLogin(new AbortController().signal);
  assert.deepEqual(attempt.pending, {
    status: "pending",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
  });
  const credential = await attempt.completion;
  assert.deepEqual({ ...credential, expiresAt: 0 }, {
    provider: "openai",
    accessToken: "opaque-access-1",
    refreshToken: "refresh-1",
    expiresAt: 0,
    accountId: "account-1",
  });
  assert.equal(credential.expiresAt, Number.MAX_SAFE_INTEGER);
  assert.equal(requests[0]?.url, "https://auth.openai.com/api/accounts/deviceauth/usercode");
  assert.match(String(requests[2]?.init?.body), /grant_type=authorization_code/u);
});

test("OpenAI OAuth refresh retains account identity from the rotated token", async () => {
  const adapter = createOpenAIOAuthAdapter({
    fetchImpl: async () => response({
      access_token: "opaque-access-2",
      id_token: accessToken("account-2"),
      refresh_token: "refresh-2",
      expires_in: 7_200,
    }),
  });
  const credential = await adapter.refresh({
    provider: "openai",
    accessToken: accessToken("account-1"),
    refreshToken: "refresh-1",
    expiresAt: 1,
    accountId: "account-1",
  }, new AbortController().signal);
  assert.equal(credential.provider, "openai");
  assert.equal(credential.accountId, "account-2");
  assert.equal(credential.refreshToken, "refresh-2");
});

test("OpenAI OAuth refresh preserves prior identity when rotated tokens are opaque", async () => {
  const adapter = createOpenAIOAuthAdapter({
    fetchImpl: async () => response({
      access_token: "opaque-access-2",
    }),
  });
  const credential = await adapter.refresh({
    provider: "openai",
    accessToken: "opaque-access-1",
    refreshToken: "refresh-1",
    expiresAt: 1,
    accountId: "account-1",
  }, new AbortController().signal);

  assert.equal(credential.provider, "openai");
  assert.equal(credential.refreshToken, "refresh-1");
  assert.equal(credential.expiresAt, Number.MAX_SAFE_INTEGER);
  assert.equal(credential.accountId, "account-1");
});

test("OpenAI OAuth refresh preserves an unrotated refresh token and uses JWT expiry", async () => {
  const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 7_200;
  const adapter = createOpenAIOAuthAdapter({
    fetchImpl: async () => response({
      access_token: accessToken("account-2", expiresAtSeconds),
    }),
  });
  const credential = await adapter.refresh({
    provider: "openai",
    accessToken: accessToken("account-1"),
    refreshToken: "refresh-1",
    expiresAt: 1,
    accountId: "account-1",
  }, new AbortController().signal);

  assert.equal(credential.provider, "openai");
  assert.equal(credential.refreshToken, "refresh-1");
  assert.equal(credential.expiresAt, expiresAtSeconds * 1_000);
  assert.equal(credential.accountId, "account-2");
});
