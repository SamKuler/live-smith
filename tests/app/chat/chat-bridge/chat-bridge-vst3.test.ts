import assert from "node:assert/strict";
import test from "node:test";
import { createChatBridge } from "../../../../src/app/chat/chat-bridge.js";
import type { ChatDialogState } from "../../../../src/ui/chat-state.js";

test("VST3 broker issues independent single-use tickets and rejects stale or unauthorized requests", async () => {
  let current = true;
  const bridge = await createChatBridge({
    authorizeVst3Ticket: () => { if (!current) throw new Error("Set changed"); },
    buildState: async () => ({} as ChatDialogState),
    renderHtml: (_state, config) => config.token ? "<html>browser</html>" : "<html>VST3</html>",
    handleCommand: async () => ({} as ChatDialogState),
    handleSend: async () => {},
  });
  try {
    const descriptor = bridge.vst3Broker!;
    assert.ok(descriptor);
    const origin = new URL(bridge.url).origin;
    const endpoint = `${origin}/vst3/tickets`;
    const headers = { Authorization: `Bearer ${descriptor.capability}` };
    assert.equal((await fetch(endpoint, { method: "POST" })).status, 403);
    assert.equal((await fetch(endpoint, { method: "POST", headers: { Authorization: "Bearer wrong" } })).status, 403);
    assert.equal((await fetch(endpoint, { method: "POST", headers: { ...headers, Origin: "https://attacker.invalid" } })).status, 403);
    assert.equal((await fetch(endpoint, { method: "POST", headers, body: "payload" })).status, 403);
    const responses = await Promise.all(Array.from({ length: 2 }, () =>
      fetch(endpoint, { method: "POST", headers })));
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    const tickets = await Promise.all(responses.map(response => response.json() as Promise<{bridgeId: string; launchUrl: string}>));
    assert.equal(tickets[0]!.bridgeId, descriptor.bridgeId);
    assert.notEqual(tickets[0]!.launchUrl, tickets[1]!.launchUrl);
    for (const ticket of tickets) {
      const first = await fetch(ticket.launchUrl);
      assert.equal(first.status, 200);
      assert.match(await first.text(), /VST3/);
      assert.match(first.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
      assert.equal((await fetch(ticket.launchUrl)).status, 403);
    }
    current = false;
    assert.equal((await fetch(endpoint, { method: "POST", headers })).status, 409);
    assert.equal((await fetch(bridge.url)).status, 200);
  } finally { await bridge.close(); }
});
