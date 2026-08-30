import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { saveOAuthCredential } from "../../storage/oauth-credentials.js";
import { ModelAuthenticationError } from "../connection-error.js";
import type { TransportRequest } from "../provider.js";
import type { OAuthProviderAdapter } from "./credential-manager.js";
import { createNativeOAuthBackend } from "./native-backend.js";
import type { OAuthModelProtocol } from "./protocol.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function request(): TransportRequest {
  return {
    runtimeProfile: {
      profile: {
        id: "openai-oauth",
        name: "ChatGPT",
        connection: { kind: "oauth-subscription", provider: "openai" },
      },
      model: {
        model: "gpt-test",
        parameters: { reasoning: { mode: "default" } },
        advanced: {},
      },
      capabilities: {
        tools: true,
        streaming: true,
        temperature: "unsupported",
        reasoning: {
          supported: true,
          canDisable: false,
          efforts: ["low", "medium", "high"],
          budgetTokens: false,
          strategy: "effort",
        },
        inputs: { image: false, audio: false, pdf: false },
      },
      inputCapabilityEvidence: {
        image: "unsupported",
        audio: "unsupported",
        pdf: "unsupported",
      },
    },
    currentUserContent: [{ type: "text", text: "Hello" }],
    systemInstructions: "Use Live Smith tools.",
    history: [],
    agentMessages: [],
    tools: [],
  };
}

test("OAuth backend refreshes once and replays a pre-body unauthorized request", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-oauth-401-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveOAuthCredential(directory, {
    provider: "openai",
    accessToken: "old-access",
    refreshToken: "refresh-1",
    expiresAt: Date.now() + 3_600_000,
    accountId: "account-1",
  });
  let refreshes = 0;
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      throw new Error("unexpected login");
    },
    async refresh(credential) {
      refreshes += 1;
      assert.equal(credential.provider, "openai");
      return { ...credential, accessToken: "new-access" };
    },
    authState() {
      return {
        status: "signed-in",
        accountLabel: "account-1",
        planType: "ChatGPT subscription",
        subscriptionEligible: true,
      };
    },
  };
  const seenAccessTokens: string[] = [];
  const protocol: OAuthModelProtocol = {
    async listModels() {
      return [];
    },
    async createToolTurn(_request, credential) {
      seenAccessTokens.push(credential.accessToken);
      if (credential.accessToken === "old-access") {
        throw new ModelAuthenticationError("ChatGPT Codex authentication was rejected.");
      }
      return { content: "Ready", toolCalls: [] };
    },
  };
  const backend = createNativeOAuthBackend(directory, "openai", {
    adapter,
    protocol,
  });

  assert.deepEqual(await backend.createToolTurn(request()), {
    content: "Ready",
    toolCalls: [],
  });
  assert.deepEqual(seenAccessTokens, ["old-access", "new-access"]);
  assert.equal(refreshes, 1);
  await backend.close();
});

test("OAuth backend bounds repeated unauthorized responses to one refresh", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-oauth-401-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveOAuthCredential(directory, {
    provider: "openai",
    accessToken: "old-access",
    refreshToken: "refresh-1",
    expiresAt: Date.now() + 3_600_000,
    accountId: "account-1",
  });
  let refreshes = 0;
  let requests = 0;
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      throw new Error("unexpected login");
    },
    async refresh(credential) {
      refreshes += 1;
      return { ...credential, accessToken: "new-access" };
    },
    authState() {
      return {
        status: "signed-in",
        accountLabel: null,
        planType: "ChatGPT subscription",
        subscriptionEligible: true,
      };
    },
  };
  const protocol: OAuthModelProtocol = {
    async listModels() {
      return [];
    },
    async createToolTurn() {
      requests += 1;
      throw new ModelAuthenticationError("ChatGPT Codex authentication was rejected.");
    },
  };
  const backend = createNativeOAuthBackend(directory, "openai", {
    adapter,
    protocol,
  });

  await assert.rejects(
    backend.createToolTurn(request()),
    /ChatGPT Codex authentication was rejected/i,
  );
  assert.equal(requests, 2);
  assert.equal(refreshes, 1);
  await backend.close();
});

test("concurrent native OAuth backend closes share credential cleanup", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-oauth-close-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const completion = deferred<{
    provider: "openai";
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    accountId: string;
  }>();
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      return {
        pending: {
          status: "pending",
          verificationUrl: "https://auth.example.test/device",
        },
        completion: completion.promise,
        cancel() {},
      };
    },
    async refresh(credential) {
      return credential;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const protocol: OAuthModelProtocol = {
    async listModels() {
      return [];
    },
    async createToolTurn() {
      return { content: "", toolCalls: [] };
    },
  };
  const backend = createNativeOAuthBackend(directory, "openai", {
    adapter,
    protocol,
  });
  await backend.beginLogin();
  let firstSettled = false;
  let secondSettled = false;
  const first = backend.close().then(() => {
    firstSettled = true;
  });
  const second = backend.close().then(() => {
    secondSettled = true;
  });
  await Promise.resolve();
  const firstSettledBeforeLogin = firstSettled;
  const secondSettledBeforeLogin = secondSettled;
  completion.resolve({
    provider: "openai",
    accessToken: "late-access",
    refreshToken: "refresh-1",
    expiresAt: Date.now() + 3_600_000,
    accountId: "account-1",
  });
  await Promise.all([first, second]);

  assert.equal(firstSettledBeforeLogin, false);
  assert.equal(secondSettledBeforeLogin, false);
});
