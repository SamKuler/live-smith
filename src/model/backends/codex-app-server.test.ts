import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as yieldImmediate } from "node:timers/promises";

import type { TransportRequest } from "../provider.js";
import type { SavedProfile } from "../profile.js";
import {
  createCodexAppServerBackend,
  type CodexRpcConnection,
  type CodexRpcRequestOptions,
} from "./codex-app-server.js";
import { MAX_CODEX_TURN_START_BYTES } from "./codex-limits.js";

type NotificationListener = (params: unknown) => void;

class FakeCodexRpc implements CodexRpcConnection {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly listeners = new Map<string, Set<NotificationListener>>();
  readonly connectionFailureListeners = new Set<(error: Error) => void>();
  account: unknown = {
    account: {
      type: "chatgpt",
      email: "studio@example.test",
      planType: "pro",
    },
    requiresOpenaiAuth: true,
  };
  refreshedAccount: unknown | undefined;
  models: unknown[] = [];
  turnText = JSON.stringify({ content: "Ready", toolCalls: [] });
  forbiddenItem: unknown;
  threadStartError: Error | undefined;
  threadStartGate: Promise<void> | undefined;
  turnStartError: Error | undefined;
  turnStartGate: Promise<void> | undefined;
  turnStartResponseGate: Promise<void> | undefined;
  turnNotificationBeforeStartResponse:
    | "exact-terminal"
    | "forbidden-without-turn-id"
    | "spoof-terminal"
    | undefined;
  conflictingItemAfterTerminal = false;
  conflictingTerminalAfterTerminal = false;
  interruptError: Error | undefined;
  loginCancelError: Error | undefined;
  loginCompletionBeforeStartResponse: unknown;
  unsubscribeError: Error | undefined;
  closeError: Error | undefined;
  threadServiceTier: string | null = null;
  unsubscribeStatus = "unsubscribed";
  unsafeThreadResponse = false;
  completeTurns = true;
  closed = false;
  private loginSequence = 0;
  private threadSequence = 0;

  async request<T>(
    method: string,
    params: unknown,
    options: CodexRpcRequestOptions = {},
  ): Promise<T> {
    this.requests.push({ method, params });
    if (method === "account/read") {
      return ((params as { refreshToken?: boolean }).refreshToken &&
          this.refreshedAccount !== undefined
        ? this.refreshedAccount
        : this.account) as T;
    }
    if (method === "account/login/start") {
      if (this.loginCompletionBeforeStartResponse !== undefined) {
        this.emit(
          "account/login/completed",
          this.loginCompletionBeforeStartResponse,
        );
      }
      return {
        type: "chatgptDeviceCode",
        loginId: `login-${++this.loginSequence}`,
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      } as T;
    }
    if (method === "account/login/cancel") {
      if (this.loginCancelError) throw this.loginCancelError;
      return {} as T;
    }
    if (method === "account/logout") {
      this.account = { account: null, requiresOpenaiAuth: true };
      return {} as T;
    }
    if (method === "model/list") {
      const cursor = (params as { cursor?: string | null }).cursor;
      const midpoint = Math.min(1, this.models.length);
      return (cursor === "page-2"
        ? { data: this.models.slice(midpoint), nextCursor: null }
        : {
            data: this.models.slice(0, midpoint),
            nextCursor: this.models.length > midpoint ? "page-2" : null,
          }) as T;
    }
    if (method === "thread/start") {
      await waitForGate(this.threadStartGate, options.signal);
      if (this.threadStartError) throw this.threadStartError;
      const threadId = `thread-${++this.threadSequence}`;
      return {
        thread: { id: threadId, ephemeral: true },
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        serviceTier: this.threadServiceTier,
        cwd: "/private/runtime",
        runtimeWorkspaceRoots: this.unsafeThreadResponse
          ? ["/private/unexpected-root"]
          : [],
        instructionSources: this.unsafeThreadResponse
          ? ["/private/unexpected-AGENTS.md"]
          : [],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        reasoningEffort: "high",
        multiAgentMode: "explicitRequestOnly",
      } as T;
    }
    if (method === "turn/start") {
      await waitForGate(this.turnStartGate);
      if (this.turnStartError) throw this.turnStartError;
      const threadId = (params as { threadId: string }).threadId;
      const turnId = `turn-${threadId}`;
      if (this.turnNotificationBeforeStartResponse === "exact-terminal") {
        this.completeTurn(threadId);
      } else if (
        this.turnNotificationBeforeStartResponse === "forbidden-without-turn-id"
      ) {
        this.emit("item/started", {
          threadId,
          item: {
            type: "commandExecution",
            id: "command-before-turn-response",
            command: "pwd",
          },
        });
      } else if (this.turnNotificationBeforeStartResponse === "spoof-terminal") {
        const spoofTurnId = "turn-spoof";
        this.emit("item/completed", {
          threadId,
          turnId: spoofTurnId,
          item: {
            type: "agentMessage",
            id: "message-spoof",
            text: JSON.stringify({ content: "spoof accepted", toolCalls: [] }),
            phase: "final_answer",
            memoryCitation: null,
          },
        });
        this.emit("turn/completed", {
          threadId,
          turn: {
            id: spoofTurnId,
            items: [],
            itemsView: { type: "full" },
            status: "completed",
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1,
          },
        });
      }
      if (this.completeTurns) queueMicrotask(() => {
        this.completeTurn(threadId);
      });
      await waitForGate(this.turnStartResponseGate);
      return {
        turn: {
          id: turnId,
          items: [],
          itemsView: { type: "full" },
          status: "inProgress",
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
      } as T;
    }
    if (method === "turn/interrupt") {
      if (this.interruptError) throw this.interruptError;
      return {} as T;
    }
    if (method === "thread/unsubscribe") {
      if (this.unsubscribeError) throw this.unsubscribeError;
      return { status: this.unsubscribeStatus } as T;
    }
    throw new Error(`Unexpected request ${method}.`);
  }

  onNotification(method: string, listener: NotificationListener): () => void {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  onConnectionFailure(listener: (error: Error) => void): () => void {
    this.connectionFailureListeners.add(listener);
    return () => this.connectionFailureListeners.delete(listener);
  }

  failConnection(error: Error): void {
    for (const listener of [...this.connectionFailureListeners]) listener(error);
    this.connectionFailureListeners.clear();
  }

  emit(method: string, params: unknown): void {
    for (const listener of this.listeners.get(method) ?? []) listener(params);
  }

  completeTurn(
    threadId: string,
    status: "completed" | "interrupted" | "failed" = "completed",
  ): void {
    const turnId = `turn-${threadId}`;
    if (this.forbiddenItem !== undefined) {
      this.emit("item/started", {
        threadId,
        turnId,
        item: this.forbiddenItem,
      });
    } else {
      this.emit("item/completed", {
        threadId,
        turnId,
        item: {
          type: "agentMessage",
          id: `message-${threadId}`,
          text: this.turnText,
          phase: "final_answer",
          memoryCitation: null,
        },
      });
    }
    this.emit("turn/completed", {
      threadId,
      turn: {
        id: turnId,
        items: [],
        itemsView: { type: "full" },
        status,
        error: status === "failed" ? { message: "failed" } : null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      },
    });
    if (this.conflictingTerminalAfterTerminal) {
      this.emit("turn/completed", {
        threadId,
        turn: {
          id: turnId,
          items: [],
          itemsView: { type: "full" },
          status: "failed",
          error: { message: "conflicting duplicate terminal" },
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      });
    }
    if (this.conflictingItemAfterTerminal) {
      this.emit("item/started", {
        threadId,
        turnId,
        item: {
          type: "commandExecution",
          id: "command-after-terminal",
          command: "pwd",
        },
      });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.closeError) throw this.closeError;
  }
}

function profile(): SavedProfile {
  return {
    id: "codex-subscription",
    name: "ChatGPT subscription",
    connection: { kind: "codex-subscription", provider: "openai" },
    model: "gpt-5.6-sol",
    parameters: {
      reasoning: { mode: "enabled", effort: "high" },
    },
    advanced: {},
  };
}

function request(
  rpc: FakeCodexRpc,
  overrides: Partial<TransportRequest> = {},
): { rpc: FakeCodexRpc; value: TransportRequest } {
  return {
    rpc,
    value: {
      runtimeProfile: {
        profile: profile(),
        capabilities: {
          tools: true,
          streaming: false,
          temperature: "unsupported",
          reasoning: {
            supported: true,
            canDisable: false,
            efforts: ["low", "medium", "high"],
            budgetTokens: false,
            strategy: "effort",
          },
          inputs: { image: true, audio: true, pdf: false },
        },
        inputCapabilityEvidence: {
          image: "supported",
          audio: "supported",
          pdf: "unsupported",
        },
      },
      currentUserContent: [{ type: "text", text: "Observe the selected clip." }],
      systemInstructions: "You are Live Smith.",
      history: [{ role: "assistant", content: "What should I inspect?" }],
      agentMessages: [],
      tools: [{
        type: "function",
        function: {
          name: "observe_live",
          description: "Observe Live state before planning.",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["scope"],
            properties: { scope: { type: "string" } },
          },
        },
      }],
      ...overrides,
    },
  };
}

test("Codex auth delegates device login and exposes only safe account state", async () => {
  const rpc = new FakeCodexRpc();
  const backend = createCodexAppServerBackend({ rpc });

  assert.deepEqual(await backend.readAuthState(), {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  });
  assert.deepEqual(await backend.beginLogin(), {
    status: "pending",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
  });
  assert.deepEqual(await backend.logout(), { status: "signed-out" });
  assert.deepEqual(
    rpc.requests.filter((entry) => entry.method.startsWith("account/"))
      .map((entry) => [entry.method, entry.params]),
    [
      ["account/read", { refreshToken: false }],
      ["account/login/start", { type: "chatgptDeviceCode" }],
      ["account/login/cancel", { loginId: "login-1" }],
      ["account/logout", undefined],
      ["account/read", { refreshToken: false }],
    ],
  );
});

test("Codex auth reads use explicit passive and readiness refresh modes", async () => {
  const rpc = new FakeCodexRpc();
  const backend = createCodexAppServerBackend({ rpc });

  await backend.readAuthState();
  await backend.readAuthState(undefined, { readiness: false });
  await backend.readAuthState(undefined, { readiness: true });

  assert.deepEqual(
    rpc.requests.filter((entry) => entry.method === "account/read")
      .map((entry) => entry.params),
    [
      { refreshToken: false },
      { refreshToken: false },
      { refreshToken: true },
    ],
  );
});

test("Codex model discovery refreshes auth while model turns stay passive", async () => {
  const rpc = new FakeCodexRpc();
  const backend = createCodexAppServerBackend({ rpc });

  await backend.listModels(profile());
  await backend.createToolTurn(request(rpc).value);

  assert.deepEqual(
    rpc.requests.filter((entry) => entry.method === "account/read")
      .map((entry) => entry.params),
    [
      { refreshToken: true },
      { refreshToken: false },
    ],
  );
});

test("Codex matching login success clears pending before readiness refresh fails permanently", async () => {
  const rpc = new FakeCodexRpc();
  rpc.account = { account: null, requiresOpenaiAuth: true };
  rpc.refreshedAccount = { account: null, requiresOpenaiAuth: true };
  const backend = createCodexAppServerBackend({ rpc });
  await backend.beginLogin();

  rpc.emit("account/login/completed", {
    loginId: "login-1",
    success: true,
    error: null,
    onboardingEntrypoint: null,
  });

  assert.deepEqual(
    await backend.readAuthState(undefined, { readiness: true }),
    { status: "signed-out" },
  );
  assert.deepEqual(
    rpc.requests.filter((entry) => entry.method === "account/read")
      .at(-1)?.params,
    { refreshToken: true },
  );
});

test("Codex matching login failures are definitive and never expose upstream errors", async () => {
  for (const upstreamError of [
    "device authorization failed with bearer-secret",
    "Login timed out",
  ]) {
    const rpc = new FakeCodexRpc();
    rpc.account = { account: null, requiresOpenaiAuth: true };
    rpc.refreshedAccount = { account: null, requiresOpenaiAuth: true };
    const backend = createCodexAppServerBackend({ rpc });
    await backend.beginLogin();

    rpc.emit("account/login/completed", {
      loginId: "login-1",
      success: false,
      error: upstreamError,
      onboardingEntrypoint: null,
    });

    const state = await backend.readAuthState(undefined, { readiness: true });
    assert.deepEqual(state, {
      status: "unavailable",
      message: "ChatGPT sign-in did not complete. Start a new sign-in and try again.",
      definitive: true,
    });
    assert.equal(JSON.stringify(state).includes(upstreamError), false);
  }
});

test("Codex buffers a login completion delivered before the start response", async () => {
  const rpc = new FakeCodexRpc();
  rpc.account = { account: null, requiresOpenaiAuth: true };
  rpc.loginCompletionBeforeStartResponse = {
    loginId: "login-1",
    success: false,
    error: "upstream secret must not escape",
    onboardingEntrypoint: null,
  };
  const backend = createCodexAppServerBackend({ rpc });

  const result = await backend.beginLogin();
  assert.deepEqual(result, {
    status: "unavailable",
    message: "ChatGPT sign-in did not complete. Start a new sign-in and try again.",
    definitive: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /upstream secret/i);
  assert.deepEqual(await backend.readAuthState(), result);
});

test("Codex ignores stale login completions but fails closed on a malformed match", async () => {
  const rpc = new FakeCodexRpc();
  rpc.account = { account: null, requiresOpenaiAuth: true };
  const backend = createCodexAppServerBackend({ rpc });
  await backend.beginLogin();
  const pending = await backend.beginLogin();

  rpc.emit("account/login/completed", {
    loginId: "login-1",
    success: false,
    error: "stale failure",
    onboardingEntrypoint: null,
  });
  assert.deepEqual(await backend.readAuthState(), pending);

  rpc.emit("account/login/completed", {
    loginId: "login-2",
    success: "yes",
    error: "bearer-secret",
    onboardingEntrypoint: null,
  });
  const state = await backend.readAuthState();
  assert.deepEqual(state, {
    status: "unavailable",
    message: "ChatGPT sign-in did not complete. Start a new sign-in and try again.",
    definitive: true,
  });
  assert.equal(JSON.stringify(state).includes("bearer-secret"), false);
});

test("Codex close unsubscribes login completion notifications", async () => {
  const rpc = new FakeCodexRpc();
  rpc.account = { account: null, requiresOpenaiAuth: true };
  const backend = createCodexAppServerBackend({ rpc });
  await backend.beginLogin();
  assert.equal(rpc.listeners.get("account/login/completed")?.size, 1);

  await backend.close();
  assert.equal(rpc.listeners.get("account/login/completed")?.size, 0);
  assert.doesNotThrow(() => rpc.emit("account/login/completed", {
    loginId: "login-1",
    success: false,
    error: "late failure",
    onboardingEntrypoint: null,
  }));
});

test("Codex subscription eligibility fails closed for every workspace plan", async () => {
  for (const [planType, subscriptionEligible] of [
    ["free", true],
    ["go", true],
    ["plus", true],
    ["pro", true],
    ["prolite", true],
    ["team", false],
    ["self_serve_business_prolite", false],
    ["self_serve_business_usage_based", false],
    ["business", false],
    ["ent26", false],
    ["enterprise_cbp_automation", false],
    ["enterprise_cbp_usage_based", false],
    ["enterprise", false],
    ["edu", false],
    ["unknown", false],
  ] as const) {
    const rpc = new FakeCodexRpc();
    rpc.account = {
      account: {
        type: "chatgpt",
        email: "studio@example.test",
        planType,
      },
      requiresOpenaiAuth: true,
    };
    const backend = createCodexAppServerBackend({ rpc });

    assert.deepEqual(await backend.readAuthState(), {
      status: "signed-in",
      accountLabel: "studio@example.test",
      planType,
      subscriptionEligible,
    });
    if (subscriptionEligible) continue;

    await assert.rejects(
      backend.listModels(profile()),
      /workspace-managed ChatGPT plans are not supported/i,
    );
    await assert.rejects(
      backend.createToolTurn(request(rpc).value),
      /workspace-managed ChatGPT plans are not supported/i,
    );
    assert.equal(
      rpc.requests.some((entry) =>
        entry.method === "model/list" || entry.method === "thread/start"
      ),
      false,
      planType,
    );
  }
});

test("Codex auth rejects non-ChatGPT credential modes", async () => {
  const rpc = new FakeCodexRpc();
  rpc.account = { account: { type: "apiKey" }, requiresOpenaiAuth: true };
  const backend = createCodexAppServerBackend({ rpc });

  await assert.rejects(
    backend.readAuthState(),
    /requires a ChatGPT subscription sign-in/i,
  );
});

test("Codex retains the pending login when cancellation is unconfirmed", async () => {
  const rpc = new FakeCodexRpc();
  rpc.account = { account: null, requiresOpenaiAuth: true };
  const backend = createCodexAppServerBackend({ rpc });
  const pending = await backend.beginLogin();
  rpc.loginCancelError = new Error("cancel outcome unknown");

  await assert.rejects(
    backend.beginLogin(),
    /could not cancel the existing ChatGPT sign-in/i,
  );
  assert.equal(
    rpc.requests.filter((entry) => entry.method === "account/login/start").length,
    1,
  );
  assert.deepEqual(await backend.readAuthState(), pending);
});

test("Codex discovery maps every visible paginated model capability", async () => {
  const rpc = new FakeCodexRpc();
  rpc.models = [
    {
      id: "catalog-a",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "high", description: "Deep" },
        { reasoningEffort: "ultra", description: "Maximum depth" },
      ],
      inputModalities: ["text", "image", "audio"],
    },
    {
      id: "catalog-hidden",
      model: "hidden-model",
      displayName: "Hidden",
      hidden: true,
      supportedReasoningEfforts: [],
      inputModalities: ["text"],
    },
  ];
  const backend = createCodexAppServerBackend({ rpc });

  assert.deepEqual(await backend.listModels(profile()), [{
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    capabilities: {
      tools: true,
      streaming: false,
      temperature: "unsupported",
      reasoning: {
        supported: true,
        canDisable: false,
        efforts: ["low", "high", "ultra"],
        budgetTokens: false,
        strategy: "effort",
      },
      inputs: { image: true, audio: true, pdf: false },
    },
  }]);
  assert.equal(
    rpc.requests.filter((entry) => entry.method === "model/list").length,
    2,
  );
});

test("Codex model discovery rejects unknown reasoning efforts explicitly", async () => {
  const rpc = new FakeCodexRpc();
  rpc.models = [{
    id: "catalog-future",
    model: "gpt-future",
    displayName: "GPT Future",
    hidden: false,
    supportedReasoningEfforts: [{
      reasoningEffort: "future-effort",
      description: "Unknown to this Live Smith build",
    }],
    inputModalities: ["text"],
  }];

  await assert.rejects(
    createCodexAppServerBackend({ rpc }).listModels(profile()),
    /unsupported reasoning effort/i,
  );
});

test("Codex turns remain stateless, sandboxed, and normalized to client tool calls", async () => {
  const rpc = new FakeCodexRpc();
  rpc.turnText = JSON.stringify({
    content: null,
    toolCalls: [{
      name: "observe_live",
      arguments: JSON.stringify({ scope: "target" }),
    }],
  });
  const backend = createCodexAppServerBackend({ rpc });
  const fixture = request(rpc);

  assert.deepEqual(await backend.createToolTurn(fixture.value), {
    content: null,
    toolCalls: [{
      id: "codex-thread-1-0",
      name: "observe_live",
      arguments: JSON.stringify({ scope: "target" }),
    }],
  });

  const thread = rpc.requests.find((entry) => entry.method === "thread/start")
    ?.params as Record<string, unknown>;
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.modelProvider, "openai");
  assert.equal(thread.allowProviderModelFallback, false);
  assert.equal(thread.developerInstructions, "");
  assert.equal(thread.personality, "none");
  assert.equal(thread.sandbox, "read-only");
  assert.equal(thread.approvalPolicy, "never");
  assert.equal(thread.serviceTier, null);
  assert.deepEqual(thread.environments, []);
  assert.deepEqual(thread.runtimeWorkspaceRoots, []);
  assert.deepEqual(thread.selectedCapabilityRoots, []);
  assert.deepEqual(thread.dynamicTools, []);

  const turn = rpc.requests.find((entry) => entry.method === "turn/start")
    ?.params as Record<string, unknown>;
  assert.deepEqual(turn.environments, []);
  assert.equal(turn.serviceTier, null);
  assert.equal((turn.outputSchema as { type: string }).type, "object");
  assert.equal(JSON.stringify(turn.outputSchema).includes("oneOf"), false);
  assert.match(JSON.stringify(turn.input), /Observe the selected clip/);
  assert.match(JSON.stringify(thread.baseInstructions), /observe_live/);
  assert.deepEqual(
    rpc.requests.find((entry) => entry.method === "thread/unsubscribe")?.params,
    { threadId: "thread-1" },
  );
});

test("Codex sends the exact ultra reasoning effort in turn/start", async () => {
  const rpc = new FakeCodexRpc();
  const backend = createCodexAppServerBackend({ rpc });
  const fixture = request(rpc);
  fixture.value.runtimeProfile.profile.parameters.reasoning = {
    mode: "enabled",
    effort: "ultra",
  };
  fixture.value.runtimeProfile.capabilities.reasoning.efforts = ["ultra"];

  await backend.createToolTurn(fixture.value);

  const turn = rpc.requests.find((entry) => entry.method === "turn/start")
    ?.params as Record<string, unknown>;
  assert.equal(turn.effort, "ultra");
});

test("Codex rejects a thread that does not honor the model-only boundary", async () => {
  const rpc = new FakeCodexRpc();
  rpc.unsafeThreadResponse = true;

  await assert.rejects(
    createCodexAppServerBackend({ rpc }).createToolTurn(request(rpc).value),
    /did not honor.*model-only thread boundary/i,
  );
  assert.equal(
    rpc.requests.some((entry) => entry.method === "turn/start"),
    false,
  );
  assert.equal(rpc.closed, true);
});

test("Codex closes an unknown thread/start outcome and preserves caller abort", async () => {
  const rpc = new FakeCodexRpc();
  rpc.threadStartGate = new Promise<void>(() => undefined);
  rpc.closeError = new Error("cleanup failed");
  const controller = new AbortController();
  const reason = new Error("stop while starting the thread");
  const turn = createCodexAppServerBackend({ rpc }).createToolTurn(request(rpc, {
    signal: controller.signal,
  }).value);
  await yieldImmediate();

  controller.abort(reason);

  await assert.rejects(turn, (error: unknown) => error === reason);
  assert.equal(rpc.closed, true);
});

test("Codex closes a failed thread/start request", async () => {
  const rpc = new FakeCodexRpc();
  const reason = new Error("thread start outcome unknown");
  rpc.threadStartError = reason;

  await assert.rejects(
    createCodexAppServerBackend({ rpc }).createToolTurn(request(rpc).value),
    (error: unknown) => error === reason,
  );
  assert.equal(rpc.closed, true);
});

test("Codex rejects and closes a non-standard effective service tier", async () => {
  const rpc = new FakeCodexRpc();
  rpc.threadServiceTier = "fast";

  await assert.rejects(
    createCodexAppServerBackend({ rpc }).createToolTurn(request(rpc).value),
    /standard service tier/i,
  );
  assert.equal(rpc.closed, true);
});

test("Codex turns pass images and audio as data URLs but reject PDF", async () => {
  const rpc = new FakeCodexRpc();
  const backend = createCodexAppServerBackend({ rpc });
  const fixture = request(rpc, {
    currentUserContent: [
      { type: "text", text: "Inspect both attachments." },
      {
        type: "image",
        fileName: "clip.png",
        mediaType: "image/png",
        base64: "aW1hZ2U=",
      },
      {
        type: "audio",
        fileName: "clip.wav",
        mediaType: "audio/wav",
        base64: "YXVkaW8=",
      },
    ],
  });

  await backend.createToolTurn(fixture.value);
  const input = (rpc.requests.find((entry) => entry.method === "turn/start")
    ?.params as { input: unknown[] }).input;
  assert.equal(JSON.stringify(input).includes("data:image/png;base64,aW1hZ2U="), true);
  assert.equal(JSON.stringify(input).includes("data:audio/wav;base64,YXVkaW8="), true);

  await assert.rejects(
    backend.createToolTurn(request(rpc, {
      currentUserContent: [{
        type: "document",
        fileName: "score.pdf",
        mediaType: "application/pdf",
        base64: "cGRm",
      }],
    }).value),
    /does not accept PDF/i,
  );
});

test("Codex turns require catalog evidence before sending image or audio", async () => {
  for (const kind of ["image", "audio"] as const) {
    const rpc = new FakeCodexRpc();
    const fixture = request(rpc, {
      currentUserContent: kind === "image"
        ? [{
            type: "image",
            fileName: "clip.png",
            mediaType: "image/png",
            base64: "aW1hZ2U=",
          }]
        : [{
            type: "audio",
            fileName: "clip.wav",
            mediaType: "audio/wav",
            base64: "YXVkaW8=",
          }],
    });
    fixture.value.runtimeProfile.inputCapabilityEvidence = {
      image: kind === "image" ? "unverified" : "supported",
      audio: kind === "audio" ? "unverified" : "supported",
      pdf: "unsupported",
    };

    await assert.rejects(
      createCodexAppServerBackend({ rpc }).createToolTurn(fixture.value),
      new RegExp(`not verified ${kind} input`, "i"),
    );
    assert.equal(
      rpc.requests.some((entry) => entry.method === "thread/start"),
      false,
    );
  }
});

test("Codex rejects an oversized encoded turn before starting it", async () => {
  const rpc = new FakeCodexRpc();
  const fixture = request(rpc, {
    currentUserContent: [{
      type: "text",
      text: "x".repeat(MAX_CODEX_TURN_START_BYTES + 1),
    }],
  });

  await assert.rejects(
    createCodexAppServerBackend({ rpc }).createToolTurn(fixture.value),
    /request is too large/i,
  );
  assert.equal(
    rpc.requests.some((entry) => entry.method === "turn/start"),
    false,
  );
  assert.equal(rpc.closed, false);
});

test("Codex turns reject unknown tools and any default runtime tool activity", async () => {
  const unknownRpc = new FakeCodexRpc();
  unknownRpc.turnText = JSON.stringify({
    content: null,
    toolCalls: [{ name: "shell", arguments: "{}" }],
  });
  await assert.rejects(
    createCodexAppServerBackend({ rpc: unknownRpc }).createToolTurn(
      request(unknownRpc).value,
    ),
    /unknown Live Smith tool/i,
  );

  const forbiddenRpc = new FakeCodexRpc();
  forbiddenRpc.forbiddenItem = {
    type: "commandExecution",
    id: "command-1",
    command: "pwd",
  };
  const forbiddenBackend = createCodexAppServerBackend({ rpc: forbiddenRpc });
  await assert.rejects(
    forbiddenBackend.createToolTurn(request(forbiddenRpc).value),
    /unsupported runtime tool/i,
  );
  assert.equal(
    forbiddenRpc.requests.some((entry) => entry.method === "turn/interrupt"),
    true,
  );
  assert.equal(forbiddenRpc.closed, true);
  await assert.rejects(
    forbiddenBackend.createToolTurn(request(forbiddenRpc).value),
    /closed/i,
  );
});

test("a forbidden terminal turn rejects its pinned first-turn reservation", async () => {
  const rpc = new FakeCodexRpc();
  const backend = createCodexAppServerBackend({ rpc });
  const pinnedFirstTurn = backend.reserveToolTurn();
  rpc.forbiddenItem = {
    type: "commandExecution",
    id: "command-1",
    command: "pwd",
  };

  await assert.rejects(
    backend.createToolTurn(request(rpc).value),
    /unsupported runtime tool/i,
  );
  assert.equal(rpc.closed, false, "the pinned first turn still owns admission");
  assert.throws(
    () => backend.reserveToolTurn(),
    /recycling its ephemeral threads/i,
  );
  await assert.rejects(
    backend.createToolTurn(request(rpc).value),
    /recycling its ephemeral threads/i,
  );

  rpc.forbiddenItem = undefined;
  await assert.rejects(
    pinnedFirstTurn.createToolTurn(request(rpc).value),
    /recycling its ephemeral threads/i,
  );
  assert.equal(
    rpc.requests.filter((entry) => entry.method === "thread/start").length,
    1,
  );
  await pinnedFirstTurn.release();
  assert.equal(rpc.closed, true);
});

test("Codex closes on an uncorrelatable forbidden item before turn/start returns", async () => {
  const rpc = new FakeCodexRpc();
  rpc.completeTurns = false;
  rpc.turnNotificationBeforeStartResponse = "forbidden-without-turn-id";
  const backend = createCodexAppServerBackend({ rpc });
  const controller = new AbortController();
  const cleanupAbort = new Error("test cleanup abort");
  const turn = backend.createToolTurn(request(rpc, {
    signal: controller.signal,
  }).value);
  void turn.catch(() => undefined);

  for (let attempt = 0; attempt < 5; attempt += 1) await yieldImmediate();
  const closedBeforeCleanup = rpc.closed;
  if (!closedBeforeCleanup) controller.abort(cleanupAbort);
  const error = await turn.then(
    () => undefined,
    (reason: unknown) => reason,
  );

  assert.equal(closedBeforeCleanup, true);
  assert.match(String(error), /turn notification|unsupported runtime tool/i);
  assert.equal(
    rpc.requests.filter((entry) => entry.method === "turn/interrupt").length,
    0,
  );
});

test("Codex rejects an early terminal notification for a different turn ID", async () => {
  const rpc = new FakeCodexRpc();
  rpc.completeTurns = false;
  rpc.turnNotificationBeforeStartResponse = "spoof-terminal";
  const backend = createCodexAppServerBackend({ rpc });

  await assert.rejects(
    backend.createToolTurn(request(rpc).value),
    /turn notification/i,
  );
  assert.equal(rpc.closed, true);
  assert.equal(
    rpc.requests.some((entry) => entry.method === "thread/unsubscribe"),
    false,
  );
});

test("an early exact terminal cannot hide abort while turn/start remains unknown", async () => {
  const rpc = new FakeCodexRpc();
  rpc.completeTurns = false;
  rpc.turnNotificationBeforeStartResponse = "exact-terminal";
  let releaseStartResponse!: () => void;
  rpc.turnStartResponseGate = new Promise<void>((resolve) => {
    releaseStartResponse = resolve;
  });
  const backend = createCodexAppServerBackend({ rpc });
  const controller = new AbortController();
  const reason = new Error("stop after early terminal while start is unknown");
  let settled = false;
  let outcome: unknown;
  const turn = backend.createToolTurn(request(rpc, {
    signal: controller.signal,
  }).value);
  void turn.then(
    (value) => {
      settled = true;
      outcome = value;
    },
    (error: unknown) => {
      settled = true;
      outcome = error;
    },
  );
  await waitForTurnStarts(rpc, 1);
  await yieldImmediate();

  controller.abort(reason);
  for (let attempt = 0; attempt < 5; attempt += 1) await yieldImmediate();
  const settledBeforeStartResponse = settled;
  const closedBeforeStartResponse = rpc.closed;
  releaseStartResponse();
  await turn.catch(() => undefined);

  assert.equal(settledBeforeStartResponse, true);
  assert.equal(closedBeforeStartResponse, true);
  assert.equal(outcome, reason);
});

test("Codex rejects a conflicting item delivered with an exact terminal event", async () => {
  const rpc = new FakeCodexRpc();
  rpc.conflictingItemAfterTerminal = true;
  const backend = createCodexAppServerBackend({ rpc });

  await assert.rejects(
    backend.createToolTurn(request(rpc).value),
    /turn notification/i,
  );
  assert.equal(rpc.closed, true);
});

test("Codex rejects a conflicting duplicate terminal notification", async () => {
  const rpc = new FakeCodexRpc();
  rpc.conflictingTerminalAfterTerminal = true;
  const backend = createCodexAppServerBackend({ rpc });

  await assert.rejects(
    backend.createToolTurn(request(rpc).value),
    /turn notification/i,
  );
  assert.equal(rpc.closed, true);
});

test("Codex unsubscribes every validated terminal turn state", async () => {
  for (const status of ["interrupted", "failed"] as const) {
    const rpc = new FakeCodexRpc();
    rpc.completeTurns = false;
    const turn = createCodexAppServerBackend({ rpc }).createToolTurn(
      request(rpc).value,
    );
    await yieldImmediate();

    rpc.completeTurn("thread-1", status);

    await assert.rejects(
      turn,
      status === "interrupted" ? /interrupted/i : /turn failed/i,
    );
    assert.deepEqual(
      rpc.requests.find((entry) => entry.method === "thread/unsubscribe")?.params,
      { threadId: "thread-1" },
    );
  }
});

test("Codex turn cancellation preserves the caller abort and interrupts the turn", async () => {
  const rpc = new FakeCodexRpc();
  rpc.completeTurns = false;
  const backend = createCodexAppServerBackend({ rpc });
  const controller = new AbortController();
  const reason = new Error("stop this model turn");
  const turn = backend.createToolTurn(request(rpc, {
    signal: controller.signal,
  }).value);
  await yieldImmediate();
  controller.abort(reason);

  await assert.rejects(turn, (error: unknown) => error === reason);
  assert.equal(
    rpc.requests.filter((entry) => entry.method === "turn/interrupt").length,
    1,
  );
});

test("Codex preserves caller abort when terminal cleanup also fails", async () => {
  const rpc = new FakeCodexRpc();
  rpc.completeTurns = false;
  rpc.unsubscribeError = new Error("unsubscribe failed");
  rpc.closeError = new Error("recycle close failed");
  const controller = new AbortController();
  const reason = new Error("caller stopped after terminal notification");
  const turn = createCodexAppServerBackend({ rpc }).createToolTurn(request(rpc, {
    signal: controller.signal,
  }).value);
  await yieldImmediate();

  rpc.completeTurn("thread-1");
  controller.abort(reason);

  await assert.rejects(turn, (error: unknown) => error === reason);
  assert.equal(rpc.closed, true);
});

test("Codex preserves an abort that races just before exact terminal cleanup", async () => {
  const rpc = new FakeCodexRpc();
  rpc.completeTurns = false;
  const backend = createCodexAppServerBackend({ rpc });
  const controller = new AbortController();
  const reason = new Error("caller stopped as the terminal event arrived");
  const turn = backend.createToolTurn(request(rpc, {
    signal: controller.signal,
  }).value);
  await waitForTurnStarts(rpc, 1);

  controller.abort(reason);
  rpc.completeTurn("thread-1");

  await assert.rejects(turn, (error: unknown) => error === reason);
  assert.deepEqual(
    rpc.requests.find((entry) => entry.method === "thread/unsubscribe")?.params,
    { threadId: "thread-1" },
  );
  assert.equal(
    rpc.requests.some((entry) => entry.method === "turn/interrupt"),
    false,
  );
});

test("Codex abort closes an unknown turn without waiting for turn/start", {
  timeout: 1_000,
}, async () => {
  const rpc = new FakeCodexRpc();
  let releaseTurnStart!: () => void;
  rpc.turnStartGate = new Promise<void>((resolve) => {
    releaseTurnStart = resolve;
  });
  const controller = new AbortController();
  const reason = new Error("cancel while starting");
  const turn = createCodexAppServerBackend({ rpc }).createToolTurn(request(rpc, {
    signal: controller.signal,
  }).value);
  await yieldImmediate();

  controller.abort(reason);
  await assert.rejects(turn, (error: unknown) => error === reason);
  assert.equal(rpc.closed, true);
  releaseTurnStart();
});

test("Codex turn fails promptly when App Server exits after turn/start", async () => {
  const rpc = new FakeCodexRpc();
  rpc.completeTurns = false;
  const turn = createCodexAppServerBackend({ rpc }).createToolTurn(
    request(rpc).value,
  );
  await yieldImmediate();

  rpc.failConnection(new Error("Codex App Server connection closed."));

  await assert.rejects(turn, /connection closed/i);
});

test("Codex closes the process when turn start or interruption cannot be confirmed", async () => {
  const startFailureRpc = new FakeCodexRpc();
  startFailureRpc.turnStartError = new Error("start outcome unknown");
  await assert.rejects(
    createCodexAppServerBackend({ rpc: startFailureRpc }).createToolTurn(
      request(startFailureRpc).value,
    ),
    /start outcome unknown/,
  );
  assert.equal(startFailureRpc.closed, true);

  const interruptFailureRpc = new FakeCodexRpc();
  interruptFailureRpc.completeTurns = false;
  interruptFailureRpc.interruptError = new Error("interrupt outcome unknown");
  const controller = new AbortController();
  const reason = new Error("stop the turn");
  const turn = createCodexAppServerBackend({
    rpc: interruptFailureRpc,
  }).createToolTurn(request(interruptFailureRpc, {
    signal: controller.signal,
  }).value);
  await yieldImmediate();
  controller.abort(reason);

  await assert.rejects(turn, (error: unknown) => error === reason);
  assert.equal(interruptFailureRpc.closed, true);
});

test("Codex backend permanently reports RPC terminal failure", async () => {
  const rpc = new FakeCodexRpc();
  const backend = createCodexAppServerBackend({ rpc });
  const failures: Error[] = [];
  backend.onTerminal((error) => failures.push(error));
  const reason = new Error("owned App Server exited");

  rpc.failConnection(reason);

  assert.deepEqual(failures, [reason]);
  const lateFailures: Error[] = [];
  backend.onTerminal((error) => lateFailures.push(error));
  assert.deepEqual(lateFailures, [reason]);
});

test("Codex recycles only after the fixed ephemeral-thread threshold drains", async () => {
  const rpc = new FakeCodexRpc();
  const backend = createCodexAppServerBackend({ rpc });
  for (let index = 0; index < 7; index += 1) {
    await backend.createToolTurn(request(rpc).value);
  }
  assert.equal(rpc.closed, false);

  rpc.completeTurns = false;
  const eighth = backend.createToolTurn(request(rpc).value);
  const ninth = backend.createToolTurn(request(rpc).value);
  await yieldImmediate();
  assert.equal(
    rpc.requests.filter((entry) => entry.method === "thread/start").length,
    9,
  );

  rpc.completeTurn("thread-8");
  await eighth;
  assert.equal(rpc.closed, false, "another concurrent turn is still active");

  rpc.completeTurn("thread-9");
  await ninth;
  assert.equal(rpc.closed, true);
});

test("a reserved first turn keeps threshold recycling from crossing persistence", async () => {
  const rpc = new FakeCodexRpc();
  const backend = createCodexAppServerBackend({ rpc });
  for (let index = 0; index < 7; index += 1) {
    await backend.createToolTurn(request(rpc).value);
  }
  const reservation = backend.reserveToolTurn();

  await backend.createToolTurn(request(rpc).value);
  assert.equal(
    rpc.closed,
    false,
    "the eighth turn must drain a pre-persistence reservation before recycle",
  );

  await reservation.createToolTurn(request(rpc).value);
  assert.equal(rpc.closed, true);
  await reservation.release();
  await assert.rejects(
    reservation.createToolTurn(request(rpc).value),
    /no longer available/i,
  );
});

test("an admitted continuation drains while another first-turn reservation delays recycling", async () => {
  const rpc = new FakeCodexRpc();
  const backend = createCodexAppServerBackend({ rpc });
  for (let index = 0; index < 7; index += 1) {
    await backend.createToolTurn(request(rpc).value);
  }
  const otherSendReservation = backend.reserveToolTurn();

  await backend.createToolTurn(request(rpc).value);
  assert.equal(
    rpc.closed,
    false,
    "the outstanding first-turn reservation keeps the backend alive",
  );
  assert.throws(
    () => backend.reserveToolTurn(),
    /recycling its ephemeral threads/i,
    "recycling must stop admitting new sends",
  );

  await backend.createToolTurn(request(rpc).value);
  assert.equal(
    rpc.closed,
    false,
    "an admitted send may continue while the reserved cohort drains",
  );

  await otherSendReservation.release();
  assert.equal(rpc.closed, true);
});

test("threshold recycling grants already queued continuations before closing", async () => {
  const rpc = new FakeCodexRpc();
  const backend = createCodexAppServerBackend({ rpc });
  for (let index = 0; index < 7; index += 1) {
    await backend.createToolTurn(request(rpc).value);
  }
  rpc.completeTurns = false;
  const reservations = Array.from(
    { length: 4 },
    () => backend.reserveToolTurn(),
  );
  const first = backend.createToolTurn(request(rpc, {
    currentUserContent: [{ type: "text", text: "first continuation" }],
  }).value);
  const second = backend.createToolTurn(request(rpc, {
    currentUserContent: [{ type: "text", text: "second continuation" }],
  }).value);
  void first.catch(() => undefined);
  void second.catch(() => undefined);

  assert.equal(await promiseState(first), "pending");
  assert.equal(await promiseState(second), "pending");
  await reservations[0]!.release();
  await waitForTurnStarts(rpc, 8);
  assert.throws(
    () => backend.reserveToolTurn(),
    /recycling its ephemeral threads/i,
  );

  rpc.completeTurn("thread-8");
  await first;
  await waitForTurnStarts(rpc, 9);
  const continuationInputs = rpc.requests
    .filter((entry) => entry.method === "turn/start")
    .slice(-2)
    .map((entry) => JSON.stringify(entry.params));
  assert.match(continuationInputs[0]!, /first continuation/);
  assert.match(continuationInputs[1]!, /second continuation/);
  rpc.completeTurn("thread-9");
  await second;

  await Promise.all(reservations.slice(1).map((reservation) =>
    reservation.release()
  ));
  assert.equal(rpc.closed, true);
});

test("unsafe cleanup blocks every new turn until a pinned reservation releases", async () => {
  const rpc = new FakeCodexRpc();
  const backend = createCodexAppServerBackend({ rpc });
  const otherSendReservation = backend.reserveToolTurn();
  const unsubscribeFailure = new Error("unsubscribe failed");
  rpc.unsubscribeError = unsubscribeFailure;

  await assert.rejects(
    backend.createToolTurn(request(rpc).value),
    (error: unknown) => error === unsubscribeFailure,
  );
  assert.equal(
    rpc.closed,
    false,
    "the outstanding reservation keeps unsafe recycling in its drain phase",
  );
  await assert.rejects(
    backend.createToolTurn(request(rpc).value),
    /recycling its ephemeral threads/i,
  );

  await assert.rejects(
    otherSendReservation.createToolTurn(request(rpc).value),
    /recycling its ephemeral threads/i,
  );
  assert.equal(rpc.closed, false, "the rejected reservation remains pinned");
  await otherSendReservation.release();
  assert.equal(rpc.closed, true);
});

test("unsafe runtime activity rejects queued continuations and closes after active turns drain", async () => {
  const rpc = new FakeCodexRpc();
  rpc.completeTurns = false;
  const backend = createCodexAppServerBackend({ rpc });
  const active = Array.from(
    { length: 4 },
    () => backend.createToolTurn(request(rpc).value),
  );
  for (const turn of active) void turn.catch(() => undefined);
  await waitForTurnStarts(rpc, 4);
  const queued = backend.createToolTurn(request(rpc).value);
  void queued.catch(() => undefined);
  assert.equal(await promiseState(queued), "pending");

  rpc.forbiddenItem = {
    type: "mcpToolCall",
    id: "mcp-1",
    server: "filesystem",
  };
  rpc.completeTurn("thread-1");
  await assert.rejects(queued, /recycling its ephemeral threads/i);
  rpc.forbiddenItem = undefined;
  for (let index = 2; index <= 4; index += 1) {
    rpc.completeTurn(`thread-${index}`);
  }
  const outcomes = await Promise.allSettled(active);
  assert.equal(outcomes[0]?.status, "rejected");
  assert.equal(outcomes.slice(1).every((outcome) => outcome.status === "fulfilled"), true);
  assert.equal(rpc.closed, true);
});

test("queued continuations are FIFO, block new reservations, and honor abort", async () => {
  const rpc = new FakeCodexRpc();
  rpc.completeTurns = false;
  const backend = createCodexAppServerBackend({ rpc });
  const reservations = Array.from(
    { length: 4 },
    () => backend.reserveToolTurn(),
  );
  const first = backend.createToolTurn(request(rpc, {
    currentUserContent: [{ type: "text", text: "first waiter" }],
  }).value);
  const controller = new AbortController();
  const aborted = backend.createToolTurn(request(rpc, {
    currentUserContent: [{ type: "text", text: "aborted waiter" }],
    signal: controller.signal,
  }).value);
  const third = backend.createToolTurn(request(rpc, {
    currentUserContent: [{ type: "text", text: "third waiter" }],
  }).value);
  for (const turn of [first, aborted, third]) void turn.catch(() => undefined);

  assert.equal(await promiseState(first), "pending");
  assert.throws(
    () => backend.reserveToolTurn(),
    /continuations are waiting/i,
  );
  const abortReason = new Error("stop the queued continuation");
  controller.abort(abortReason);
  await assert.rejects(aborted, (error: unknown) => error === abortReason);

  await reservations[0]!.release();
  await waitForTurnStarts(rpc, 1);
  rpc.completeTurn("thread-1");
  await first;
  await waitForTurnStarts(rpc, 2);
  const inputs = rpc.requests
    .filter((entry) => entry.method === "turn/start")
    .map((entry) => JSON.stringify(entry.params));
  assert.match(inputs[0]!, /first waiter/);
  assert.match(inputs[1]!, /third waiter/);
  assert.doesNotMatch(inputs.join("\n"), /aborted waiter/);
  rpc.completeTurn("thread-2");
  await third;
  await Promise.all(reservations.slice(1).map((reservation) =>
    reservation.release()
  ));
});

test("close and RPC terminal failure reject queued continuations", async (t) => {
  await t.test("explicit close", async () => {
    const rpc = new FakeCodexRpc();
    const backend = createCodexAppServerBackend({ rpc });
    const reservations = Array.from(
      { length: 4 },
      () => backend.reserveToolTurn(),
    );
    const queued = backend.createToolTurn(request(rpc).value);
    void queued.catch(() => undefined);

    await backend.close();
    await assert.rejects(queued, /closed/i);
    await Promise.all(reservations.map((reservation) => reservation.release()));
  });

  await t.test("terminal RPC failure", async () => {
    const rpc = new FakeCodexRpc();
    const backend = createCodexAppServerBackend({ rpc });
    const reservations = Array.from(
      { length: 4 },
      () => backend.reserveToolTurn(),
    );
    const queued = backend.createToolTurn(request(rpc).value);
    void queued.catch(() => undefined);
    const failure = new Error("owned App Server exited");

    rpc.failConnection(failure);
    await assert.rejects(queued, (error: unknown) => error === failure);
    await Promise.all(reservations.map((reservation) => reservation.release()));
  });
});

test("Codex keeps at most four ephemeral threads active while a continuation waits", async () => {
  const rpc = new FakeCodexRpc();
  rpc.completeTurns = false;
  const backend = createCodexAppServerBackend({ rpc });
  const active = Array.from(
    { length: 4 },
    () => backend.createToolTurn(request(rpc).value),
  );
  await yieldImmediate();

  const excess = backend.createToolTurn(request(rpc).value);
  void excess.catch(() => undefined);

  assert.equal(await promiseState(excess), "pending");
  assert.equal(
    rpc.requests.filter((entry) => entry.method === "thread/start").length,
    4,
  );
  rpc.completeTurn("thread-1");
  await waitForTurnStarts(rpc, 5);
  assert.equal(
    rpc.requests.filter((entry) => entry.method === "thread/start").length,
    5,
  );
  for (let index = 2; index <= 5; index += 1) {
    rpc.completeTurn(`thread-${index}`);
  }
  await Promise.allSettled([...active, excess]);
  assert.equal(rpc.closed, false);
});

test("Codex drains more than one continuation cohort in FIFO order", async () => {
  const rpc = new FakeCodexRpc();
  rpc.completeTurns = false;
  const backend = createCodexAppServerBackend({ rpc });
  const reservations = Array.from(
    { length: 4 },
    () => backend.reserveToolTurn(),
  );
  const queued = Array.from(
    { length: 8 },
    (_, index) => backend.createToolTurn(request(rpc, {
      currentUserContent: [{
        type: "text",
        text: `continuation waiter ${index + 1}`,
      }],
    }).value),
  );
  for (const turn of queued) void turn.catch(() => undefined);

  assert.equal(await promiseState(queued[0]!), "pending");
  assert.equal(await promiseState(queued.at(-1)!), "pending");
  assert.throws(
    () => backend.reserveToolTurn(),
    /continuations are waiting/i,
  );
  await Promise.all(reservations.map((reservation) => reservation.release()));
  await waitForTurnStarts(rpc, 4);
  for (let index = 1; index <= 4; index += 1) {
    rpc.completeTurn(`thread-${index}`);
  }
  await waitForTurnStarts(rpc, 8);
  const turnInputs = rpc.requests
    .filter((entry) => entry.method === "turn/start")
    .map((entry) => JSON.stringify(entry.params));
  for (let index = 0; index < queued.length; index += 1) {
    assert.match(turnInputs[index]!, new RegExp(`continuation waiter ${index + 1}`));
  }
  for (let index = 5; index <= 8; index += 1) {
    rpc.completeTurn(`thread-${index}`);
  }
  await Promise.all(queued);
});

test("Codex backend closes its owned RPC connection", async () => {
  const rpc = new FakeCodexRpc();
  const backend = createCodexAppServerBackend({ rpc });
  await backend.close();
  assert.equal(rpc.closed, true);
});

async function waitForGate(
  gate: Promise<void> | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!gate) return;
  if (signal?.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([gate, aborted]);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

async function promiseState(
  promise: Promise<unknown>,
): Promise<"fulfilled" | "rejected" | "pending"> {
  return Promise.race([
    promise.then(() => "fulfilled" as const, () => "rejected" as const),
    yieldImmediate().then(() => "pending" as const),
  ]);
}

async function waitForTurnStarts(
  rpc: FakeCodexRpc,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      rpc.requests.filter((entry) => entry.method === "turn/start").length >=
        expected
    ) return;
    await yieldImmediate();
  }
  assert.fail(`Expected ${expected} Codex turns to start.`);
}
