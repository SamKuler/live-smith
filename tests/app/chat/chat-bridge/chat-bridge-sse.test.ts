import assert from "node:assert/strict";
import test from "node:test";
import { createChatBridge } from "../../../../src/app/chat/chat-bridge.js";
import type { ChatDialogState } from "../../../../src/ui/chat-state.js";

for (const scenario of ["command", "send"] as const) {
  test(`SSE delivers a large ${scenario} publication and subsequent frames over a real socket`, { timeout: 5000 }, async () => {
    const content = "x".repeat(128 * 1024);
    const state = { events: [{ id: "history", kind: "assistant", content, createdAt: "2026-10-07T00:00:00.000Z" }] } as ChatDialogState;
    const bridge = await createChatBridge({
      buildState: async () => state, renderHtml: () => "", handleCommand: async () => state,
      handleSend: async (_input, stream) => {
        await stream.assistantDelta(content);
        await stream.progress("After the large frame");
        return state;
      },
    });
    const url = new URL(bridge.url);
    const endpoint = (path: string) => `${url.origin}${path}${url.search}`;
    const response = await fetch(endpoint("/events"));
    const reader = response.body!.getReader();
    const events: Array<Record<string, any>> = [];
    const received = (async () => {
      const decoder = new TextDecoder();
      let pending = "";
      while (!events.some(event => event.type === "session_state_invalidated")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, "Healthy SSE connection must stay open");
        pending += decoder.decode(chunk.value, { stream: true });
        let delimiter: number;
        while ((delimiter = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, delimiter); pending = pending.slice(delimiter + 2);
          const data = frame.split("\n").find(line => line.startsWith("data: "));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    })();
    // Attach rejection handling before issuing the request that used to destroy the socket.
    const result = received.then(() => null, error => error);
    try {
      const http = await fetch(endpoint(`/${scenario}`), {
        method: "POST",
        headers: { "Content-Type": "application/json", [scenario === "send" ? "X-Live-Smith-Send-Id" : "X-Live-Smith-Command-Id"]: "large-publication" },
        body: JSON.stringify(scenario === "send" ? { prompt: "Test", sessionId: "session-1" } : { kind: "select_session", sessionId: "session-1" }),
      });
      assert.equal(http.status, 200); await http.json();
      bridge.publishSessionStateInvalidation("session-1");
      assert.equal(await result, null);
      if (scenario === "command") {
        assert.deepEqual(events.map(event => event.type), ["command_activity", "state", "command_activity", "session_state_invalidated"]);
        assert.equal(events[1]!.state.events[0].content, content);
        assert.equal(events[2]!.command, null);
      } else {
        assert.deepEqual(events[0], { type: "send_activity", sendId: "large-publication", sessionId: "session-1",
          activity: { status: "running", message: "Starting agent loop" }, bridgeStateRevision: "1" });
        assert.equal(events.find(event => event.type === "assistant_delta")?.delta, content);
        assert.ok(events.some(event => event.type === "progress"));
        assert.ok(events.some(event => event.type === "done"));
      }
    } finally { await reader.cancel().catch(() => {}); await bridge.close(); }
  });
}
