import assert from "node:assert/strict";
import { integrationConnectionsView } from "../storage/settings.js";
import test from "node:test";

import type {
  ContextUsageVisibilityRevision,
  DefaultFollowUpBehaviorRevision,
} from "../model/profile.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { createChatBridge } from "./chat-bridge.js";

function globalSettingsState(
  defaultFollowUpBehavior: "queue" | "steer",
  defaultFollowUpBehaviorRevision: DefaultFollowUpBehaviorRevision,
  showContextUsage = true,
  contextUsageVisibilityRevision: ContextUsageVisibilityRevision = "0",
): ChatDialogState {
  return {
    sessions: [],
    settings: {
      schemaVersion: 8,
      activeProfileId: null,
      profiles: [],
      approvalMode: "manual",
      defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision,
      showContextUsage,
      contextUsageVisibilityRevision,
      customInstructions: "",
      customInstructionsRevision: "0",
      networkProxy: { mode: "none", url: "" },
      networkProxyRevision: "0",
      uiLanguage: "system",
      uiLanguageRevision: "0",
    },
  } as unknown as ChatDialogState;
}

async function readSsePayload(
  response: Response,
  type: string,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      assert.equal(done, false, `SSE ended before ${type}.`);
      pending += decoder.decode(value, { stream: true });
      const frames = pending.split("\n\n");
      pending = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (!data) continue;
        const payload = JSON.parse(data) as Record<string, unknown>;
        if (payload.type === type) return payload;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

test("global follow-up settings are strict commands allowed during an active send", async () => {
  let releaseSend!: () => void;
  let markStarted!: () => void;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const received: unknown[] = [];
  const commandContexts: unknown[] = [];
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (input, _signal, context) => {
      received.push(input);
      commandContexts.push({
        commandId: context.commandId,
        progress: typeof context.progress,
      });
      return state;
    },
    handleSend: async () => {
      markStarted();
      await sendGate;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (pathname: string) =>
    `${chatUrl.origin}${pathname}?token=${token}`;
  const activeSend = fetch(endpoint("/send"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Live-Smith-Send-Id": "settings-active-send",
    },
    body: JSON.stringify({ prompt: "test", sessionId: "session-1" }),
  });

  try {
    await started;
    for (const defaultFollowUpBehavior of ["queue", "steer"] as const) {
      const response = await fetch(endpoint("/command"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Live-Smith-Command-Id": `global-${defaultFollowUpBehavior}`,
        },
        body: JSON.stringify({
          kind: "save_global_settings",
          defaultFollowUpBehavior,
        }),
      });
      assert.equal(response.status, 200);
    }
    const contextResponse = await fetch(endpoint("/command"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "global-context-usage",
      },
      body: JSON.stringify({
        kind: "save_global_settings",
        showContextUsage: false,
      }),
    });
    assert.equal(contextResponse.status, 200);
    const proxyResponse = await fetch(endpoint("/command"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "global-network-proxy",
      },
      body: JSON.stringify({
        kind: "save_global_settings",
        networkProxy: {
          mode: "manual",
          url: "https://Proxy.Example:443/",
        },
      }),
    });
    assert.equal(proxyResponse.status, 200);
    for (const uiLanguage of ["system", "en", "zh-CN"]) {
      const response = await fetch(endpoint("/command"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Live-Smith-Command-Id": `language-${uiLanguage}`,
        },
        body: JSON.stringify({ kind: "save_global_settings", uiLanguage }),
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(received.slice(0, 4), [
      { kind: "save_global_settings", defaultFollowUpBehavior: "queue" },
      { kind: "save_global_settings", defaultFollowUpBehavior: "steer" },
      { kind: "save_global_settings", showContextUsage: false },
      {
        kind: "save_global_settings",
        networkProxy: {
          mode: "manual",
          url: "https://proxy.example",
        },
      },
    ]);
    assert.deepEqual(received.slice(4), [
      { kind: "save_global_settings", uiLanguage: "system" },
      { kind: "save_global_settings", uiLanguage: "en" },
      { kind: "save_global_settings", uiLanguage: "zh-CN" },
    ]);
    assert.deepEqual(commandContexts, [
      { commandId: "global-queue", progress: "function" },
      { commandId: "global-steer", progress: "function" },
      { commandId: "global-context-usage", progress: "function" },
      { commandId: "global-network-proxy", progress: "function" },
      { commandId: "language-system", progress: "function" },
      { commandId: "language-en", progress: "function" },
      { commandId: "language-zh-CN", progress: "function" },
    ]);

    const invalidProxyResponse = await fetch(endpoint("/command"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "invalid-network-proxy",
      },
      body: JSON.stringify({
        kind: "save_global_settings",
        networkProxy: { mode: "manual", url: "ftp://proxy.example" },
      }),
    });
    assert.equal(invalidProxyResponse.status, 400);
    assert.deepEqual(await invalidProxyResponse.json(), {
      error: "Network proxy URL must use HTTP, HTTPS, SOCKS, or SOCKS5.",
      commandId: "invalid-network-proxy",
      field: "networkProxy.url",
    });

    for (const [index, body] of [
      ...[null, true, 1, "", "zh", "en-US", "EN", " en", {}, []].map(
        (uiLanguage) => ({ kind: "save_global_settings", uiLanguage }),
      ),
      ...[
        { defaultFollowUpBehavior: "queue" },
        { showContextUsage: false },
        { networkProxy: { mode: "none", url: "" } },
        { uiLanguageRevision: "1" },
        { sessionId: "session-1" },
        { extra: true },
      ].map((extra) => ({ kind: "save_global_settings", uiLanguage: "en", ...extra })),
      { kind: "save_global_settings", defaultFollowUpBehavior: "unsafe" },
      { kind: "save_global_settings", showContextUsage: "yes" },
      {
        kind: "save_global_settings",
        networkProxy: { mode: "manual", url: "" },
      },
      {
        kind: "save_global_settings",
        networkProxy: { mode: "system", url: "", extra: true },
      },
      {
        kind: "save_global_settings",
        defaultFollowUpBehavior: "queue",
        showContextUsage: true,
      },
      {
        kind: "save_global_settings",
        defaultFollowUpBehavior: "queue",
        networkProxy: { mode: "system", url: "" },
      },
      { kind: "save_global_settings" },
      { kind: "save_global_settings", defaultFollowUpBehavior: "queue", extra: true },
      {
        kind: "save_global_settings",
        defaultFollowUpBehavior: "queue",
        sessionId: "session-1",
      },
      { kind: "save_global_settings", followUpBehavior: "queue" },
    ].entries()) {
      const response = await fetch(endpoint("/command"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Live-Smith-Command-Id": `settings-invalid-${index}`,
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(received.length, 7);
  } finally {
    releaseSend();
    await activeSend;
    await bridge.close();
  }
});

test("global settings reconcile the network proxy by its own revision", async () => {
  const sourceState = globalSettingsState("queue", "0");
  Object.assign(sourceState.settings, {
    networkProxy: { mode: "system", url: "" },
    networkProxyRevision: "0",
    uiLanguage: "system",
    uiLanguageRevision: "0",
  });
  const bridge = await createChatBridge({
    buildState: async () => sourceState,
    renderHtml: () => "<html></html>",
    handleCommand: async () => sourceState,
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (pathname: string) =>
    `${chatUrl.origin}${pathname}?token=${token}`;

  try {
    await (await fetch(endpoint("/state"))).json();
    bridge.publishGlobalSettings({
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "0",
      showContextUsage: true,
      contextUsageVisibilityRevision: "0",
      customInstructions: "",
      customInstructionsRevision: "0",
      networkProxy: { mode: "manual", url: "http://proxy.example:8080" },
      networkProxyRevision: "1",
      uiLanguage: "system",
      uiLanguageRevision: "0",
      commandId: "proxy-1",
    });

    const reconciled = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
    assert.deepEqual(reconciled.settings.networkProxy, {
      mode: "manual",
      url: "http://proxy.example:8080",
    });
    assert.equal(reconciled.settings.networkProxyRevision, "1");

    bridge.publishGlobalSettings({
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "1",
      showContextUsage: true,
      contextUsageVisibilityRevision: "0",
      customInstructions: "",
      customInstructionsRevision: "0",
      networkProxy: { mode: "system", url: "" },
      networkProxyRevision: "0",
      uiLanguage: "system",
      uiLanguageRevision: "0",
      commandId: "behavior-1-stale-proxy",
    });
    const independentlyMerged = await (
      await fetch(endpoint("/state"))
    ).json() as ChatDialogState;
    assert.equal(independentlyMerged.settings.defaultFollowUpBehavior, "steer");
    assert.deepEqual(independentlyMerged.settings.networkProxy, {
      mode: "manual",
      url: "http://proxy.example:8080",
    });
    assert.equal(independentlyMerged.settings.networkProxyRevision, "1");
  } finally {
    await bridge.close();
  }
});

test("global settings replay and reconcile each field by its own revision", async () => {
  let sourceState = globalSettingsState(
    "queue",
    "9007199254740991",
    true,
    "7",
  );
  const pendingAuth = {
    status: "pending" as const,
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
  };
  sourceState.oauthAuth = pendingAuth;
  const bridge = await createChatBridge({
    buildState: async () => sourceState,
    renderHtml: () => "<html></html>",
    handleCommand: async () => sourceState,
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (pathname: string) =>
    `${chatUrl.origin}${pathname}?token=${token}`;
  let firstEvents: Response | undefined;
  let mergedEvents: Response | undefined;
  let correlatedEvents: Response | undefined;
  let reconnectedEvents: Response | undefined;

  try {
    bridge.publishGlobalSettings({
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "9007199254740992",
      showContextUsage: true,
      contextUsageVisibilityRevision: "7",
      customInstructions: "",
      customInstructionsRevision: "0",
      networkProxy: { mode: "none", url: "" },
      networkProxyRevision: "0",
      uiLanguage: "system",
      uiLanguageRevision: "0",
      commandId: "save-steer-2",
    });

    firstEvents = await fetch(endpoint("/events"));
    const firstEvent = await readSsePayload(
      firstEvents,
      "global_settings_changed",
    );
    assert.match(String(firstEvent.bridgeStateRevision), /^[1-9][0-9]*$/);
    delete firstEvent.bridgeStateRevision;
    assert.deepEqual(firstEvent, {
        type: "global_settings_changed",
        defaultFollowUpBehavior: "steer",
        defaultFollowUpBehaviorRevision: "9007199254740992",
        showContextUsage: true,
        contextUsageVisibilityRevision: "7",
        customInstructions: "",
        customInstructionsRevision: "0",
        networkProxy: { mode: "none", url: "" },
        networkProxyRevision: "0",
        uiLanguage: "system",
        uiLanguageRevision: "0",
        commandId: "save-steer-2",
    });

    bridge.publishGlobalSettings({
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "9007199254740992",
      showContextUsage: false,
      contextUsageVisibilityRevision: "8",
      customInstructions: "",
      customInstructionsRevision: "0",
      networkProxy: { mode: "none", url: "" },
      networkProxyRevision: "0",
      uiLanguage: "system",
      uiLanguageRevision: "0",
      commandId: "hide-context-8",
    });
    const overlaid = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
    assert.equal(overlaid.settings.defaultFollowUpBehavior, "steer");
    assert.equal(overlaid.settings.showContextUsage, false);
    assert.equal(
      overlaid.settings.defaultFollowUpBehaviorRevision,
      "9007199254740992",
    );
    assert.equal(overlaid.settings.contextUsageVisibilityRevision, "8");
    assert.deepEqual(overlaid.oauthAuth, pendingAuth);

    sourceState = globalSettingsState(
      "queue",
      "9007199254740993",
      true,
      "7",
    );
    const adopted = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
    assert.equal(adopted.settings.defaultFollowUpBehavior, "queue");
    assert.equal(adopted.settings.showContextUsage, false);
    assert.equal(
      adopted.settings.defaultFollowUpBehaviorRevision,
      "9007199254740993",
    );
    assert.equal(adopted.settings.contextUsageVisibilityRevision, "8");

    bridge.publishGlobalSettings({
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "9007199254740992",
      showContextUsage: true,
      contextUsageVisibilityRevision: "7",
      customInstructions: "",
      customInstructionsRevision: "0",
      networkProxy: { mode: "none", url: "" },
      networkProxyRevision: "0",
      uiLanguage: "system",
      uiLanguageRevision: "0",
      commandId: "stale-save",
    });
    mergedEvents = await fetch(endpoint("/events"));
    const mergedEvent = await readSsePayload(
      mergedEvents,
      "global_settings_changed",
    );
    assert.match(String(mergedEvent.bridgeStateRevision), /^[1-9][0-9]*$/);
    delete mergedEvent.bridgeStateRevision;
    assert.deepEqual(mergedEvent, {
        type: "global_settings_changed",
        defaultFollowUpBehavior: "queue",
        defaultFollowUpBehaviorRevision: "9007199254740993",
        showContextUsage: false,
        contextUsageVisibilityRevision: "8",
        customInstructions: "",
        customInstructionsRevision: "0",
        networkProxy: { mode: "none", url: "" },
        networkProxyRevision: "0",
        uiLanguage: "system",
        uiLanguageRevision: "0",
        commandId: "bridge-state-snapshot",
    });
    await mergedEvents.body?.cancel();
    mergedEvents = undefined;

    bridge.publishGlobalSettings({
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "9007199254740993",
      showContextUsage: false,
      contextUsageVisibilityRevision: "8",
      customInstructions: "",
      customInstructionsRevision: "0",
      networkProxy: { mode: "none", url: "" },
      networkProxyRevision: "0",
      uiLanguage: "system",
      uiLanguageRevision: "0",
      commandId: "save-queue-3",
    });
    correlatedEvents = await fetch(endpoint("/events"));
    const correlatedEvent = await readSsePayload(
      correlatedEvents,
      "global_settings_changed",
    );
    assert.match(String(correlatedEvent.bridgeStateRevision), /^[1-9][0-9]*$/);
    delete correlatedEvent.bridgeStateRevision;
    assert.deepEqual(correlatedEvent, {
      type: "global_settings_changed",
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "9007199254740993",
      showContextUsage: false,
      contextUsageVisibilityRevision: "8",
      customInstructions: "",
      customInstructionsRevision: "0",
      networkProxy: { mode: "none", url: "" },
      networkProxyRevision: "0",
      uiLanguage: "system",
      uiLanguageRevision: "0",
      commandId: "save-queue-3",
    });
    await correlatedEvents.body?.cancel();
    correlatedEvents = undefined;

    bridge.publishGlobalSettings({
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "9007199254740993",
      showContextUsage: true,
      contextUsageVisibilityRevision: "9",
      customInstructions: "",
      customInstructionsRevision: "0",
      networkProxy: { mode: "none", url: "" },
      networkProxyRevision: "0",
      uiLanguage: "system",
      uiLanguageRevision: "0",
      commandId: "show-context-9",
    });
    reconnectedEvents = await fetch(endpoint("/events"));
    const reconnectedEvent = await readSsePayload(
      reconnectedEvents,
      "global_settings_changed",
    );
    assert.match(String(reconnectedEvent.bridgeStateRevision), /^[1-9][0-9]*$/);
    delete reconnectedEvent.bridgeStateRevision;
    assert.deepEqual(reconnectedEvent, {
        type: "global_settings_changed",
        defaultFollowUpBehavior: "queue",
        defaultFollowUpBehaviorRevision: "9007199254740993",
        showContextUsage: true,
        contextUsageVisibilityRevision: "9",
        customInstructions: "",
        customInstructionsRevision: "0",
        networkProxy: { mode: "none", url: "" },
        networkProxyRevision: "0",
        uiLanguage: "system",
        uiLanguageRevision: "0",
        commandId: "show-context-9",
    });
  } finally {
    await firstEvents?.body?.cancel();
    await mergedEvents?.body?.cancel();
    await correlatedEvents?.body?.cancel();
    await reconnectedEvents?.body?.cancel();
    await bridge.close();
  }
});

test("global follow-up reconciliation compares canonical revisions by decimal order", async () => {
  const sourceState = globalSettingsState("queue", "9999999999999999");
  const bridge = await createChatBridge({
    buildState: async () => sourceState,
    renderHtml: () => "<html></html>",
    handleCommand: async () => sourceState,
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (pathname: string) =>
    `${chatUrl.origin}${pathname}?token=${token}`;

  try {
    await (await fetch(endpoint("/state"))).json();
    bridge.publishGlobalSettings({
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "10000000000000000",
      showContextUsage: true,
      contextUsageVisibilityRevision: "0",
      customInstructions: "",
      customInstructionsRevision: "0",
      networkProxy: { mode: "none", url: "" },
      networkProxyRevision: "0",
      uiLanguage: "system",
      uiLanguageRevision: "0",
      commandId: "larger-revision",
    });

    const reconciled = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
    assert.equal(reconciled.settings.defaultFollowUpBehavior, "steer");
    assert.equal(
      reconciled.settings.defaultFollowUpBehaviorRevision,
      "10000000000000000",
    );

    bridge.publishGlobalSettings({
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "9999999999999999",
      showContextUsage: true,
      contextUsageVisibilityRevision: "0",
      customInstructions: "",
      customInstructionsRevision: "0",
      networkProxy: { mode: "none", url: "" },
      networkProxyRevision: "0",
      uiLanguage: "system",
      uiLanguageRevision: "0",
      commandId: "lexically-larger-but-stale",
    });
    const replay = await fetch(endpoint("/events"));
    try {
      const replayEvent = await readSsePayload(
        replay,
        "global_settings_changed",
      );
      assert.match(String(replayEvent.bridgeStateRevision), /^[1-9][0-9]*$/);
      delete replayEvent.bridgeStateRevision;
      assert.deepEqual(replayEvent, {
          type: "global_settings_changed",
          defaultFollowUpBehavior: "steer",
          defaultFollowUpBehaviorRevision: "10000000000000000",
          showContextUsage: true,
          contextUsageVisibilityRevision: "0",
          customInstructions: "",
          customInstructionsRevision: "0",
          networkProxy: { mode: "none", url: "" },
          networkProxyRevision: "0",
          uiLanguage: "system",
          uiLanguageRevision: "0",
          commandId: "larger-revision",
      });
    } finally {
      await replay.body?.cancel();
    }
  } finally {
    await bridge.close();
  }
});

test("language revisions merge independently across stale publications and state snapshots", async () => {
  let source = globalSettingsState("queue", "0");
  const bridge = await createChatBridge({
    buildState: async () => source,
    renderHtml: () => "<html></html>",
    handleCommand: async () => source,
    handleSend: async () => {},
  });
  const url = new URL(bridge.url);
  const endpoint = (route: string) => `${url.origin}${route}?token=${url.searchParams.get("token")}`;
  const state = async () => (await (await fetch(endpoint("/state"))).json()) as ChatDialogState;
  try {
    await state();
    bridge.publishGlobalSettings({
      ...source.settings,
      integrationConnections: integrationConnectionsView(source.settings.integrationConnections),
      uiLanguage: "zh-CN",
      uiLanguageRevision: "9007199254740992",
      commandId: "language-new",
    });
    bridge.publishGlobalSettings({
      ...source.settings,
      integrationConnections: integrationConnectionsView(source.settings.integrationConnections),
      showContextUsage: false,
      contextUsageVisibilityRevision: "1",
      commandId: "context-with-stale-language",
    });
    let merged = await state();
    assert.equal(merged.settings.uiLanguage, "zh-CN");
    assert.equal(merged.settings.uiLanguageRevision, "9007199254740992");
    assert.equal(merged.settings.showContextUsage, false);
    source = globalSettingsState("queue", "0");
    source.settings.uiLanguage = "en";
    source.settings.uiLanguageRevision = "9007199254740993";
    merged = await state();
    assert.equal(merged.settings.uiLanguage, "en");
    assert.equal(merged.settings.contextUsageVisibilityRevision, "1");
    source = globalSettingsState("queue", "0");
    assert.equal((await state()).settings.uiLanguage, "en");
    const abort = new AbortController();
    const stream = await fetch(endpoint("/events"), { signal: abort.signal });
    try {
      const replay = await readSsePayload(stream, "global_settings_changed");
      assert.equal(replay.uiLanguage, "en");
      assert.equal(replay.uiLanguageRevision, "9007199254740993");
      assert.equal(replay.showContextUsage, false);
      assert.deepEqual(replay.networkProxy, { mode: "none", url: "" });
    } finally {
      abort.abort();
    }
  } finally {
    await bridge.close();
  }
});
