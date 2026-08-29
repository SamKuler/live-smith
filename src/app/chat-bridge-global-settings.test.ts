import assert from "node:assert/strict";
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
      schemaVersion: 6,
      activeProfileId: null,
      profiles: [],
      approvalMode: "manual",
      defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision,
      showContextUsage,
      contextUsageVisibilityRevision,
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
      commandContexts.push(context);
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
    assert.deepEqual(received, [
      { kind: "save_global_settings", defaultFollowUpBehavior: "queue" },
      { kind: "save_global_settings", defaultFollowUpBehavior: "steer" },
      { kind: "save_global_settings", showContextUsage: false },
    ]);
    assert.deepEqual(commandContexts, [
      { commandId: "global-queue" },
      { commandId: "global-steer" },
      { commandId: "global-context-usage" },
    ]);

    for (const body of [
      { kind: "save_global_settings", defaultFollowUpBehavior: "unsafe" },
      { kind: "save_global_settings", showContextUsage: "yes" },
      {
        kind: "save_global_settings",
        defaultFollowUpBehavior: "queue",
        showContextUsage: true,
      },
      { kind: "save_global_settings" },
      { kind: "save_global_settings", defaultFollowUpBehavior: "queue", extra: true },
      {
        kind: "save_global_settings",
        defaultFollowUpBehavior: "queue",
        sessionId: "session-1",
      },
      { kind: "save_global_settings", followUpBehavior: "queue" },
    ]) {
      const response = await fetch(endpoint("/command"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Live-Smith-Command-Id": `settings-command-${body.defaultFollowUpBehavior}`,
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(received.length, 3);
  } finally {
    releaseSend();
    await activeSend;
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
  sourceState.codexAuth = pendingAuth;
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
        commandId: "save-steer-2",
    });

    bridge.publishGlobalSettings({
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "9007199254740992",
      showContextUsage: false,
      contextUsageVisibilityRevision: "8",
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
    assert.deepEqual(overlaid.codexAuth, pendingAuth);

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
        commandId: "bridge-state-snapshot",
    });
    await mergedEvents.body?.cancel();
    mergedEvents = undefined;

    bridge.publishGlobalSettings({
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "9007199254740993",
      showContextUsage: false,
      contextUsageVisibilityRevision: "8",
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
      commandId: "save-queue-3",
    });
    await correlatedEvents.body?.cancel();
    correlatedEvents = undefined;

    bridge.publishGlobalSettings({
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "9007199254740993",
      showContextUsage: true,
      contextUsageVisibilityRevision: "9",
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
          commandId: "larger-revision",
      });
    } finally {
      await replay.body?.cancel();
    }
  } finally {
    await bridge.close();
  }
});
