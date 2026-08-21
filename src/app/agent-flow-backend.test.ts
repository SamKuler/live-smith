import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { LiveInteractionContext } from "../live/context.js";
import type {
  ManagedAuthState,
  ModelBackend,
  TransportRequest,
} from "../model/provider.js";
import type { DraftProfile, SavedProfile } from "../model/profile.js";
import { ModelBackendManager } from "../model/backend-registry.js";
import { loadSessionEvents } from "../storage/events.js";
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

const directProfile: SavedProfile = {
  id: "direct-profile",
  name: "Direct profile",
  connection: {
    kind: "direct-api",
    apiFamily: "openai",
    apiMode: "responses",
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
  },
  model: "test-model",
  parameters: {
    maxOutputTokens: 8192,
    reasoning: { mode: "default" },
  },
  advanced: {},
};

test("agent flow shares one Codex backend across auth and discovery, then closes it", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-flow-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  let auth: ManagedAuthState = { status: "signed-out" };
  let managerCodexCalls = 0;
  let managerProfileCalls = 0;
  let managerCloseCalls = 0;
  const authReadiness: boolean[] = [];
  const backend: ModelBackend = {
    kind: "codex-subscription",
    async listModels(profile: DraftProfile) {
      assert.equal(profile.connection.kind, "codex-subscription");
      return [{
        id: "gpt-subscription-model",
        displayName: "Subscription model",
        capabilities: {
          tools: true,
          streaming: false,
          temperature: "unsupported",
          inputs: { image: true, audio: false, pdf: false },
        },
      }];
    },
    async createToolTurn(_request: TransportRequest) {
      return { content: "unused", toolCalls: [] };
    },
    async readAuthState(_signal, options) {
      authReadiness.push(options?.readiness === true);
      return auth;
    },
    async beginLogin() {
      auth = {
        status: "pending",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      };
      return auth;
    },
    async logout() {
      auth = { status: "signed-out" };
      return auth;
    },
    async close() {},
  };
  const modelBackendManager = {
    async codex() {
      managerCodexCalls += 1;
      return backend;
    },
    async codexLease() {
      managerCodexCalls += 1;
      return { backend, async retire() { return true; } };
    },
    async forProfile(profile: DraftProfile | SavedProfile) {
      managerProfileCalls += 1;
      assert.equal(profile.connection.kind, "codex-subscription");
      return backend;
    },
    async invalidateCodex() {},
    async close() {
      managerCloseCalls += 1;
    },
  };

  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const command = async (body: unknown) => {
          const response = await fetch(endpoint("/command"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          assert.equal(response.status, 200);
          return response.json() as Promise<ChatDialogState>;
        };

        const initial = await (
          await fetch(endpoint("/state"))
        ).json() as ChatDialogState;
        assert.deepEqual(initial.codexAuth, { status: "signed-out" });

        const pending = await command({ kind: "start_codex_login" });
        assert.deepEqual(pending.codexAuth, {
          status: "pending",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
        });
        assert.equal(
          pending.status,
          "Complete ChatGPT sign-in in your browser, then check again.",
        );

        auth = {
          status: "signed-in",
          accountLabel: "studio@example.test",
          planType: "pro",
          subscriptionEligible: true,
        };
        const signedIn = await command({ kind: "refresh_codex_account" });
        assert.deepEqual(signedIn.codexAuth, auth);

        const discovered = await command({
          kind: "discover_models",
          profile: subscriptionProfile,
        });
        assert.deepEqual(
          discovered.availableModels.map((model) => model.id),
          ["gpt-subscription-model"],
        );

        const signedOut = await command({ kind: "logout_codex" });
        assert.deepEqual(signedOut.codexAuth, { status: "signed-out" });
        assert.deepEqual(signedOut.availableModels, []);
      },
    },
  };
  const interaction: LiveInteractionContext = {
    defaultPrompt: "Test prompt",
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager,
  });

  assert.equal(managerProfileCalls, 1);
  assert.equal(managerCodexCalls, 5);
  assert.equal(managerCloseCalls, 1);
  assert.deepEqual(authReadiness, [false, true, true]);
});

test("two dialogs block ChatGPT auth while either dialog has an active send", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-fence-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, directProfile);

  const firstDialogUrl = deferred<string>();
  const secondDialogUrl = deferred<string>();
  const closeFirstDialog = deferred<void>();
  const closeSecondDialog = deferred<void>();
  const modelStarted = deferred<void>();
  let beginLoginCalls = 0;
  let logoutCalls = 0;
  const authBackend: ModelBackend = {
    kind: "codex-subscription",
    async listModels() {
      return [];
    },
    async createToolTurn() {
      return { content: null, toolCalls: [] };
    },
    async beginLogin() {
      beginLoginCalls += 1;
      return {
        status: "pending",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      };
    },
    async logout() {
      logoutCalls += 1;
      return { status: "signed-out" };
    },
    async close() {},
  };
  const inertManager = {
    async codex() {
      return authBackend;
    },
    async codexLease() {
      return { backend: authBackend, async retire() { return true; } };
    },
    async forProfile() {
      throw new Error("The direct request stub owns this test turn.");
    },
    async invalidateCodex() {},
    async close() {},
  };
  const interaction: LiveInteractionContext = {
    defaultPrompt: "Test prompt",
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const contextFor = (
    urlReady: ReturnType<typeof deferred<string>>,
    closeDialog: ReturnType<typeof deferred<void>>,
  ) => ({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        urlReady.resolve(url);
        await closeDialog.promise;
      },
    },
  });

  const firstFlow = runAgentFlow(
    contextFor(firstDialogUrl, closeFirstDialog) as never,
    interaction,
    {
      renderHtml: () => "<html></html>",
      modelBackendManager: inertManager,
      requestModelTurn: async (input) => {
        modelStarted.resolve();
        await new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(input.signal.reason);
          input.signal.addEventListener("abort", onAbort, { once: true });
          if (input.signal.aborted) onAbort();
        });
        throw new Error("unreachable");
      },
    },
  );
  const secondFlow = runAgentFlow(
    contextFor(secondDialogUrl, closeSecondDialog) as never,
    interaction,
    {
      renderHtml: () => "<html></html>",
      modelBackendManager: inertManager,
    },
  );

  try {
    const [firstUrl, secondUrl] = await Promise.all([
      firstDialogUrl.promise,
      secondDialogUrl.promise,
    ]);
    const initial = await (
      await fetch(bridgeEndpoint(firstUrl, "/state"))
    ).json() as ChatDialogState;
    const sendId = "cross-dialog-send";
    const sendResponse = fetch(bridgeEndpoint(firstUrl, "/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": sendId,
      },
      body: JSON.stringify({
        prompt: "Wait until stopped",
        sessionId: initial.activeSessionId,
      }),
    });
    const sendTerminal = sendResponse.then(async (response) => ({
      status: response.status,
      body: await response.text(),
    }));
    const sendStartOutcome = await Promise.race([
      modelStarted.promise.then(() => null),
      sendTerminal,
    ]);
    assert.equal(
      sendStartOutcome,
      null,
      `send ended before reaching the model: ${JSON.stringify(sendStartOutcome)}`,
    );

    const blockedAuth = await fetch(bridgeEndpoint(secondUrl, "/command"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "start_codex_login" }),
    });
    assert.equal(blockedAuth.status, 409);
    assert.match(
      JSON.stringify(await blockedAuth.json()),
      /Stop every active agent request/i,
    );
    assert.equal(beginLoginCalls, 0);

    const stopped = await fetch(bridgeEndpoint(firstUrl, "/stop"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": sendId,
      },
      body: "{}",
    });
    assert.equal(stopped.status, 200);
    await sendTerminal;

    const allowedAuth = await fetch(bridgeEndpoint(secondUrl, "/command"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "start_codex_login" }),
    });
    assert.equal(allowedAuth.status, 200);
    assert.equal(beginLoginCalls, 1);

    const otherModalAuth = await fetch(bridgeEndpoint(firstUrl, "/command"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "start_codex_login" }),
    });
    assert.equal(otherModalAuth.status, 409);
    assert.equal(beginLoginCalls, 1);

    const sendDuringLogin = await fetch(bridgeEndpoint(firstUrl, "/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "send-during-login",
      },
      body: JSON.stringify({
        prompt: "Must remain pending",
        sessionId: initial.activeSessionId,
      }),
    });
    assert.equal(sendDuringLogin.status, 409);
    assert.match(await sendDuringLogin.text(), /sign-in operation/i);

    const logout = await fetch(bridgeEndpoint(secondUrl, "/command"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "logout_codex" }),
    });
    assert.equal(logout.status, 200);
    assert.equal(logoutCalls, 1);
  } finally {
    closeFirstDialog.resolve();
    closeSecondDialog.resolve();
    await Promise.allSettled([firstFlow, secondFlow]);
  }
});

test("an auth change closes another dialog's cached Codex process before state reuse", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-generation-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  let sharedSignedIn = true;
  type BackendRecord = {
    closed: boolean;
    createCalls: number;
    readCalls: number;
  };
  const records: { first: BackendRecord[]; second: BackendRecord[] } = {
    first: [],
    second: [],
  };
  const managerFor = (owner: "first" | "second") => new ModelBackendManager(
    directory,
    {
      startCodexBackend: async () => {
        const capturedSignedIn = sharedSignedIn;
        const record = { closed: false, createCalls: 0, readCalls: 0 };
        records[owner].push(record);
        return {
          kind: "codex-subscription" as const,
          async listModels() {
            return [];
          },
          async createToolTurn() {
            record.createCalls += 1;
            return { content: null, toolCalls: [] };
          },
          async readAuthState(): Promise<ManagedAuthState> {
            record.readCalls += 1;
              return capturedSignedIn
              ? {
                  status: "signed-in",
                  accountLabel: `${owner}@example.test`,
                  planType: "pro",
                  subscriptionEligible: true,
                }
              : { status: "signed-out" };
          },
          async logout(): Promise<ManagedAuthState> {
            sharedSignedIn = false;
            throw new Error("logout response was lost after the side effect");
          },
          async close() {
            record.closed = true;
          },
        };
      },
    },
  );
  const firstManager = managerFor("first");
  const secondManager = managerFor("second");
  const firstDialogUrl = deferred<string>();
  const secondDialogUrl = deferred<string>();
  const closeFirstDialog = deferred<void>();
  const closeSecondDialog = deferred<void>();
  const interaction: LiveInteractionContext = {
    defaultPrompt: "Test prompt",
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const contextFor = (
    urlReady: ReturnType<typeof deferred<string>>,
    closeDialog: ReturnType<typeof deferred<void>>,
  ) => ({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        urlReady.resolve(url);
        await closeDialog.promise;
      },
    },
  });
  const firstFlow = runAgentFlow(
    contextFor(firstDialogUrl, closeFirstDialog) as never,
    interaction,
    { renderHtml: () => "<html></html>", modelBackendManager: firstManager },
  );
  const secondFlow = runAgentFlow(
    contextFor(secondDialogUrl, closeSecondDialog) as never,
    interaction,
    { renderHtml: () => "<html></html>", modelBackendManager: secondManager },
  );

  try {
    const [firstUrl, secondUrl] = await Promise.all([
      firstDialogUrl.promise,
      secondDialogUrl.promise,
    ]);
    const [firstInitial, secondInitial] = await Promise.all([
      fetch(bridgeEndpoint(firstUrl, "/state")).then(
        (response) => response.json() as Promise<ChatDialogState>,
      ),
      fetch(bridgeEndpoint(secondUrl, "/state")).then(
        (response) => response.json() as Promise<ChatDialogState>,
      ),
    ]);
    assert.equal(firstInitial.codexAuth?.status, "signed-in");
    assert.equal(secondInitial.codexAuth?.status, "signed-in");
    const secondOldBackend = records.second[0]!;

    const logout = await fetch(bridgeEndpoint(firstUrl, "/command"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "logout_codex" }),
    });
    assert.equal(logout.status, 200);
    assert.equal(
      ((await logout.json()) as ChatDialogState).codexAuth?.status,
      "signed-out",
    );
    assert.equal(records.first[0]?.closed, true);
    assert.equal(records.first.length, 2);

    const secondAfterLogout = await (
      await fetch(bridgeEndpoint(secondUrl, "/state"))
    ).json() as ChatDialogState;
    assert.equal(secondOldBackend.closed, true);
    assert.equal(secondOldBackend.createCalls, 0);
    assert.equal(records.second.length, 2);
    assert.equal(records.second[1]?.readCalls, 1);
    assert.equal(secondAfterLogout.codexAuth?.status, "signed-out");
  } finally {
    closeFirstDialog.resolve();
    closeSecondDialog.resolve();
    await Promise.allSettled([firstFlow, secondFlow]);
  }
});

test("closing a modal during initial Codex login retires before peers reuse auth", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-abort-generation-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  const loginStarted = deferred<void>();
  const firstCloseStarted = deferred<void>();
  const releaseFirstClose = deferred<void>();
  type BackendRecord = { closed: boolean; readCalls: number };
  const records: { first: BackendRecord[]; second: BackendRecord[] } = {
    first: [],
    second: [],
  };
  const managerFor = (owner: "first" | "second") => new ModelBackendManager(
    directory,
    {
      startCodexBackend: async () => {
        const record = { closed: false, readCalls: 0 };
        const index = records[owner].push(record) - 1;
        return {
          kind: "codex-subscription" as const,
          async listModels() {
            return [];
          },
          async createToolTurn() {
            return { content: null, toolCalls: [] };
          },
          async readAuthState(): Promise<ManagedAuthState> {
            record.readCalls += 1;
            return { status: "signed-out" };
          },
          async beginLogin(signal?: AbortSignal): Promise<ManagedAuthState> {
            if (owner !== "first" || index !== 0) {
              return {
                status: "pending",
                verificationUrl: "https://auth.openai.com/codex/device",
                userCode: "ABCD-EFGH",
              };
            }
            loginStarted.resolve();
            await new Promise<never>((_resolve, reject) => {
              const onAbort = () => reject(signal?.reason);
              signal?.addEventListener("abort", onAbort, { once: true });
              if (signal?.aborted) onAbort();
            });
            throw new Error("unreachable login completion");
          },
          async close() {
            record.closed = true;
            if (owner === "first" && index === 0) {
              firstCloseStarted.resolve();
              await releaseFirstClose.promise;
            }
          },
        };
      },
    },
  );
  const firstManager = managerFor("first");
  const secondManager = managerFor("second");
  const firstDialogUrl = deferred<string>();
  const secondDialogUrl = deferred<string>();
  const closeFirstDialog = deferred<void>();
  const closeSecondDialog = deferred<void>();
  const interaction: LiveInteractionContext = {
    defaultPrompt: "Test prompt",
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const contextFor = (
    urlReady: ReturnType<typeof deferred<string>>,
    closeDialog: ReturnType<typeof deferred<void>>,
  ) => ({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        urlReady.resolve(url);
        await closeDialog.promise;
      },
    },
  });
  const firstFlow = runAgentFlow(
    contextFor(firstDialogUrl, closeFirstDialog) as never,
    interaction,
    { renderHtml: () => "<html></html>", modelBackendManager: firstManager },
  );
  const secondFlow = runAgentFlow(
    contextFor(secondDialogUrl, closeSecondDialog) as never,
    interaction,
    { renderHtml: () => "<html></html>", modelBackendManager: secondManager },
  );
  let loginRequest: Promise<Response> | undefined;

  try {
    const [firstUrl, secondUrl] = await Promise.all([
      firstDialogUrl.promise,
      secondDialogUrl.promise,
    ]);
    await Promise.all([
      fetch(bridgeEndpoint(firstUrl, "/state")),
      fetch(bridgeEndpoint(secondUrl, "/state")),
    ]);
    const secondOldBackend = records.second[0]!;

    loginRequest = fetch(bridgeEndpoint(firstUrl, "/command"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "start_codex_login" }),
    });
    await loginStarted.promise;
    closeFirstDialog.resolve();
    await firstCloseStarted.promise;

    let peerStateSettled = false;
    const peerStateRequest = fetch(bridgeEndpoint(secondUrl, "/state"))
      .then(async (response) => {
        peerStateSettled = true;
        assert.equal(response.status, 200);
        return response.json() as Promise<ChatDialogState>;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(
      peerStateSettled,
      false,
      "peer state must wait until exact backend retirement is confirmed",
    );

    releaseFirstClose.resolve();
    await firstFlow;
    await loginRequest.catch(() => undefined);

    const reconciled = await peerStateRequest;
    assert.equal(reconciled.codexAuth?.status, "signed-out");
    assert.equal(secondOldBackend.closed, true);
    assert.equal(records.second.length, 2);
    assert.equal(records.second[1]?.readCalls, 1);
  } finally {
    releaseFirstClose.resolve();
    closeFirstDialog.resolve();
    closeSecondDialog.resolve();
    await loginRequest?.catch(() => undefined);
    await Promise.allSettled([firstFlow, secondFlow]);
  }
});

test("a failed auth retirement permanently poisons peer auth, state, discovery, and send", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-shutdown-poison-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  let ownerManagerCalls = 0;
  let peerManagerCalls = 0;
  let peerModelCalls = 0;
  const signedIn = (): ManagedAuthState => ({
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  });
  const ownerBackend: ModelBackend = {
    kind: "codex-subscription",
    async listModels() { return []; },
    async createToolTurn() { return { content: null, toolCalls: [] }; },
    async readAuthState() { return signedIn(); },
    async logout() {
      throw new Error("logout outcome is unknown");
    },
    async close() {},
  };
  const peerBackend: ModelBackend = {
    kind: "codex-subscription",
    async listModels() { return []; },
    async createToolTurn() {
      peerModelCalls += 1;
      return { content: "must not run", toolCalls: [] };
    },
    async readAuthState() { return signedIn(); },
    async beginLogin() { return signedIn(); },
    async close() {},
  };
  const ownerManager = {
    async codex() {
      ownerManagerCalls += 1;
      return ownerBackend;
    },
    async codexLease() {
      ownerManagerCalls += 1;
      return {
        backend: ownerBackend,
        async retire() {
          throw new Error("Codex child did not exit after SIGKILL");
        },
      };
    },
    async forProfile() {
      ownerManagerCalls += 1;
      return ownerBackend;
    },
    async invalidateCodex() {
      ownerManagerCalls += 1;
    },
    async close() {},
  };
  const peerManager = {
    async codex() {
      peerManagerCalls += 1;
      return peerBackend;
    },
    async codexLease() {
      peerManagerCalls += 1;
      return { backend: peerBackend, async retire() { return true; } };
    },
    async forProfile() {
      peerManagerCalls += 1;
      return peerBackend;
    },
    async invalidateCodex() {
      peerManagerCalls += 1;
    },
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
  const ownerFlow = runAgentFlow(
    contextFor(ownerUrl, closeOwner) as never,
    interaction,
    { renderHtml: () => "<html></html>", modelBackendManager: ownerManager },
  );
  const peerFlow = runAgentFlow(
    contextFor(peerUrl, closePeer) as never,
    interaction,
    {
      renderHtml: () => "<html></html>",
      modelBackendManager: peerManager,
      requestModelTurn: async () => {
        peerModelCalls += 1;
        return { content: "must not run", toolCalls: [] };
      },
    },
  );

  try {
    const [ownerDialogUrl, peerDialogUrl] = await Promise.all([
      ownerUrl.promise,
      peerUrl.promise,
    ]);
    const [ownerInitial, peerInitial] = await Promise.all([
      fetch(bridgeEndpoint(ownerDialogUrl, "/state")).then(
        (response) => response.json() as Promise<ChatDialogState>,
      ),
      fetch(bridgeEndpoint(peerDialogUrl, "/state")).then(
        (response) => response.json() as Promise<ChatDialogState>,
      ),
    ]);
    assert.equal(ownerInitial.codexAuth?.status, "signed-in");
    assert.equal(peerInitial.codexAuth?.status, "signed-in");

    const logout = await fetch(bridgeEndpoint(ownerDialogUrl, "/command"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "logout_codex" }),
    });
    assert.equal(logout.status, 500);
    const peerCallsBeforePoisonChecks = peerManagerCalls;

    const stateResponse = await fetch(bridgeEndpoint(peerDialogUrl, "/state"));
    assert.equal(stateResponse.status, 500);
    const authResponse = await fetch(bridgeEndpoint(peerDialogUrl, "/command"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "refresh_codex_account" }),
    });
    assert.equal(authResponse.status, 500);
    const discoveryResponse = await fetch(
      bridgeEndpoint(peerDialogUrl, "/command"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "discover_models",
          profile: subscriptionProfile,
        }),
      },
    );
    assert.equal(discoveryResponse.status, 500);
    const sendResponse = await fetch(bridgeEndpoint(peerDialogUrl, "/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "poisoned-peer-send",
      },
      body: JSON.stringify({
        prompt: "Must not be persisted",
        sessionId: peerInitial.activeSessionId,
      }),
    });
    assert.equal(sendResponse.status, 500);
    assert.equal(
      ((await sendResponse.json()) as { promptPersistence?: string })
        .promptPersistence,
      "not_persisted",
    );
    assert.equal(peerManagerCalls, peerCallsBeforePoisonChecks);
    assert.equal(peerModelCalls, 0);
    assert.equal(
      (await loadSessionEvents(directory, peerInitial.activeSessionId)).some(
        (event) => event.kind === "user",
      ),
      false,
    );
  } finally {
    closeOwner.resolve();
    closePeer.resolve();
    await Promise.allSettled([ownerFlow, peerFlow]);
  }
});

test("a peer subscription send waits for logout and fails before prompt persistence", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-send-preflight-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  let auth: ManagedAuthState = {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  const logoutStarted = deferred<void>();
  const releaseLogout = deferred<void>();
  let peerListCalls = 0;
  let peerModelCalls = 0;
  const backendFor = (owner: "owner" | "peer"): ModelBackend => ({
    kind: "codex-subscription",
    async listModels() {
      if (owner === "peer") peerListCalls += 1;
      return [{
        id: subscriptionProfile.model,
        displayName: "Subscription model",
        capabilities: { tools: true, streaming: true },
      }];
    },
    async createToolTurn() {
      if (owner === "peer") peerModelCalls += 1;
      return { content: "must not run", toolCalls: [] };
    },
    async readAuthState() { return auth; },
    async logout() {
      logoutStarted.resolve();
      await releaseLogout.promise;
      auth = { status: "signed-out" };
      return auth;
    },
    async close() {},
  });
  const managerFor = (owner: "owner" | "peer") => {
    const backend = backendFor(owner);
    return {
      async codex() { return backend; },
      async codexLease() {
        return { backend, async retire() { return true; } };
      },
      async forProfile() { return backend; },
      async invalidateCodex() {},
      async close() {},
    };
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
  const ownerFlow = runAgentFlow(
    contextFor(ownerUrl, closeOwner) as never,
    interaction,
    {
      renderHtml: () => "<html></html>",
      modelBackendManager: managerFor("owner"),
    },
  );
  const peerFlow = runAgentFlow(
    contextFor(peerUrl, closePeer) as never,
    interaction,
    {
      renderHtml: () => "<html></html>",
      modelBackendManager: managerFor("peer"),
      requestModelTurn: async () => {
        peerModelCalls += 1;
        return { content: "must not run", toolCalls: [] };
      },
    },
  );

  try {
    const [ownerDialogUrl, peerDialogUrl] = await Promise.all([
      ownerUrl.promise,
      peerUrl.promise,
    ]);
    const [ownerInitial, peerInitial] = await Promise.all([
      fetch(bridgeEndpoint(ownerDialogUrl, "/state")).then(
        (response) => response.json() as Promise<ChatDialogState>,
      ),
      fetch(bridgeEndpoint(peerDialogUrl, "/state")).then(
        (response) => response.json() as Promise<ChatDialogState>,
      ),
    ]);
    assert.equal(ownerInitial.codexAuth?.status, "signed-in");
    assert.equal(peerInitial.codexAuth?.status, "signed-in");

    const logoutRequest = fetch(bridgeEndpoint(ownerDialogUrl, "/command"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "logout_codex" }),
    });
    await logoutStarted.promise;
    let sendSettled = false;
    const sendRequest = fetch(bridgeEndpoint(peerDialogUrl, "/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "send-after-cross-modal-logout",
      },
      body: JSON.stringify({
        prompt: "Must remain queued until auth settles",
        sessionId: peerInitial.activeSessionId,
      }),
    }).then((response) => {
      sendSettled = true;
      return response;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(sendSettled, false);

    releaseLogout.resolve();
    assert.equal((await logoutRequest).status, 200);
    const sendResponse = await sendRequest;
    assert.notEqual(sendResponse.status, 200);
    const sendBody = await sendResponse.json() as {
      error?: string;
      promptPersistence?: string;
    };
    assert.equal(sendBody.promptPersistence, "not_persisted");
    assert.match(sendBody.error ?? "", /eligible ChatGPT subscription|sign in/i);
    assert.equal(peerListCalls, 1);
    assert.equal(peerModelCalls, 0);
    assert.equal(
      (await loadSessionEvents(directory, peerInitial.activeSessionId)).some(
        (event) => event.kind === "user",
      ),
      false,
    );
  } finally {
    releaseLogout.resolve();
    closeOwner.resolve();
    closePeer.resolve();
    await Promise.allSettled([ownerFlow, peerFlow]);
  }
});

test("subscription sends refresh catalogs, hand off later turns, and reject a missing model before persistence", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-send-catalog-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  let sessionId = "";
  let listCalls = 0;
  let modelCalls = 0;
  let managerProfileCalls = 0;
  let selectedModelAvailable = true;
  const turnBackends: Array<ModelBackend | undefined> = [];
  const turnReservations: unknown[] = [];
  const authReadiness: boolean[] = [];
  const continuationStarted = deferred<void>();
  const releaseContinuation = deferred<void>();
  let reservationReleaseCalls = 0;
  const firstTurnReservation = {
    async createToolTurn() {
      throw new Error("the injected turn function owns this test");
    },
    async release() {
      reservationReleaseCalls += 1;
    },
  };
  const backend: ModelBackend = {
    kind: "codex-subscription",
    async listModels() {
      listCalls += 1;
      assert.equal(
        (await loadSessionEvents(directory, sessionId)).filter(
          (event) => event.kind === "user",
        ).length,
        listCalls === 1 ? 0 : 1,
        "catalog preflight must finish before the prompt is appended",
      );
      return [{
        id: selectedModelAvailable ? subscriptionProfile.model : "other-model",
        displayName: "Subscription model",
        capabilities: { tools: true, streaming: true },
      }];
    },
    async createToolTurn(request) {
      assert.equal(request.runtimeProfile.profile.model, subscriptionProfile.model);
      throw new Error("the injected turn function owns this test");
    },
    reserveToolTurn() {
      return firstTurnReservation;
    },
    async readAuthState(_signal, options) {
      authReadiness.push(options?.readiness === true);
      return {
        status: "signed-in",
        accountLabel: "studio@example.test",
        planType: "pro",
        subscriptionEligible: true,
      };
    },
    async close() {},
  };
  const replacementBackend: ModelBackend = {
    ...backend,
    async close() {},
  };
  const manager = {
    async codex() { return backend; },
    async codexLease() {
      return { backend, async retire() { return true; } };
    },
    async forProfile() {
      managerProfileCalls += 1;
      return replacementBackend;
    },
    async invalidateCodex() {},
    async close() {},
  };
  const interaction: LiveInteractionContext = {
    defaultPrompt: "Test prompt",
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const initialResponse = await fetch(bridgeEndpoint(url, "/state"));
        assert.equal(initialResponse.status, 200);
        const initial = await initialResponse.json() as ChatDialogState;
        sessionId = initial.activeSessionId;
        assert.deepEqual(initial.availableModels, []);

        let sendSettled = false;
        const sendRequest = fetch(bridgeEndpoint(url, "/send"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Send-Id": "catalog-preflight-send",
          },
          body: JSON.stringify({
            prompt: "Use the subscription catalog",
            sessionId,
          }),
        }).then((response) => {
          sendSettled = true;
          return response;
        });
        await continuationStarted.promise;
        assert.equal(sendSettled, false);
        assert.equal(
          (await loadSessionEvents(directory, sessionId)).filter(
            (event) => event.kind === "user",
          ).length,
          1,
          "a waiting continuation must not duplicate or fail the persisted prompt",
        );
        releaseContinuation.resolve();
        const response = await sendRequest;
        assert.equal(response.status, 200, await response.text());

        const refresh = await fetch(bridgeEndpoint(url, "/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "refresh_codex_account" }),
        });
        assert.equal(refresh.status, 200, await refresh.text());
        selectedModelAvailable = false;
        const unavailable = await fetch(bridgeEndpoint(url, "/send"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Send-Id": "missing-catalog-model-send",
          },
          body: JSON.stringify({
            prompt: "Do not persist this unavailable-model prompt",
            sessionId,
          }),
        });
        const unavailableBody = await unavailable.json() as {
          error?: string;
          promptPersistence?: string;
        };
        assert.equal(unavailable.status, 409, JSON.stringify(unavailableBody));
        assert.equal(unavailableBody.promptPersistence, "not_persisted");
        assert.match(unavailableBody.error ?? "", /model is not available/i);
        assert.equal(
          (await loadSessionEvents(directory, sessionId)).filter(
            (event) => event.kind === "user",
          ).length,
          1,
        );
      },
    },
  };

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
    requestModelTurn: async (input) => {
      modelCalls += 1;
      turnBackends.push(input.backend);
      turnReservations.push(input.turnReservation);
      if (modelCalls === 1) {
        return {
          content: "Catalog ",
          toolCalls: [],
          continuation: { reason: "output_limit" },
          providerState: { replay: "first-turn" },
        };
      }
      continuationStarted.resolve();
      await releaseContinuation.promise;
      return { content: "ready", toolCalls: [] };
    },
  });
  assert.equal(listCalls, 2);
  assert.equal(modelCalls, 2);
  assert.equal(managerProfileCalls, 1);
  assert.deepEqual(turnBackends, [backend, replacementBackend]);
  assert.deepEqual(turnReservations, [firstTurnReservation, undefined]);
  assert.equal(reservationReleaseCalls, 1);
  assert.deepEqual(authReadiness, [false, false, true, false]);
});

test("threshold reservation cleanup preserves a pre-first-turn caller abort and poisons reuse", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-reservation-abort-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  const modelStarted = deferred<void>();
  const releaseError = new Error("threshold recycle close failed");
  let reservationCreateCalls = 0;
  let reservationReleaseCalls = 0;
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
      throw new Error("the reserved first turn must own this request");
    },
    reserveToolTurn() {
      return {
        async createToolTurn() {
          reservationCreateCalls += 1;
          throw new Error("the injected turn must abort before consumption");
        },
        async release() {
          reservationReleaseCalls += 1;
          throw releaseError;
        },
      };
    },
    async readAuthState() {
      return {
        status: "signed-in",
        accountLabel: "studio@example.test",
        planType: "pro",
        subscriptionEligible: true,
      };
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
  const interaction: LiveInteractionContext = {
    defaultPrompt: "Test prompt",
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const initial = await fetch(bridgeEndpoint(url, "/state")).then(
          (response) => response.json() as Promise<ChatDialogState>,
        );
        const sendId = "reservation-abort-send";
        const send = fetch(bridgeEndpoint(url, "/send"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Send-Id": sendId,
          },
          body: JSON.stringify({
            prompt: "Stop before the reserved turn is consumed",
            sessionId: initial.activeSessionId,
          }),
        });
        await modelStarted.promise;
        const stopped = await fetch(bridgeEndpoint(url, "/stop"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Send-Id": sendId,
          },
          body: "{}",
        });
        assert.equal(stopped.status, 200);

        const response = await send;
        const body = await response.text();
        assert.notEqual(response.status, 200);
        assert.match(body, /Stopped by user/i);
        assert.doesNotMatch(body, /threshold recycle close failed/i);
        await assert.rejects(
          modelAuthSendFenceForStorage(directory).enterRead(),
          /could not be shut down safely/i,
        );
      },
    },
  };

  await assert.rejects(
    runAgentFlow(context as never, interaction, {
      renderHtml: () => "<html></html>",
      modelBackendManager: manager,
      requestModelTurn: async (input) => {
        modelStarted.resolve();
        await new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(input.signal.reason);
          input.signal.addEventListener("abort", onAbort, { once: true });
          if (input.signal.aborted) onAbort();
        });
        throw new Error("unreachable");
      },
    }),
    /could not be shut down safely/i,
  );
  assert.equal(reservationCreateCalls, 0);
  assert.equal(reservationReleaseCalls, 1);
});

test("a modal close failure poisons the shared fence before its owner is released", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-modal-close-poison-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, directProfile);

  const firstUrl = deferred<string>();
  const peerUrl = deferred<string>();
  const closeFirst = deferred<void>();
  const closePeer = deferred<void>();
  let peerManagerCalls = 0;
  const firstManager = {
    async codex() { throw new Error("unused"); },
    async codexLease() { throw new Error("unused"); },
    async forProfile() { throw new Error("unused"); },
    async invalidateCodex() {},
    async close() {
      throw new Error("Codex child shutdown could not be confirmed");
    },
  };
  const peerManager = {
    async codex() {
      peerManagerCalls += 1;
      throw new Error("must not start after poison");
    },
    async codexLease() {
      peerManagerCalls += 1;
      throw new Error("must not start after poison");
    },
    async forProfile() {
      peerManagerCalls += 1;
      throw new Error("must not start after poison");
    },
    async invalidateCodex() {
      peerManagerCalls += 1;
    },
    async close() {},
  };
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
  const firstFlow = runAgentFlow(
    contextFor(firstUrl, closeFirst) as never,
    interaction,
    { renderHtml: () => "<html></html>", modelBackendManager: firstManager },
  );
  const peerFlow = runAgentFlow(
    contextFor(peerUrl, closePeer) as never,
    interaction,
    { renderHtml: () => "<html></html>", modelBackendManager: peerManager },
  );

  try {
    const [, peerDialogUrl] = await Promise.all([
      firstUrl.promise,
      peerUrl.promise,
    ]);
    assert.equal((await fetch(bridgeEndpoint(peerDialogUrl, "/state"))).status, 200);
    closeFirst.resolve();
    await assert.rejects(firstFlow, /shutdown could not be confirmed/i);

    assert.equal((await fetch(bridgeEndpoint(peerDialogUrl, "/state"))).status, 500);
    const send = await fetch(bridgeEndpoint(peerDialogUrl, "/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "send-after-modal-close-poison",
      },
      body: JSON.stringify({
        prompt: "Must not start",
        sessionId: "session-does-not-matter",
      }),
    });
    assert.equal(send.status, 500);
    assert.equal(
      ((await send.json()) as { promptPersistence?: string }).promptPersistence,
      "not_persisted",
    );
    assert.equal(peerManagerCalls, 0);
  } finally {
    closeFirst.resolve();
    closePeer.resolve();
    await Promise.allSettled([firstFlow, peerFlow]);
  }
});

function bridgeEndpoint(dialogUrl: string, pathname: string): string {
  const url = new URL(dialogUrl);
  return `${url.origin}${pathname}?token=${url.searchParams.get("token")}`;
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
