import assert from "node:assert/strict";
import test from "node:test";

import type { DefaultFollowUpBehaviorRevision } from "../model/profile.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { createChatBridge } from "./chat-bridge.js";

function globalSettingsState(
  defaultFollowUpBehavior: "queue" | "steer",
  defaultFollowUpBehaviorRevision: DefaultFollowUpBehaviorRevision,
): ChatDialogState {
  return {
    sessions: [],
    settings: {
      schemaVersion: 4,
      activeProfileId: null,
      profiles: [],
      approvalMode: "manual",
      defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision,
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
    assert.deepEqual(received, [
      { kind: "save_global_settings", defaultFollowUpBehavior: "queue" },
      { kind: "save_global_settings", defaultFollowUpBehavior: "steer" },
    ]);
    assert.deepEqual(commandContexts, [
      { commandId: "global-queue" },
      { commandId: "global-steer" },
    ]);

    for (const body of [
      { kind: "save_global_settings", defaultFollowUpBehavior: "unsafe" },
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
    assert.equal(received.length, 2);
  } finally {
    releaseSend();
    await activeSend;
    await bridge.close();
  }
});

test("global follow-up events replay and reconcile states by revision", async () => {
  let sourceState = globalSettingsState("queue", "9007199254740991");
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
  let snapshotEvents: Response | undefined;
  let reconnectedEvents: Response | undefined;

  try {
    bridge.publishDefaultFollowUpBehavior({
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "9007199254740992",
      commandId: "save-steer-2",
    });

    firstEvents = await fetch(endpoint("/events"));
    const firstEvent = await readSsePayload(
      firstEvents,
      "default_follow_up_behavior_changed",
    );
    assert.match(String(firstEvent.bridgeStateRevision), /^[1-9][0-9]*$/);
    delete firstEvent.bridgeStateRevision;
    assert.deepEqual(firstEvent, {
        type: "default_follow_up_behavior_changed",
        defaultFollowUpBehavior: "steer",
        defaultFollowUpBehaviorRevision: "9007199254740992",
        commandId: "save-steer-2",
    });

    const overlaid = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
    assert.equal(overlaid.settings.defaultFollowUpBehavior, "steer");
    assert.equal(
      overlaid.settings.defaultFollowUpBehaviorRevision,
      "9007199254740992",
    );
    assert.deepEqual(overlaid.codexAuth, pendingAuth);

    sourceState = globalSettingsState("queue", "9007199254740993");
    const adopted = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
    assert.equal(adopted.settings.defaultFollowUpBehavior, "queue");
    assert.equal(
      adopted.settings.defaultFollowUpBehaviorRevision,
      "9007199254740993",
    );

    bridge.publishDefaultFollowUpBehavior({
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "9007199254740992",
      commandId: "stale-save",
    });
    snapshotEvents = await fetch(endpoint("/events"));
    const snapshotEvent = await readSsePayload(
      snapshotEvents,
      "default_follow_up_behavior_changed",
    );
    assert.match(String(snapshotEvent.bridgeStateRevision), /^[1-9][0-9]*$/);
    delete snapshotEvent.bridgeStateRevision;
    assert.deepEqual(snapshotEvent, {
        type: "default_follow_up_behavior_changed",
        defaultFollowUpBehavior: "queue",
        defaultFollowUpBehaviorRevision: "9007199254740993",
        commandId: "bridge-state-snapshot",
    });
    await snapshotEvents.body?.cancel();
    snapshotEvents = undefined;

    bridge.publishDefaultFollowUpBehavior({
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "9007199254740993",
      commandId: "save-queue-3",
    });
    reconnectedEvents = await fetch(endpoint("/events"));
    const reconnectedEvent = await readSsePayload(
      reconnectedEvents,
      "default_follow_up_behavior_changed",
    );
    assert.match(String(reconnectedEvent.bridgeStateRevision), /^[1-9][0-9]*$/);
    delete reconnectedEvent.bridgeStateRevision;
    assert.deepEqual(reconnectedEvent, {
        type: "default_follow_up_behavior_changed",
        defaultFollowUpBehavior: "queue",
        defaultFollowUpBehaviorRevision: "9007199254740993",
        commandId: "save-queue-3",
    });
  } finally {
    await firstEvents?.body?.cancel();
    await snapshotEvents?.body?.cancel();
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
    bridge.publishDefaultFollowUpBehavior({
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "10000000000000000",
      commandId: "larger-revision",
    });

    const reconciled = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
    assert.equal(reconciled.settings.defaultFollowUpBehavior, "steer");
    assert.equal(
      reconciled.settings.defaultFollowUpBehaviorRevision,
      "10000000000000000",
    );

    bridge.publishDefaultFollowUpBehavior({
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "9999999999999999",
      commandId: "lexically-larger-but-stale",
    });
    const replay = await fetch(endpoint("/events"));
    try {
      const replayEvent = await readSsePayload(
        replay,
        "default_follow_up_behavior_changed",
      );
      assert.match(String(replayEvent.bridgeStateRevision), /^[1-9][0-9]*$/);
      delete replayEvent.bridgeStateRevision;
      assert.deepEqual(replayEvent, {
          type: "default_follow_up_behavior_changed",
          defaultFollowUpBehavior: "steer",
          defaultFollowUpBehaviorRevision: "10000000000000000",
          commandId: "larger-revision",
      });
    } finally {
      await replay.body?.cancel();
    }
  } finally {
    await bridge.close();
  }
});
