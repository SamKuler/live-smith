import assert from "node:assert/strict";
import test from "node:test";

import { createGoogleOAuthAdapter } from "./google.js";
import type { LoopbackAuthorization } from "./oauth-utils.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Google OAuth resolves the Cloud Code Assist project and account", async () => {
  const requests: string[] = [];
  const adapter = createGoogleOAuthAdapter({
    fetchImpl: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === "https://oauth2.googleapis.com/token") {
        return response({
          access_token: "google-access",
          refresh_token: "google-refresh",
          expires_in: 3_600,
        });
      }
      if (url.startsWith("https://www.googleapis.com/oauth2/v1/userinfo")) {
        return response({ email: "listener@example.com" });
      }
      return response({
        currentTier: { id: "standard-tier" },
        cloudaicompanionProject: "project-1",
      });
    },
    startLoopback: async (): Promise<LoopbackAuthorization> => ({
      redirectUri: "http://localhost:8085/oauth2callback",
      completion: Promise.resolve("authorization-code"),
      cancel() {},
    }),
  });

  const attempt = await adapter.beginLogin(new AbortController().signal);
  const authorization = new URL(attempt.pending.verificationUrl);
  assert.equal(authorization.hostname, "accounts.google.com");
  assert.equal(authorization.searchParams.get("access_type"), "offline");
  assert.match(authorization.searchParams.get("scope") ?? "", /cloud-platform/u);
  assert.deepEqual({ ...(await attempt.completion), expiresAt: 0 }, {
    provider: "google",
    accessToken: "google-access",
    refreshToken: "google-refresh",
    expiresAt: 0,
    projectId: "project-1",
    accountLabel: "listener@example.com",
  });
  assert.ok(requests.some((url) => url.endsWith("/v1internal:loadCodeAssist")));
});

test("Google OAuth refresh preserves project and account metadata", async () => {
  const adapter = createGoogleOAuthAdapter({
    fetchImpl: async () => response({
      access_token: "new-access",
      expires_in: 3_600,
    }),
  });
  const credential = await adapter.refresh({
    provider: "google",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
    projectId: "project-1",
    accountLabel: "listener@example.com",
  }, new AbortController().signal);
  assert.equal(credential.provider, "google");
  assert.equal(credential.refreshToken, "old-refresh");
  assert.equal(credential.projectId, "project-1");
  assert.equal(credential.accountLabel, "listener@example.com");
});

test("Google OAuth rejects accounts that require an explicit Cloud project", async () => {
  const adapter = createGoogleOAuthAdapter({
    fetchImpl: async (input) => String(input) === "https://oauth2.googleapis.com/token"
      ? response({
          access_token: "google-access",
          refresh_token: "google-refresh",
          expires_in: 3_600,
        })
      : String(input).includes("userinfo")
        ? response({})
        : response({ currentTier: { id: "standard-tier" } }),
    startLoopback: async (): Promise<LoopbackAuthorization> => ({
      redirectUri: "http://localhost:8085/oauth2callback",
      completion: Promise.resolve("authorization-code"),
      cancel() {},
    }),
  });
  const attempt = await adapter.beginLogin(new AbortController().signal);
  await assert.rejects(
    attempt.completion,
    /requires an explicit Google Cloud project/i,
  );
});

test("Google OAuth preserves cancellation while optional account lookup is pending", async () => {
  let accountLookupStarted!: () => void;
  const accountLookup = new Promise<void>((resolve) => {
    accountLookupStarted = resolve;
  });
  const adapter = createGoogleOAuthAdapter({
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return response({
          access_token: "google-access",
          refresh_token: "google-refresh",
          expires_in: 3_600,
        });
      }
      if (url.includes("userinfo")) {
        accountLookupStarted();
        return new Promise<Response>((_resolve, reject) => {
          const rejectAbort = () => reject(init?.signal?.reason);
          init?.signal?.addEventListener("abort", rejectAbort, { once: true });
          if (init?.signal?.aborted) rejectAbort();
        });
      }
      return response({
        currentTier: { id: "standard-tier" },
        cloudaicompanionProject: "project-1",
      });
    },
    startLoopback: async (): Promise<LoopbackAuthorization> => ({
      redirectUri: "http://localhost:8085/oauth2callback",
      completion: Promise.resolve("authorization-code"),
      cancel() {},
    }),
  });
  const attempt = await adapter.beginLogin(new AbortController().signal);
  await accountLookup;
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  const canceled = new Error("Google login canceled by owner");
  attempt.cancel(canceled);
  await assert.rejects(attempt.completion, (error: unknown) => error === canceled);
});

test("Google OAuth does not start optional account lookup before project discovery succeeds", async () => {
  let accountLookupStarted = false;
  const adapter = createGoogleOAuthAdapter({
    fetchImpl: async (input) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return response({
          access_token: "google-access",
          refresh_token: "google-refresh",
          expires_in: 3_600,
        });
      }
      if (url.includes("userinfo")) {
        accountLookupStarted = true;
        return response({ email: "listener@example.com" });
      }
      return response({ error: "project discovery failed" }, 500);
    },
    startLoopback: async (): Promise<LoopbackAuthorization> => ({
      redirectUri: "http://localhost:8085/oauth2callback",
      completion: Promise.resolve("authorization-code"),
      cancel() {},
    }),
  });

  const attempt = await adapter.beginLogin(new AbortController().signal);
  await assert.rejects(attempt.completion, /Cloud Code Assist HTTP 500/u);
  assert.equal(accountLookupStarted, false);
});
