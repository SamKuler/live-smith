import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { URL } from "node:url";
import { createChatBridge } from "../../../../src/app/chat/chat-bridge.js";
import type { ChatDialogState } from "../../../../src/ui/chat-state.js";
import { runAgentFlow } from "../../../../src/app/agent-flow.js";
import { createSession } from "../../../../src/storage/sessions.js";
import { appendSessionEvent } from "../../../../src/storage/events.js";
import { liveContextPresentationFixture } from "../../context/support/live-context.test-harness.js";
import type { LiveInteractionContext } from "../../../../src/live/context.js";

const headers = { "Content-Type": "application/json" };
function route(base: string, pathname: string) { const url = new URL(base); url.pathname = pathname; return url; }

test("Session search is an authenticated, bounded read without a command or send", async () => {
  const calls: unknown[] = [];
  const bridge = await createChatBridge({ buildState: async () => ({} as ChatDialogState), renderHtml: () => "",
    handleCommand: async () => assert.fail("Search must not mutate Sessions"), handleSend: async () => assert.fail("Search must not send"),
    ...{ searchSessions: async (input: { query: string; offset: number }, signal: AbortSignal) => {
      assert.equal(signal.aborted, false); calls.push(input);
      return { ...input, matches: [], total: 0, unavailableCount: 0 };
    } },
  });
  const target = route(bridge.url, "/session-search");
  const post = (input: unknown, url = target) => fetch(url, { method: "POST", headers, body: JSON.stringify(input) });
  try {
    const denied = new URL(target); denied.search = "";
    assert.equal((await post({ query: "bass" }, denied)).status, 403);
    for (const input of [null, [], {}, { query: 3 }, { query: "x".repeat(201) },
      { query: "bass", offset: -1 }, { query: "bass", offset: .5 }, { query: "bass", apiKey: "forbidden" }]) {
      const response = await post(input); assert.equal(response.status, 400); await response.text();
    }
    assert.deepEqual(calls, []);
    const response = await post({ query: "  Bass  ", offset: 0 });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    assert.deepEqual(await response.json(), { query: "Bass", offset: 0, matches: [], total: 0, unavailableCount: 0 });
    assert.deepEqual(calls, [{ query: "Bass", offset: 0 }]);
    const extraQuery = new URL(target); extraQuery.searchParams.set("extra", "x");
    const invalid = await post({ query: "bass" }, extraQuery); assert.equal(invalid.status, 400); await invalid.text();
    assert.equal(calls.length, 1);
  } finally { await bridge.close(); }
});

test("artifact list accepts a bounded search query and keeps its Session and page", async () => {
  const calls: unknown[] = [];
  const bridge = await createChatBridge({ buildState: async () => ({} as ChatDialogState), renderHtml: () => "",
    handleCommand: async () => assert.fail("Search must not run a command"), handleSend: async () => {},
    readSessionArtifacts: async (input) => { calls.push(input); return { ...input, artifacts: [], total: 0, unavailableCount: 0 }; },
  });
  const post = (input: unknown) => fetch(route(bridge.url, "/session-artifacts"), { method: "POST", headers, body: JSON.stringify(input) });
  try {
    for (const query of [false, "x".repeat(201)]) {
      const response = await post({ sessionId: "session-1", query }); assert.equal(response.status, 400); await response.text();
    }
    const response = await post({ sessionId: "session-1", offset: 24, query: "  旋律  " });
    assert.equal(response.status, 200); await response.json();
    assert.deepEqual(calls, [{ sessionId: "session-1", offset: 24, query: "旋律" }]);
  } finally { await bridge.close(); }
});

for (const ending of ["disconnect", "close"] as const) test(`Session search ${ending} cancels the read and releases its resources`, { timeout: 3_000 }, async () => {
  const started = Promise.withResolvers<void>(); const aborted = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const bridge = await createChatBridge({ buildState: async () => ({} as ChatDialogState), renderHtml: () => "",
    handleCommand: async () => ({} as ChatDialogState), handleSend: async () => {},
    searchSessions: async (_input, signal) => {
      started.resolve();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted.resolve(); resolve(); }, { once: true }));
      await cleanup.promise;
      throw signal.reason;
    },
  });
  const controller = new AbortController();
  const pending = fetch(route(bridge.url, "/session-search"), { method: "POST", headers,
    body: JSON.stringify({ query: "needle" }), signal: controller.signal }).then(() => "response", () => "aborted");
  let closing: Promise<void> | undefined;
  try {
    await started.promise;
    if (ending === "disconnect") controller.abort(); else closing = bridge.close();
    await aborted.promise;
    assert.equal(await pending, "aborted");
    if (ending === "disconnect") {
      const state = await fetch(route(bridge.url, "/state")); assert.equal(state.status, 200); await state.text();
    }
    cleanup.resolve(); await (closing ?? bridge.close());
  } finally { controller.abort(); cleanup.resolve(); await pending; await (closing ?? bridge.close()); }
});

test("runtime search reads saved history across local Sets without observing or editing Live", async (t) => {
  const storageDirectory = await fs.mkdtemp("/private/tmp/live-smith-search-flow-");
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const session = await createSession(storageDirectory, { title: "Previous set", projectKey: "old-set",
    scope: { kind: "track", identity: "old-track", label: "Lead" } });
  const event = await appendSessionEvent(storageDirectory, session.id, { kind: "user", content: "Find this melody" });
  let observations = 0;
  const interaction: LiveInteractionContext = { presentation: liveContextPresentationFixture("Lead"), summary: "Lead", target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" } };
  interaction.selectionContext = { refresh: () => { observations++; return interaction; } };
  await runAgentFlow({ application: { song: { handle: { id: 1n } } }, environment: { storageDirectory },
    ui: { showModalDialog: async (base: string) => {
      await (await fetch(route(base, "/state"))).json();
      const before = observations;
      const response = await fetch(route(base, "/session-search"), { method: "POST", headers, body: JSON.stringify({ query: "melody" }) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { query: "melody", offset: 0, total: 1, unavailableCount: 0,
        matches: [{ sessionId: session.id, eventId: event.id, excerpt: "Find this melody" }] });
      assert.equal(observations, before);
    } },
  } as never, interaction, { renderHtml: () => "<html></html>" });
});
