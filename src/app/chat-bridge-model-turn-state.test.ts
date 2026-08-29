import assert from "node:assert/strict";
import { Buffer as NodeBuffer } from "node:buffer";
import test from "node:test";

import { ModelConnectionError } from "../model/connection-error.js";
import {
  MAX_TRANSIENT_ASSISTANT_DRAFT_BYTES,
  type ChatDialogState,
} from "../ui/chat-state.js";
import { createChatBridge } from "./chat-bridge.js";

const state = {} as ChatDialogState;

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function sendHeaders(sendId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Live-Smith-Send-Id": sendId,
  };
}

test("chat bridge reconnect snapshots transient model state before replaying its confirmation", async () => {
  const confirmationPending = deferred();
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, stream) => {
      await stream.assistantDelta("discarded");
      await stream.webSearchUpdate(searchUpdate("old-search"));
      await stream.assistantReset();
      await stream.assistantDelta("replacement draft");
      await stream.webSearchUpdate(searchUpdate("current-search"));
      await stream.progress("Inspecting sources");
      const confirmation = stream.requestConfirmation({
        kind: "apply",
        message: "Apply?",
        groups: [{ title: "Song", rows: ["Set tempo"] }],
      });
      confirmationPending.resolve();
      await confirmation;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const sendId = "snapshot-send";
  const send = fetch(endpoint("/send"), {
    method: "POST",
    headers: sendHeaders(sendId),
    body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
  });

  try {
    await confirmationPending.promise;
    bridge.publishGlobalSettings({
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "1",
      showContextUsage: true,
      contextUsageVisibilityRevision: "0",
      commandId: "settings-command",
    });
    bridge.publishSessionApprovalMode(
      "s1",
      "manual",
      "2026-08-25T00:00:00.000Z",
    );
    const events = await fetch(endpoint("/events"));
    const publications = await readSsePayloads(events, 4);
    assert.deepEqual(publications.map((payload) => payload.type), [
      "global_settings_changed",
      "approval_mode_changed",
      "model_turn_state",
      "confirm_request",
    ]);
    const snapshot = publications[2];
    const confirmation = publications[3];
    assert.ok(snapshot);
    assert.ok(confirmation);
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "assistantDraft",
      "modelTurnEpoch",
      "progress",
      "resolvedConfirmationGeneration",
      "sendId",
      "sessionId",
      "type",
      "webSearchUpdates",
    ].sort());
    assert.deepEqual(snapshot, {
      type: "model_turn_state",
      sendId,
      sessionId: "s1",
      modelTurnEpoch: 1,
      assistantDraft: "replacement draft",
      webSearchUpdates: [searchUpdate("current-search")],
      progress: "Waiting for confirmation",
      resolvedConfirmationGeneration: 0,
    });
    assert.equal(confirmation.type, "confirm_request");
    assert.equal(confirmation.kind, "apply");
    assert.equal(confirmation.modelTurnEpoch, 1);
    assert.equal(confirmation.confirmationGeneration, 1);
    const response = await fetch(endpoint("/confirm"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: confirmation.id, apply: false }),
    });
    assert.equal(response.status, 200);
    assert.equal((await send).status, 200);
  } finally {
    await bridge.close();
  }
});

test("chat bridge silently advances accepted turns and converges durable transient state", async () => {
  const release = deferred();
  const published = deferred();
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, stream) => {
      await stream.assistantDelta("old");
      await stream.webSearchUpdate(searchUpdate("old-search"));
      await stream.modelTurnAccepted({
        usedTokens: 321,
        contextWindowTokens: 4_096,
      });
      await stream.assistantDelta("durable assistant");
      await stream.webSearchUpdate(searchUpdate("durable-search"));
      await stream.sessionEvent(sessionEvent("assistant-1", "assistant"));
      await stream.sessionEvent(sessionEvent(
        "search-1",
        "web_search",
        searchUpdate("durable-search", "completed"),
      ));
      await stream.progress("Continuing");
      published.resolve();
      await release.promise;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const liveEvents = await fetch(endpoint("/events"));
  const send = fetch(endpoint("/send"), {
    method: "POST",
    headers: sendHeaders("accepted-send"),
    body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
  });

  try {
    const publications = await readSsePayloadsThrough(liveEvents, "progress");
    assert.deepEqual(
      publications.map((payload) => payload.type),
      [
        "assistant_delta",
        "web_search_update",
        "context_usage_update",
        "assistant_delta",
        "web_search_update",
        "session_event",
        "session_event",
        "progress",
      ],
    );
    assert.deepEqual(
      publications.slice(0, 2).map((payload) => payload.modelTurnEpoch),
      [0, 0],
    );
    assert.deepEqual(
      publications.slice(2, 7).map((payload) => payload.modelTurnEpoch),
      [1, 1, 1, 1, 1],
    );
    assert.deepEqual(publications[2], {
      type: "context_usage_update",
      sendId: "accepted-send",
      sessionId: "s1",
      modelTurnEpoch: 1,
      usage: { usedTokens: 321, contextWindowTokens: 4_096 },
    });
    await published.promise;
    const reconnect = await fetch(endpoint("/events"));
    const [snapshot] = await readSsePayloads(reconnect, 1);
    assert.deepEqual(snapshot, {
      type: "model_turn_state",
      sendId: "accepted-send",
      sessionId: "s1",
      modelTurnEpoch: 1,
      assistantDraft: "",
      contextUsage: { usedTokens: 321, contextWindowTokens: 4_096 },
      webSearchUpdates: [],
      progress: "Continuing",
      resolvedConfirmationGeneration: 0,
    });
  } finally {
    release.resolve();
    await send;
    await bridge.close();
  }
});

test("chat bridge distinguishes send startup from an accepted turn without usage", {
  timeout: 2_000,
}, async () => {
  const release = deferred();
  const acceptedMissing = deferred();
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, stream) => {
      await stream.modelTurnAccepted({
        usedTokens: 250,
        contextWindowTokens: 1_000,
      });
      await stream.modelTurnAccepted();
      acceptedMissing.resolve();
      await release.promise;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const events = await fetch(endpoint("/events"));
  const send = fetch(endpoint("/send"), {
    method: "POST",
    headers: sendHeaders("tri-state-send"),
    body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
  });

  try {
    const publications = await readSsePayloads(events, 2);
    assert.deepEqual(publications, [{
      type: "context_usage_update",
      sendId: "tri-state-send",
      sessionId: "s1",
      modelTurnEpoch: 1,
      usage: { usedTokens: 250, contextWindowTokens: 1_000 },
    }, {
      type: "context_usage_update",
      sendId: "tri-state-send",
      sessionId: "s1",
      modelTurnEpoch: 2,
      usage: null,
    }]);
    await acceptedMissing.promise;
    const reconnect = await fetch(endpoint("/events"));
    const [snapshot] = await readSsePayloads(reconnect, 1);
    assert.equal(snapshot?.type, "model_turn_state");
    assert.equal(snapshot?.contextUsage, null);
  } finally {
    release.resolve();
    await send;
    await bridge.close();
  }
});

test("chat bridge reconnect omits stopped sends while retaining another Session's model state", async () => {
  const release = deferred();
  const bothStarted = deferred();
  let startedCount = 0;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (input, stream) => {
      await stream.assistantDelta(`${input.sessionId} draft`);
      startedCount += 1;
      if (startedCount === 2) bothStarted.resolve();
      await release.promise;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const firstSend = fetch(endpoint("/send"), {
    method: "POST",
    headers: sendHeaders("stopped-send"),
    body: JSON.stringify({ prompt: "first", sessionId: "s1" }),
  });
  const backgroundSend = fetch(endpoint("/send"), {
    method: "POST",
    headers: sendHeaders("background-send"),
    body: JSON.stringify({ prompt: "second", sessionId: "s2" }),
  });

  try {
    await bothStarted.promise;
    const stop = await fetch(endpoint("/stop"), {
      method: "POST",
      headers: sendHeaders("stopped-send"),
      body: "{}",
    });
    assert.equal(stop.status, 200);
    const reconnect = await fetch(endpoint("/events"));
    const [snapshot] = await readSsePayloads(reconnect, 1);
    assert.deepEqual(snapshot, {
      type: "model_turn_state",
      sendId: "background-send",
      sessionId: "s2",
      modelTurnEpoch: 0,
      assistantDraft: "s2 draft",
      webSearchUpdates: [],
      progress: "Starting agent loop",
      resolvedConfirmationGeneration: 0,
    });
  } finally {
    release.resolve();
    await Promise.all([firstSend, backgroundSend]);
    await bridge.close();
  }
});

test("chat bridge bounds the UTF-8 transient draft atomically and clears its byte count", {
  timeout: 5_000,
}, async () => {
  const overflowChecked = deferred();
  const continueAfterSnapshot = deferred();
  const release = deferred();
  const exactDraft = "é".repeat(MAX_TRANSIENT_ASSISTANT_DRAFT_BYTES / 2);
  let overflowError: unknown;
  assert.equal(
    NodeBuffer.byteLength(exactDraft, "utf8"),
    MAX_TRANSIENT_ASSISTANT_DRAFT_BYTES,
  );

  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, stream) => {
      await stream.assistantDelta(exactDraft);
      try {
        await stream.assistantDelta("a");
      } catch (error) {
        overflowError = error;
      }
      overflowChecked.resolve();
      await continueAfterSnapshot.promise;

      await stream.assistantReset();
      await stream.assistantDelta(exactDraft);
      await stream.modelTurnAccepted();
      await stream.assistantDelta(exactDraft);
      await stream.sessionEvent(sessionEvent("terminal-assistant", "assistant"));
      await stream.assistantDelta(exactDraft);
      await release.promise;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const send = fetch(endpoint("/send"), {
    method: "POST",
    headers: sendHeaders("bounded-draft-send"),
    body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
  });

  try {
    await overflowChecked.promise;
    assert.ok(overflowError instanceof Error);
    assert.equal(overflowError instanceof ModelConnectionError, false);
    assert.match(
      overflowError.message,
      new RegExp(String(MAX_TRANSIENT_ASSISTANT_DRAFT_BYTES)),
    );

    const reconnect = await fetch(endpoint("/events"));
    const [snapshot] = await readSsePayloads(reconnect, 1);
    assert.equal(snapshot?.type, "model_turn_state");
    assert.equal(snapshot?.assistantDraft === exactDraft, true);

    continueAfterSnapshot.resolve();
    release.resolve();
    assert.equal((await send).status, 200);
  } finally {
    continueAfterSnapshot.resolve();
    release.resolve();
    await send.catch(() => undefined);
    await bridge.close();
  }
});

function searchUpdate(
  id: string,
  status: "searching" | "completed" = "searching",
) {
  return {
    id,
    status,
    action: "search" as const,
    queries: [id],
    sources: [],
  };
}

function sessionEvent(
  id: string,
  kind: "assistant" | "web_search",
  webSearch?: ReturnType<typeof searchUpdate>,
) {
  return {
    id,
    createdAt: "2026-08-23T00:00:00.000Z",
    kind,
    content: id,
    ...(webSearch ? { webSearch } : {}),
  };
}

async function readSsePayloads(
  response: Response,
  count: number,
): Promise<Record<string, unknown>[]> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const payloads: Record<string, unknown>[] = [];
  let received = "";
  try {
    while (payloads.length < count) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Event stream ended before enough payloads arrived.");
      received += NodeBuffer.from(chunk.value).toString("utf8");
      for (;;) {
        const boundary = received.indexOf("\n\n");
        if (boundary < 0) break;
        const block = received.slice(0, boundary);
        received = received.slice(boundary + 2);
        const data = block.split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (data) payloads.push(JSON.parse(data) as Record<string, unknown>);
      }
    }
    return payloads.slice(0, count);
  } finally {
    await reader.cancel();
  }
}

async function readSsePayloadsThrough(
  response: Response,
  terminalType: string,
): Promise<Record<string, unknown>[]> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const payloads: Record<string, unknown>[] = [];
  let received = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Event stream ended before ${terminalType}.`);
      received += NodeBuffer.from(chunk.value).toString("utf8");
      for (;;) {
        const boundary = received.indexOf("\n\n");
        if (boundary < 0) break;
        const block = received.slice(0, boundary);
        received = received.slice(boundary + 2);
        const data = block.split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (!data) continue;
        const payload = JSON.parse(data) as Record<string, unknown>;
        payloads.push(payload);
        if (payload.type === terminalType) return payloads;
      }
    }
  } finally {
    await reader.cancel();
  }
}
