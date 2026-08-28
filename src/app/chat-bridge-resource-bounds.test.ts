import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import test from "node:test";
import { URL } from "node:url";

import type { ChatDialogState } from "../ui/chat-state.js";
import { createChatBridge } from "./chat-bridge.js";

test("JSON conflict exits drain request bodies before returning", async () => {
  const state = {} as ChatDialogState;
  const commandStarted = Promise.withResolvers<void>();
  const releaseCommand = Promise.withResolvers<void>();
  const sendStarted = Promise.withResolvers<void>();
  const releaseSend = Promise.withResolvers<void>();
  const resumedPaths: string[] = [];
  const originalResume = IncomingMessage.prototype.resume;
  IncomingMessage.prototype.resume = function trackedResume() {
    if (this.url) resumedPaths.push(new URL(this.url, "http://bridge.test").pathname);
    return originalResume.call(this);
  };
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => {
      commandStarted.resolve();
      await releaseCommand.promise;
      return state;
    },
    handleSend: async () => {
      sendStarted.resolve();
      await releaseSend.promise;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token")!;
  const endpoint = (pathname: string) =>
    `${chatUrl.origin}${pathname}?token=${encodeURIComponent(token)}`;
  const headers = (id: string) => ({
    "Content-Type": "application/json",
    "X-Live-Smith-Command-Id": id,
    "X-Live-Smith-Send-Id": id,
  });

  try {
    const activeCommand = fetch(endpoint("/command"), {
      method: "POST",
      headers: headers("active-command"),
      body: JSON.stringify({ kind: "new_session" }),
    });
    await commandStarted.promise;
    const resumedBeforeConflicts = resumedPaths.length;
    const blockedCommand = await fetch(endpoint("/command"), {
      method: "POST",
      headers: headers("blocked-command"),
      body: JSON.stringify({ kind: "new_session" }),
    });
    const blockedSend = await fetch(endpoint("/send"), {
      method: "POST",
      headers: headers("blocked-send"),
      body: JSON.stringify({ prompt: "Blocked", sessionId: "session-1" }),
    });
    assert.equal(blockedCommand.status, 409);
    assert.equal(blockedSend.status, 409);
    assert.deepEqual(
      new Set(resumedPaths.slice(resumedBeforeConflicts)),
      new Set(["/command", "/send"]),
    );
    releaseCommand.resolve();
    assert.equal((await activeCommand).status, 200);

    const activeSend = fetch(endpoint("/send"), {
      method: "POST",
      headers: headers("active-send"),
      body: JSON.stringify({ prompt: "Hold", sessionId: "session-1" }),
    });
    await sendStarted.promise;
    const resumedBeforeDuplicate = resumedPaths.length;
    const duplicateSend = await fetch(endpoint("/send"), {
      method: "POST",
      headers: headers("active-send"),
      body: JSON.stringify({ prompt: "Duplicate", sessionId: "session-1" }),
    });
    assert.equal(duplicateSend.status, 409);
    assert.ok(resumedPaths.length > resumedBeforeDuplicate);
    releaseSend.resolve();
    assert.equal((await activeSend).status, 200);
  } finally {
    releaseCommand.resolve();
    releaseSend.resolve();
    IncomingMessage.prototype.resume = originalResume;
    await bridge.close();
  }
});

test("an SSE client is disconnected when another frame arrives before drain", async () => {
  const state = {} as ChatDialogState;
  let forcedBackpressure = false;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => undefined,
    writeSseFrame: () => {
      forcedBackpressure = true;
      return false;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token")!;
  const events = await fetch(
    `${chatUrl.origin}/events?token=${encodeURIComponent(token)}`,
  );
  assert.ok(events.body);
  const reader = events.body.getReader();
  await reader.read();
  try {
    bridge.publishSessionStateInvalidation("session-1");
    bridge.publishSessionStateInvalidation("session-1");
    const terminal = await Promise.race([
      reader.read().then(
        ({ done }) => done ? "closed" : "data",
        () => "closed",
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    assert.equal(forcedBackpressure, true);
    assert.equal(terminal, "closed");
  } finally {
    await reader.cancel().catch(() => undefined);
    await bridge.close();
  }
});

test("Session invalidation refreshes use one bounded state query", async () => {
  const state = {} as ChatDialogState;
  const refreshed: string[] = [];
  const bridge = await createChatBridge({
    buildState: async () => state,
    buildInvalidatedSessionState: async (sessionId) => {
      refreshed.push(sessionId);
      return state;
    },
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => undefined,
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token")!;
  const endpoint = (query: string) =>
    `${chatUrl.origin}/state?token=${encodeURIComponent(token)}&${query}`;
  try {
    assert.equal((await fetch(endpoint("sessionId=session-1"))).status, 200);
    assert.deepEqual(refreshed, ["session-1"]);
    assert.equal(
      (await fetch(endpoint("sessionId=session-1&sessionId=session-2"))).status,
      400,
    );
    assert.equal(
      (await fetch(endpoint("sessionId=..%2Foutside"))).status,
      400,
    );
    assert.deepEqual(refreshed, ["session-1"]);
  } finally {
    await bridge.close();
  }
});
