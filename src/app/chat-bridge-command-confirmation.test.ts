import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { TextDecoder } from "node:util";
import type { ChatDialogState } from "../ui/chat-state.js";
import { createChatBridge } from "./chat-bridge.js";

const state = { status: "Ready" } as ChatDialogState;
const approval = { kind: "apply" as const, message: "Create a MIDI clip", groups: [] };
const endpoint = (url: string, pathname: string) => { const target = new URL(url); target.pathname = pathname; return target; };
function post(url: string, pathname: string, body: unknown, commandId?: string) {
  return fetch(endpoint(url, pathname), { method: "POST", headers: { "Content-Type": "application/json",
    ...(commandId ? { "X-Live-Smith-Command-Id": commandId } : {}) }, body: JSON.stringify(body) });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function confirmationEvent(url: string) {
  const response = await fetch(endpoint(url, "/events"));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      assert.equal(next.done, false);
      text += decoder.decode(next.value, { stream: true });
      const frames = text.split("\n\n");
      text = frames.pop()!;
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (!data) continue;
        const event = JSON.parse(data) as Record<string, unknown>;
        if (event.type === "command_confirm_request") return event;
      }
    }
  } finally { await reader.cancel(); }
}

test("command approval replays the same host request and only its opaque id resolves it", { timeout: 10_000 }, async () => {
  let accepted: boolean | undefined;
  let reached = deferred();
  const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "<html></html>",
    handleSend: async () => {}, handleCommand: async (_input, _signal, context) => {
      const pending = context.requestConfirmation!(approval);
      reached.resolve();
      accepted = await pending;
      return state;
    } });
  try {
    const command = post(bridge.url, "/command", { kind: "archive_session", sessionId: "session-a" }, "command-a");
    await reached.promise;
    const event = await confirmationEvent(bridge.url);
    assert.deepEqual(event, { type: "command_confirm_request", commandId: "command-a", sessionId: "session-a", id: event.id, ...approval });
    assert.match(String(event.id), /^[a-f0-9-]{36}$/u);
    assert.deepEqual(await confirmationEvent(bridge.url), event, "reconnect replays the outstanding request without generating another token");
    assert.equal((await post(bridge.url, "/confirm", { id: "unknown", apply: true })).status, 200);
    assert.equal(accepted, undefined);
    assert.equal((await post(bridge.url, "/confirm", { id: event.id, apply: true, sessionId: "session-b" })).status, 400);
    assert.equal(accepted, undefined);
    assert.equal((await post(bridge.url, "/confirm", { id: event.id, apply: true })).status, 200);
    assert.equal((await command).status, 200);
    assert.equal(accepted, true);
    reached = deferred(); accepted = undefined;
    const second = post(bridge.url, "/command", { kind: "archive_session", sessionId: "session-b" }, "command-b");
    await reached.promise;
    const next = await confirmationEvent(bridge.url);
    assert.notEqual(next.id, event.id);
    assert.equal(next.sessionId, "session-b");
    await post(bridge.url, "/confirm", { id: event.id, apply: true });
    assert.equal(accepted, undefined, "a stale approval cannot approve the next command or Session");
    await post(bridge.url, "/confirm", { id: next.id, apply: false });
    assert.equal((await second).status, 200);
    assert.equal(accepted, false);
  } finally { await bridge.close(); }
});

for (const operation of ["stop", "close"] as const) {
  test(`command confirmation settles false on ${operation}`, { timeout: 10_000 }, async () => {
    const reached = deferred();
    let accepted: boolean | undefined;
    const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "<html></html>",
      handleSend: async () => {}, handleCommand: async (_input, _signal, context) => {
        const pending = context.requestConfirmation!(approval);
        reached.resolve(); accepted = await pending;
        return state;
      } });
    const command = post(bridge.url, "/command", { kind: "archive_session", sessionId: "session-a" }, "command-cancel");
    try {
      await reached.promise;
      const event = await confirmationEvent(bridge.url);
      if (operation === "stop") {
        assert.equal((await post(bridge.url, "/stop", {}, "command-cancel")).status, 200);
        await post(bridge.url, "/confirm", { id: event.id, apply: true });
      } else await bridge.close();
      await command;
      assert.equal(accepted, false);
    } finally { await bridge.close(); }
  });
}
