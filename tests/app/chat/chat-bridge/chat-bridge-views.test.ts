import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import test from "node:test";
import { createChatBridge, type ChatBridgeOptions } from "../../../../src/app/chat/chat-bridge.js";
import type { ChatDialogState } from "../../../../src/ui/chat-state.js";
import { openBridgeEvents } from "../support/bridge-events.js";

test("disconnected views expire after their requests finish without cancelling shared jobs", { timeout: 5000 }, async (t) => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const retired = Promise.withResolvers<void>();
  let closed = false;
  let aborted = false;
  const state = { activeSessionId: "session-1" } as ChatDialogState;
  const handlers: ChatBridgeOptions = {
    buildState: async () => state,
    renderHtml: (_state, configuration) => JSON.stringify({ viewId: configuration.viewId }),
    handleCommand: async () => state,
    handleSend: async (_input, _stream, signal) => {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      started.resolve(); await release.promise; return state;
    },
  };
  const options: ChatBridgeOptions = { ...handlers,
    createView: () => ({ ...handlers, closeView: async () => { closed = true; retired.resolve(); } }),
  };
  const bridge = await createChatBridge(options);
  let events: Awaited<ReturnType<typeof openBridgeEvents>> | undefined;
  let send: Promise<Response> | undefined;
  t.after(async () => {
    release.resolve();
    await events?.close();
    await bridge.close();
    await Promise.allSettled(send ? [send] : []);
  });
  const endpoint = (path: string) => { const url = new URL(bridge.url); url.pathname = path; return url; };
  const page = await (await fetch(bridge.url)).json();
  const headers = { "X-Live-Smith-View-Id": page.viewId };
  const eventUrl = endpoint("/events"); eventUrl.searchParams.set("viewId", page.viewId);
  events = await openBridgeEvents(eventUrl);
  send = fetch(endpoint("/send"), { method: "POST", headers: {
    ...headers, "Content-Type": "application/json", "X-Live-Smith-Send-Id": "retained-job",
  }, body: JSON.stringify({ prompt: "Work", sessionId: "session-1" }) });
    await started.promise;
    options.viewIdleTimeoutMs = 20;
    await events.close();
    await delay(50);
    assert.equal(closed, false, "the running operation retains its view resources");
    assert.equal(aborted, false);
    assert.equal((await fetch(endpoint("/state"), { headers })).status, 200);
    release.resolve(); assert.equal((await send).status, 200);
    await retired.promise;
    assert.equal((await fetch(endpoint("/state"), { headers })).status, 409);
    const reopened = endpoint("/chat"); reopened.searchParams.set("sessionId", "session-1");
    const next = await (await fetch(reopened)).json();
    assert.notEqual(next.viewId, page.viewId);
});
