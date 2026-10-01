import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

import type { LiveInteractionContext } from "../../../../src/live/context.js";
import { loadSessionEvents } from "../../../../src/storage/events.js";
import type { ChatBridgeState, ChatDialogState } from "../../../../src/ui/chat-state.js";
import { runAgentFlow } from "../../../../src/app/agent-flow.js";
import { createChatBridge } from "../../../../src/app/chat/chat-bridge.js";
import { liveContextPresentationFixture } from "../../context/support/live-context.test-harness.js";

const toolReadInput = { kind: "load_session_tools", sessionId: "session-1" } as const;
const toolReadBody = JSON.stringify(toolReadInput);
const state = {
  activeSessionId: "session-1",
  sessionToolCatalog: {
    sessionId: "session-1", loadedAt: "2026-09-28T00:00:00.000Z",
    modelToolsSupported: true, truncated: false, issues: [],
    groups: [{ kind: "live", tools: [{ name: "inspect_current_object", description: "Inspect Live" }] }],
  },
} as unknown as ChatDialogState;

function route(url: string, pathname: string): URL {
  const endpoint = new URL(url);
  endpoint.pathname = pathname;
  return endpoint;
}

function post(url: string, pathname: string, input: unknown, commandId: string, signal?: AbortSignal) {
  return fetch(route(url, pathname), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Live-Smith-Command-Id": commandId },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
}

test("Session tool reads accept only authenticated, strict discovery inputs and reuse the command handler", async () => {
  const calls: unknown[] = [];
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (input) => { calls.push(input); return state; },
    handleSend: async () => {},
  });
  const endpoint = route(bridge.url, "/session-tools");
  const headers = { "Content-Type": "application/json", "X-Live-Smith-Command-Id": "strict-tools-read" };
  const events = await fetch(route(bridge.url, "/events"));
  try {
    for (const body of [
      JSON.stringify({ kind: "new_session" }),
      JSON.stringify({ kind: "load_session_model_capabilities", sessionId: "session-1", profileId: "profile-1" }),
      JSON.stringify({ ...toolReadInput, settings: {} }),
      JSON.stringify({ ...toolReadInput, profileId: "profile-1" }),
      JSON.stringify({ ...toolReadInput, sessionId: "../other" }),
      JSON.stringify({ ...toolReadInput, sessionId: 1 }),
      JSON.stringify({ kind: "load_session_tools" }),
      "{",
      `${toolReadBody}${" ".repeat(1024 * 1024)}`,
    ]) {
      const response = await fetch(endpoint, { method: "POST", headers, body });
      assert.equal(response.status, 400, body.slice(0, 120));
      assert.equal(response.headers.get("X-Live-Smith-Command-Id"), "strict-tools-read");
    }
    for (const query of ["", "?token=incorrect"]) {
      const unauthorized = new URL(endpoint);
      unauthorized.search = query;
      assert.equal((await fetch(unauthorized, { method: "POST", headers, body: toolReadBody })).status, 403);
    }
    for (const query of ["extra=1", `token=${endpoint.searchParams.get("token")}`]) {
      const invalidQuery = new URL(`${endpoint}&${query}`);
      assert.equal((await fetch(invalidQuery, { method: "POST", headers, body: toolReadBody })).status, 400);
    }
    for (const invalidHeaders of [
      { "Content-Type": "text/plain", "X-Live-Smith-Command-Id": "wrong-type" },
      { "Content-Type": "application/json" },
      { ...headers, "X-Live-Smith-Command-Id": "invalid correlation" },
    ]) {
      assert.equal((await fetch(endpoint, {
        method: "POST", headers: invalidHeaders, body: toolReadBody,
      })).status, 400);
    }
    assert.equal(calls.length, 0);
    const loaded = await post(bridge.url, "/session-tools", toolReadInput, "accepted-tools-read");
    assert.equal(loaded.status, 200);
    assert.equal(loaded.headers.get("X-Live-Smith-Command-Id"), "accepted-tools-read");
    assert.deepEqual((await loaded.json() as ChatBridgeState).sessionToolCatalog, state.sessionToolCatalog);
    const legacy = await post(bridge.url, "/command", toolReadInput, "explicit-tools-command");
    assert.equal(legacy.status, 200);
    assert.deepEqual(calls, [toolReadInput, toolReadInput]);
    await bridge.close();
    const publications = await events.text();
    assert.match(publications, /explicit-tools-command/u);
    assert.doesNotMatch(publications, /strict-tools-read|accepted-tools-read/u);
  } finally {
    await bridge.close();
  }
});

test("pending Session tool discovery permits sends, commands, and state reads without publishing command state", {
  timeout: 3_000,
}, async () => {
  const started = Promise.withResolvers<void>();
  const readGate = Promise.withResolvers<void>();
  const sends: unknown[] = [];
  let current = state;
  const bridge = await createChatBridge({
    buildState: async () => current,
    renderHtml: () => "<html></html>",
    handleCommand: async (input, _signal, context) => {
      if (input.kind === "load_session_tools") {
        const captured = current;
        await context.progress("Loading tools");
        started.resolve();
        await readGate.promise;
        return captured;
      }
      assert.equal(input.kind, "select_session");
      current = { ...current, activeSessionId: input.sessionId };
      return current;
    },
    handleSend: async (input) => { sends.push(input); },
  });
  const baseline = await (await fetch(route(bridge.url, "/state"))).json() as ChatBridgeState;
  const events = await fetch(route(bridge.url, "/events"));
  let readSettled = false;
  const read = post(bridge.url, "/session-tools", toolReadInput, "held-tools-read")
    .then((response) => { readSettled = true; return response; });
  try {
    assert.equal(await Promise.race([started.promise.then(() => "started"), read.then(() => "settled")]), "started");
    const send = await fetch(route(bridge.url, "/send"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Live-Smith-Send-Id": "parallel-send" },
      body: JSON.stringify({ prompt: "Continue", sessionId: "session-1" }),
    });
    assert.equal(send.status, 200);
    assert.deepEqual(sends, [{ prompt: "Continue", sessionId: "session-1" }]);
    const selected = await post(bridge.url, "/command", {
      kind: "select_session", sessionId: "session-2",
    }, "parallel-navigation");
    assert.equal(selected.status, 200);
    const selectedState = await selected.json() as ChatBridgeState;
    const refreshed = await fetch(route(bridge.url, "/state"));
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json() as ChatBridgeState).activeSessionId, "session-2");
    assert.equal(readSettled, false);
    readGate.resolve();
    const response = await read;
    assert.equal(response.status, 200);
    const loaded = await response.json() as ChatBridgeState;
    assert.deepEqual(loaded.sessionToolCatalog, state.sessionToolCatalog);
    assert.equal(loaded.bridgeStateCoveredThroughRevision, baseline.bridgeStateRevision);
    assert.ok(BigInt(loaded.bridgeStateRevision) > BigInt(selectedState.bridgeStateRevision));
    await bridge.close();
    const publications = await events.text();
    assert.match(publications, /parallel-navigation/u);
    assert.doesNotMatch(publications, /held-tools-read/u);
  } finally {
    readGate.resolve();
    await read;
    await bridge.close();
  }
});

test("a failed Session tool read does not publish errors or terminate a concurrent command", {
  timeout: 3_000,
}, async () => {
  const readStarted = Promise.withResolvers<void>();
  const readGate = Promise.withResolvers<void>();
  const commandStarted = Promise.withResolvers<void>();
  const commandGate = Promise.withResolvers<void>();
  let commandSignal: AbortSignal | undefined;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (input, signal, context) => {
      if (input.kind === "load_session_tools") {
        readStarted.resolve();
        await readGate.promise;
        throw new Error("Tool discovery failed.");
      }
      commandSignal = signal;
      await context.progress("Saving settings");
      commandStarted.resolve();
      await commandGate.promise;
      return state;
    },
    handleSend: async () => {},
  });
  const events = await fetch(route(bridge.url, "/events"));
  const read = post(bridge.url, "/session-tools", toolReadInput, "failed-tools-read");
  let command: Promise<Response> | undefined;
  try {
    assert.equal(await Promise.race([readStarted.promise.then(() => "started"), read.then(() => "settled")]), "started");
    command = post(bridge.url, "/command", { kind: "new_session" }, "pending-command");
    assert.equal(await Promise.race([commandStarted.promise.then(() => "started"), command.then(() => "settled")]), "started");
    readGate.resolve();
    const response = await read;
    assert.equal(response.status, 500);
    assert.equal((await response.json() as { error: string }).error, "Tool discovery failed.");
    assert.equal(commandSignal?.aborted, false);
    const competing = await post(bridge.url, "/command", { kind: "new_session" }, "competing-command");
    assert.equal(competing.status, 409, "the pending foreground command must retain its slot");
    commandGate.resolve();
    assert.equal((await command).status, 200);
    await bridge.close();
    const publications = await events.text();
    assert.match(publications, /pending-command/u);
    assert.doesNotMatch(publications, /failed-tools-read|Tool discovery failed/u);
  } finally {
    readGate.resolve();
    commandGate.resolve();
    await read;
    await command;
    await bridge.close();
  }
});

for (const ending of ["disconnect", "bridge close"] as const) {
  test(`Session tool ${ending} cancels discovery and retains the read cleanup lifecycle`, {
    timeout: 3_000,
  }, async () => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const cleanupGate = Promise.withResolvers<void>();
    let readSignal: AbortSignal | undefined;
    const bridge = await createChatBridge({
      buildState: async () => state,
      renderHtml: () => "<html></html>",
      handleCommand: async (input, signal) => {
        if (input.kind !== "load_session_tools") return state;
        readSignal = signal;
        started.resolve();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        aborted.resolve();
        await cleanupGate.promise;
        throw signal.reason;
      },
      handleSend: async () => {},
    });
    const controller = new AbortController();
    const read = post(bridge.url, "/session-tools", toolReadInput, "cancelled-tools-read", controller.signal)
      .then((response) => ({ response }), (error: unknown) => ({ error }));
    let closing: Promise<void> | undefined;
    try {
      assert.equal(await Promise.race([started.promise.then(() => "started"), read.then(() => "settled")]), "started");
      let closeSettled = false;
      if (ending === "disconnect") controller.abort();
      else closing = bridge.close().then(() => { closeSettled = true; });
      await aborted.promise;
      assert.equal(readSignal?.aborted, true);
      assert.ok("error" in await read);
      if (ending === "disconnect") {
        assert.equal((await post(bridge.url, "/command", { kind: "new_session" }, "after-read-disconnect")).status, 200);
      } else {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(closeSettled, false, "bridge close must await discovery cleanup");
      }
      cleanupGate.resolve();
      await (closing ?? bridge.close());
    } finally {
      controller.abort();
      cleanupGate.resolve();
      await read;
      await (closing ?? bridge.close());
    }
  });
}

test("canonical tool discovery preserves a concurrent foreground command's status", {
  timeout: 5_000,
}, async (t) => {
  const storageDirectory = await fs.mkdtemp("/private/tmp/live-smith-tool-read-state-");
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const started = Promise.withResolvers<void>();
  const readGate = Promise.withResolvers<void>();
  let holdNextEventRead = false;
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"), summary: "Track: Lead", target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  await runAgentFlow({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory },
    ui: { showModalDialog: async (url: string) => {
      const readState = async () => (await fetch(route(url, "/state"))).json() as Promise<ChatDialogState>;
      const initial = await readState();
      holdNextEventRead = true;
      const read = post(url, "/session-tools", {
        kind: "load_session_tools", sessionId: initial.activeSessionId,
      }, "read-tools-during-settings");
      try {
        assert.equal(await Promise.race([started.promise.then(() => "started"), read.then(() => "settled")]), "started");
        const saved = await post(url, "/command", {
          kind: "save_global_settings", showContextUsage: true,
        }, "save-settings-during-tool-read");
        assert.equal(saved.status, 200);
        const savedState = await saved.json() as ChatDialogState;
        assert.equal(savedState.status, "Global settings saved.");
        readGate.resolve();
        const loaded = await read;
        assert.equal(loaded.status, 200);
        const loadedState = await loaded.json() as ChatDialogState;
        assert.ok(loadedState.sessionToolCatalog);
        const current = await readState();
        assert.equal(current.status, savedState.status);
        assert.deepEqual(current.sessionToolCatalog, loadedState.sessionToolCatalog);
      } finally {
        readGate.resolve();
        await read;
      }
    } },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    loadSessionEvents: async (...args) => {
      if (holdNextEventRead) {
        holdNextEventRead = false;
        started.resolve();
        await readGate.promise;
      }
      return loadSessionEvents(...args);
    },
  });
});
