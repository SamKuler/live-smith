import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { arch, platform } from "node:process";
import test from "node:test";

import {
  OAuthLoginError,
  type OAuthLoginAttempt,
  type OAuthProviderAdapter,
} from "./credential-manager.js";
import { createGoogleAntigravityOAuthAdapter } from "./google.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function beginAndSubmit(
  adapter: OAuthProviderAdapter,
): Promise<OAuthLoginAttempt> {
  const attempt = await adapter.beginLogin(new AbortController().signal);
  assert.equal(attempt.pending.authorizationCodeInput, true);
  assert.ok(attempt.submitAuthorizationCode);
  attempt.submitAuthorizationCode("authorization-code");
  assert.equal(attempt.pending.authorizationCodeInput, undefined);
  return attempt;
}

test("Google Antigravity OAuth resolves the managed project and account", async () => {
  const requests: string[] = [];
  let tokenRequestBody = "";
  let setupHeaders: Headers | undefined;
  let setupBody: Record<string, unknown> | undefined;
  const adapter = createGoogleAntigravityOAuthAdapter({
    fetchImpl: async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url === "https://oauth2.googleapis.com/token") {
        tokenRequestBody = String(init?.body);
        return response({
          access_token: "google-access",
          refresh_token: "google-refresh",
          expires_in: 3_600,
        });
      }
      if (url.startsWith("https://www.googleapis.com/oauth2/v1/userinfo")) {
        return response({ email: "listener@example.com" });
      }
      setupHeaders = new Headers(init?.headers);
      setupBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response({
        currentTier: { id: "standard-tier" },
        cloudaicompanionProject: "project-1",
        ineligibleTiers: [{
          reasonCode: "VALIDATION_REQUIRED",
          validationUrl: "https://accounts.google.com/signin/continue?ignored=1",
        }],
      });
    },
  });

  const attempt = await adapter.beginLogin(new AbortController().signal);
  assert.equal(attempt.pending.authorizationCodeInput, true);
  const authorization = new URL(attempt.pending.verificationUrl);
  assert.equal(authorization.hostname, "accounts.google.com");
  assert.equal(
    sha256(authorization.searchParams.get("client_id") ?? ""),
    "bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea",
  );
  assert.equal(
    authorization.searchParams.get("redirect_uri"),
    "https://antigravity.google/oauth-callback",
  );
  assert.equal(authorization.searchParams.get("access_type"), "offline");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorization.searchParams.get("state"));
  assert.deepEqual(authorization.searchParams.get("scope")?.split(" "), [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
    "https://www.googleapis.com/auth/aicode",
    "openid",
  ]);
  assert.ok(attempt.submitAuthorizationCode);
  attempt.submitAuthorizationCode("authorization-code");
  assert.deepEqual({ ...(await attempt.completion), expiresAt: 0 }, {
    provider: "google",
    accessToken: "google-access",
    refreshToken: "google-refresh",
    expiresAt: 0,
    projectId: "project-1",
    accountLabel: "listener@example.com",
  });
  const tokenParameters = new URLSearchParams(tokenRequestBody);
  assert.equal(tokenParameters.get("redirect_uri"),
    "https://antigravity.google/oauth-callback",
  );
  assert.equal(tokenParameters.get("grant_type"), "authorization_code");
  assert.equal(tokenParameters.get("code"), "authorization-code");
  assert.equal(
    sha256(tokenParameters.get("client_id") ?? ""),
    "bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea",
  );
  assert.equal(
    sha256(tokenParameters.get("client_secret") ?? ""),
    "1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60",
  );
  const verifier = tokenParameters.get("code_verifier");
  assert.ok(verifier);
  assert.equal(
    authorization.searchParams.get("code_challenge"),
    createHash("sha256").update(verifier).digest("base64url"),
  );
  assert.ok(requests.includes(
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  ));
  assert.match(
    setupHeaders?.get("user-agent") ?? "",
    /^antigravity\/cli\/1\.1\.22 \(aidev_client; os_type=(?:darwin|linux|windows); arch=(?:amd64|arm64); auth_method=consumer\)$/u,
  );
  assert.equal(setupHeaders?.has("x-goog-api-client"), false);
  assert.equal(setupHeaders?.has("client-metadata"), false);
  const metadataPlatforms: Readonly<Record<string, string>> = {
    "darwin/x64": "DARWIN_AMD64",
    "darwin/arm64": "DARWIN_ARM64",
    "linux/x64": "LINUX_AMD64",
    "linux/arm64": "LINUX_ARM64",
    "win32/x64": "WINDOWS_AMD64",
  };
  assert.deepEqual(setupBody, {
    metadata: {
      ideType: "ANTIGRAVITY",
      platform: metadataPlatforms[`${platform}/${arch}`] ??
        "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  });
});

test("Google Antigravity OAuth refresh preserves project and account metadata", async () => {
  let refreshBody = "";
  const adapter = createGoogleAntigravityOAuthAdapter({
    fetchImpl: async (_input, init) => {
      refreshBody = String(init?.body);
      return response({
        access_token: "new-access",
        expires_in: 3_600,
      });
    },
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
  const refreshParameters = new URLSearchParams(refreshBody);
  assert.equal(refreshParameters.get("grant_type"), "refresh_token");
  assert.equal(refreshParameters.get("refresh_token"), "old-refresh");
  assert.equal(
    sha256(refreshParameters.get("client_id") ?? ""),
    "bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea",
  );
  assert.equal(
    sha256(refreshParameters.get("client_secret") ?? ""),
    "1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60",
  );
  assert.deepEqual(adapter.authState(credential), {
    status: "signed-in",
    accountLabel: "listener@example.com",
    planType: "Google Antigravity",
    subscriptionEligible: true,
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("Google Antigravity OAuth cancels while waiting for the hosted code", async () => {
  const adapter = createGoogleAntigravityOAuthAdapter({
    fetchImpl: async () => assert.fail("OAuth HTTP must not start before code submission."),
  });
  const attempt = await adapter.beginLogin(new AbortController().signal);
  const reason = new Error("Antigravity login canceled before code submission");
  attempt.cancel(reason);
  await assert.rejects(attempt.completion, (error: unknown) => error === reason);
});

test("Google Antigravity OAuth accepts its authorization code only once", async () => {
  let tokenRequestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    tokenRequestStarted = resolve;
  });
  const adapter = createGoogleAntigravityOAuthAdapter({
    fetchImpl: async (_input, init) => {
      tokenRequestStarted();
      return new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => reject(init?.signal?.reason);
        init?.signal?.addEventListener("abort", rejectAbort, { once: true });
        if (init?.signal?.aborted) rejectAbort();
      });
    },
  });
  const attempt = await adapter.beginLogin(new AbortController().signal);
  assert.ok(attempt.submitAuthorizationCode);
  attempt.submitAuthorizationCode("first-code");
  assert.throws(
    () => attempt.submitAuthorizationCode?.("second-code"),
    /already submitted/i,
  );
  await started;
  const reason = new Error("Stop the submitted Antigravity exchange");
  attempt.cancel(reason);
  await assert.rejects(attempt.completion, (error: unknown) => error === reason);
});

test("Google Antigravity OAuth requires the account project returned by setup", async () => {
  const adapter = createGoogleAntigravityOAuthAdapter({
    fetchImpl: async (input) => String(input) === "https://oauth2.googleapis.com/token"
      ? response({
          access_token: "google-access",
          refresh_token: "google-refresh",
          expires_in: 3_600,
        })
      : String(input).includes("userinfo")
        ? response({})
        : response({ currentTier: { id: "standard-tier" } }),
  });
  const attempt = await beginAndSubmit(adapter);
  await assert.rejects(
    attempt.completion,
    /did not return an account project/u,
  );
});

test("Google OAuth surfaces account validation as a trusted browser action", async () => {
  const adapter = createGoogleAntigravityOAuthAdapter({
    fetchImpl: async (input) => String(input) === "https://oauth2.googleapis.com/token"
      ? response({
          access_token: "google-access",
          refresh_token: "google-refresh",
          expires_in: 3_600,
        })
      : response({
          ineligibleTiers: [{
            reasonCode: "VALIDATION_REQUIRED",
            reasonMessage: "remote message must not be exposed",
            validationUrl: "https://accounts.google.com/signin/continue?flow=test",
          }],
        }),
  });

  const attempt = await beginAndSubmit(adapter);
  await assert.rejects(attempt.completion, (error: unknown) => {
    assert.ok(error instanceof OAuthLoginError);
    assert.match(error.message, /additional account verification/i);
    assert.doesNotMatch(error.message, /remote message/i);
    assert.equal(
      error.verificationUrl,
      "https://accounts.google.com/signin/continue?flow=test",
    );
    assert.equal(error.verificationLabel, "Verify Google account");
    return true;
  });
});

test("Google OAuth reports token exchange failures without remote details", async () => {
  const adapter = createGoogleAntigravityOAuthAdapter({
    fetchImpl: async () => response({
      error: "invalid_grant sensitive authorization details",
    }, 400),
  });

  const attempt = await beginAndSubmit(adapter);
  await assert.rejects(attempt.completion, (error: unknown) => {
    assert.ok(error instanceof OAuthLoginError);
    assert.match(error.message, /token exchange/i);
    assert.doesNotMatch(error.message, /sensitive|invalid_grant/i);
    return true;
  });
});

test("Google OAuth preserves cancellation while optional account lookup is pending", async () => {
  let accountLookupStarted!: () => void;
  const accountLookup = new Promise<void>((resolve) => {
    accountLookupStarted = resolve;
  });
  const adapter = createGoogleAntigravityOAuthAdapter({
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
  });
  const attempt = await beginAndSubmit(adapter);
  await accountLookup;
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  const canceled = new Error("Google login canceled by owner");
  attempt.cancel(canceled);
  await assert.rejects(attempt.completion, (error: unknown) => error === canceled);
});

test("Google OAuth reports a fixed-safe account setup HTTP failure", async () => {
  let accountLookupStarted = false;
  const adapter = createGoogleAntigravityOAuthAdapter({
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
      return response({
        error: "project discovery failed",
        private_project: "secret-project",
      }, 503);
    },
  });

  const attempt = await beginAndSubmit(adapter);
  await assert.rejects(attempt.completion, (error: unknown) => {
    assert.ok(error instanceof OAuthLoginError);
    assert.equal(
      error.message,
      "Google authorization succeeded, but Antigravity account setup " +
        "HTTP 503: request failed.",
    );
    assert.doesNotMatch(error.message, /project discovery|secret-project/u);
    return true;
  });
  assert.equal(accountLookupStarted, false);
});

test("Google OAuth distinguishes an account setup Fetch rejection", async () => {
  let setupUrl = "";
  const adapter = createGoogleAntigravityOAuthAdapter({
    fetchImpl: async (input) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return response({
          access_token: "google-access",
          refresh_token: "google-refresh",
          expires_in: 3_600,
        });
      }
      setupUrl = url;
      throw new Error("credential-bearing Fetch rejection");
    },
  });

  const attempt = await beginAndSubmit(adapter);
  await assert.rejects(attempt.completion, (error: unknown) => {
    assert.ok(error instanceof OAuthLoginError);
    assert.equal(
      error.message,
      "Google authorization succeeded, but Antigravity account setup " +
        "could not be reached.",
    );
    assert.doesNotMatch(error.message, /credential-bearing/u);
    return true;
  });
  assert.equal(
    setupUrl,
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  );
});
