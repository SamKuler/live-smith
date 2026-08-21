import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { LiveInteractionContext } from "../live/context.js";
import type {
  ManagedAuthState,
  ModelBackend,
} from "../model/provider.js";
import { canonicalModelStorageKey } from "../model/shared-backend-manager.js";
import type { SavedProfile } from "../model/profile.js";
import { saveSavedProfile } from "../storage/settings.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { runAgentFlow } from "./agent-flow.js";
import { modelAuthSendFenceForStorage } from "./model-auth-send-fence.js";

const subscriptionProfile: SavedProfile = {
  id: "chatgpt-subscription",
  name: "ChatGPT subscription",
  connection: { kind: "codex-subscription", provider: "openai" },
  model: "gpt-subscription-model",
  parameters: {
    maxOutputTokens: 8192,
    reasoning: { mode: "default" },
  },
  advanced: {},
};

test("a peer state or Check reconciles completed device login ownership", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-auth-reconcile-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);
  const storageKey = await canonicalModelStorageKey(directory);

  let auth: ManagedAuthState = { status: "signed-out" };
  const signedIn = (): ManagedAuthState => ({
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  });
  let completeDuringStart = false;
  let blockConcurrentReadiness = false;
  let concurrentReadinessCalls = 0;
  const concurrentReadinessStarted = deferred<void>();
  const releaseConcurrentReadiness = deferred<void>();
  const backend: ModelBackend = {
    kind: "codex-subscription",
    async listModels() {
      return [{
        id: subscriptionProfile.model,
        displayName: "Subscription model",
        capabilities: { tools: true, streaming: true },
      }];
    },
    async createToolTurn() {
      throw new Error("the injected model turn owns this test");
    },
    reserveToolTurn() {
      return {
        async createToolTurn() {
          throw new Error("the injected model turn owns this test");
        },
        async release() {},
      };
    },
    async readAuthState(signal, options) {
      if (blockConcurrentReadiness && options?.readiness === true) {
        assert.equal(
          signal,
          undefined,
          "a shared pending-login refresh must not inherit its leader's signal",
        );
        concurrentReadinessCalls += 1;
        concurrentReadinessStarted.resolve();
        await releaseConcurrentReadiness.promise;
      }
      return auth;
    },
    async beginLogin() {
      const pending: ManagedAuthState = {
        status: "pending",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      };
      auth = completeDuringStart ? signedIn() : pending;
      return pending;
    },
    async close() {},
  };
  const manager = {
    async codex() { return backend; },
    async codexLease() {
      return { backend, async retire() { return true; } };
    },
    async forProfile() { return backend; },
    async invalidateCodex() {},
    async close() {},
  };
  const ownerUrl = deferred<string>();
  const peerUrl = deferred<string>();
  const closeOwner = deferred<void>();
  const closePeer = deferred<void>();
  const interaction: LiveInteractionContext = {
    defaultPrompt: "Test prompt",
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const contextFor = (
    ready: ReturnType<typeof deferred<string>>,
    close: ReturnType<typeof deferred<void>>,
  ) => ({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        ready.resolve(url);
        await close.promise;
      },
    },
  });
  const dependencies = {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
    requestModelTurn: async () => ({ content: "Ready", toolCalls: [] }),
  };
  const ownerFlow = runAgentFlow(
    contextFor(ownerUrl, closeOwner) as never,
    interaction,
    dependencies,
  );
  const peerFlow = runAgentFlow(
    contextFor(peerUrl, closePeer) as never,
    interaction,
    dependencies,
  );

  try {
    const [ownerDialogUrl, peerDialogUrl] = await Promise.all([
      ownerUrl.promise,
      peerUrl.promise,
    ]);
    const peerInitial = await getState(peerDialogUrl);
    await getState(ownerDialogUrl);

    const firstPending = await command(ownerDialogUrl, {
      kind: "start_codex_login",
    });
    assert.equal(firstPending.status, 200);
    const firstPendingGeneration = modelAuthSendFenceForStorage(storageKey)
      .authGeneration();
    const blockedSend = await send(
      peerDialogUrl,
      peerInitial.activeSessionId,
      "send-before-login-completion",
    );
    assert.equal(blockedSend.status, 409);

    auth = signedIn();
    const peerAfterPassiveRead = await getState(peerDialogUrl);
    assert.equal(peerAfterPassiveRead.codexAuth?.status, "signed-in");
    assert.equal(
      modelAuthSendFenceForStorage(storageKey).authGeneration(),
      firstPendingGeneration + 1,
    );

    auth = { status: "signed-out" };
    const secondPending = await command(ownerDialogUrl, {
      kind: "start_codex_login",
    });
    assert.equal(secondPending.status, 200);
    const secondPendingGeneration = modelAuthSendFenceForStorage(storageKey)
      .authGeneration();
    auth = signedIn();

    const peerCheck = await command(peerDialogUrl, {
      kind: "refresh_codex_account",
    });
    assert.equal(peerCheck.status, 200, await peerCheck.clone().text());
    const peerAfterCheck = await peerCheck.json() as ChatDialogState;
    assert.equal(peerAfterCheck.codexAuth?.status, "signed-in");
    assert.equal(
      modelAuthSendFenceForStorage(storageKey).authGeneration(),
      secondPendingGeneration + 1,
    );

    const allowedSend = await send(
      peerDialogUrl,
      peerAfterCheck.activeSessionId,
      "send-after-peer-reconciliation",
    );
    assert.equal(allowedSend.status, 200, await allowedSend.text());

    auth = { status: "signed-out" };
    completeDuringStart = true;
    const instantCompletion = await command(ownerDialogUrl, {
      kind: "start_codex_login",
    });
    assert.equal(
      instantCompletion.status,
      200,
      await instantCompletion.clone().text(),
    );
    const instantState = await instantCompletion.json() as ChatDialogState;
    assert.equal(instantState.codexAuth?.status, "signed-in");
    const sendAfterInstantCompletion = await send(
      peerDialogUrl,
      peerAfterCheck.activeSessionId,
      "send-after-instant-login-completion",
    );
    assert.equal(
      sendAfterInstantCompletion.status,
      200,
      await sendAfterInstantCompletion.text(),
    );

    completeDuringStart = false;
    auth = { status: "signed-out" };
    const pendingBeforeConcurrentChecks = await command(ownerDialogUrl, {
      kind: "start_codex_login",
    });
    assert.equal(
      pendingBeforeConcurrentChecks.status,
      200,
      await pendingBeforeConcurrentChecks.clone().text(),
    );
    blockConcurrentReadiness = true;
    const firstConcurrentCheck = command(ownerDialogUrl, {
      kind: "refresh_codex_account",
    });
    const secondConcurrentCheck = command(peerDialogUrl, {
      kind: "refresh_codex_account",
    });
    await concurrentReadinessStarted.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(
      concurrentReadinessCalls,
      1,
      "pending-login reconciliation must share one readiness refresh",
    );
    const sendDuringConcurrentCheck = await send(
      peerDialogUrl,
      peerAfterCheck.activeSessionId,
      "send-during-concurrent-login-check",
    );
    assert.equal(sendDuringConcurrentCheck.status, 409);
    releaseConcurrentReadiness.resolve();
    const concurrentChecks = await Promise.all([
      firstConcurrentCheck,
      secondConcurrentCheck,
    ]);
    assert.deepEqual(
      concurrentChecks.map((response) => response.status),
      [200, 200],
    );
    assert.equal(
      concurrentReadinessCalls,
      1,
      "building both Check responses must reuse the shared pending auth state",
    );
    const sendAfterConcurrentChecks = await send(
      peerDialogUrl,
      peerAfterCheck.activeSessionId,
      "send-after-concurrent-login-checks",
    );
    assert.equal(sendAfterConcurrentChecks.status, 409);

    blockConcurrentReadiness = false;
    auth = signedIn();
    const completedAfterConcurrentChecks = await command(ownerDialogUrl, {
      kind: "refresh_codex_account",
    });
    assert.equal(
      completedAfterConcurrentChecks.status,
      200,
      await completedAfterConcurrentChecks.clone().text(),
    );
    const sendAfterCompletion = await send(
      peerDialogUrl,
      peerAfterCheck.activeSessionId,
      "send-after-concurrent-login-completion",
    );
    assert.equal(sendAfterCompletion.status, 200, await sendAfterCompletion.text());
  } finally {
    releaseConcurrentReadiness.resolve();
    closeOwner.resolve();
    closePeer.resolve();
    await Promise.allSettled([ownerFlow, peerFlow]);
  }
});

function endpoint(dialogUrl: string, pathname: string): string {
  const url = new URL(dialogUrl);
  return `${url.origin}${pathname}?token=${url.searchParams.get("token")}`;
}

async function getState(dialogUrl: string): Promise<ChatDialogState> {
  const response = await fetch(endpoint(dialogUrl, "/state"));
  assert.equal(response.status, 200);
  return response.json() as Promise<ChatDialogState>;
}

function command(dialogUrl: string, body: unknown): Promise<Response> {
  return fetch(endpoint(dialogUrl, "/command"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function send(
  dialogUrl: string,
  sessionId: string,
  sendId: string,
): Promise<Response> {
  return fetch(endpoint(dialogUrl, "/send"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Live-Smith-Send-Id": sendId,
    },
    body: JSON.stringify({ prompt: "Use the shared account", sessionId }),
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
