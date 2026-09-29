import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import * as esbuild from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/client";

const build = await esbuild.build({ entryPoints: ["src/ui/client/plugin-apps.ts"], bundle: true, platform: "browser", format: "iife", write: false, logLevel: "silent" });
const script = build.outputFiles[0]!.text;
const HOST = "http://127.0.0.1:31234";
const SANDBOX = "http://127.0.0.1:31235";
const tool = { name: "server_tool", description: "A custom App", app: { signature: "signature" } };
const resource = { id: "instance-1", toolName: "original_tool", resourceUri: "ui://example/app", html: "<!doctype html><p>Untrusted App</p>", sandboxUrl: SANDBOX + "/apps/fixture" };
type AppResource = typeof resource & { toolInput?: Record<string, unknown>; toolResult?: CallToolResult };

interface Controller {
  open(value: typeof tool): Promise<void>;
  close(): Promise<void>;
  sync(): void;
  setBusy(value: boolean): void;
}

function harness(overrides: {
  openApp?: () => Promise<AppResource>;
  callTool?: (input: { id: string; name: string; arguments?: Record<string, unknown> }, signal?: AbortSignal) => Promise<CallToolResult>;
} = {}) {
  const dom = new JSDOM("<!doctype html><html lang='en'><body><button id='opener'>Open</button></body></html>", {
    url: HOST + "/chat?token=private-dialog-token", runScripts: "outside-only", virtualConsole: new VirtualConsole(),
  });
  dom.window.eval(script);
  const state = { activeSessionId: "session-1", plugins: [] as unknown[], integrationConnections: { revision: "1" } };
  const opened: unknown[] = [];
  const calls: unknown[] = [];
  const reads: unknown[] = [];
  const closed: string[] = [];
  const shownResults: unknown[] = [];
  const factory = (dom.window as unknown as { LiveSmithFactories: { createPluginApps(deps: unknown): Controller } }).LiveSmithFactories.createPluginApps;
  const app = factory({
    resultActions: { create: (name: string, result: unknown) => {
      shownResults.push({ name, result });
      return dom.window.document.createElement("section");
    } },
    getState: () => state,
    openApp: async (input: unknown) => { opened.push(input); return overrides.openApp ? overrides.openApp() : resource; },
    callTool: async (input: { id: string; name: string; arguments?: Record<string, unknown> }, signal?: AbortSignal) => {
      calls.push(input);
      return overrides.callTool ? overrides.callTool(input, signal) : { content: [{ type: "text", text: "tool result" }] };
    },
    readResource: async (input: unknown): Promise<ReadResourceResult> => {
      reads.push(input); return { contents: [{ uri: "data://status", mimeType: "text/plain", text: "ready" }] };
    },
    closeApp: async (id: string) => { closed.push(id); },
  });
  const messages: { data: Record<string, unknown>; origin: string }[] = [];
  let source: Window;
  const dispatch = (data: unknown, origin = SANDBOX, sender: unknown = source) => {
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, origin, source: sender as Window }));
  };
  async function open() {
    await app.open(tool);
    const frame = dom.window.document.querySelector("iframe")!;
    source = frame.contentWindow as unknown as Window;
    source.postMessage = (data: Record<string, unknown>, options?: string | WindowPostMessageOptions) => {
      const origin = typeof options === "string" ? options : options?.targetOrigin ?? "/";
      messages.push({ data, origin });
      if (data.method === "ui/resource-teardown") {
        queueMicrotask(() => dispatch({ jsonrpc: "2.0", id: data.id, result: {} }));
      }
    };
    return frame;
  }
  async function initialize() {
    dispatch({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} });
    dispatch({ jsonrpc: "2.0", id: "initialize", method: "ui/initialize", params: {
      appInfo: { name: "test-app", version: "1.0.0" }, appCapabilities: {}, protocolVersion: "2026-01-26",
    } });
    await setImmediate();
    dispatch({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    await setImmediate();
  }
  return { dom, state, app, opened, calls, reads, closed, shownResults, messages, dispatch, open, initialize };
}

test("App result controls restore saved results and helper calls cannot replace them", async (t) => {
  const saved: CallToolResult = { content: [{ type: "text", text: "Saved MIDI" }],
    _meta: { "io.github.samkuler/live-smith-artifacts": { version: 1, artifacts: [{ artifactRef: "saved-midi" }] } } };
  const h = harness({ openApp: async () => ({ ...resource, toolResult: saved }),
    callTool: async ({ name }) => ({ content: [{ type: "text", text: name }] }) });
  t.after(async () => { await h.app.close(); h.dom.window.close(); });
  await h.open(); await h.initialize();
  assert.deepEqual(h.shownResults, [{ name: tool.name, result: saved }]);
  h.dispatch({ jsonrpc: "2.0", id: 80, method: "tools/call", params: { name: "get_settings" } });
  await setImmediate();
  assert.equal(h.shownResults.length, 1);
  h.dispatch({ jsonrpc: "2.0", id: 81, method: "tools/call", params: { name: resource.toolName } });
  await setImmediate();
  assert.deepEqual(JSON.parse(JSON.stringify(h.shownResults.at(-1))), {
    name: tool.name, result: { content: [{ type: "text", text: resource.toolName }] },
  });
  assert.equal(h.shownResults.length, 2);
  assert.equal(h.dom.window.document.querySelector<HTMLElement>(".plugin-app-results")!.hidden, false);
});

test("browser container performs the SDK handshake with exact origin and sends initial input without invoking a tool", async (t) => {
  const h = harness();
  t.after(async () => { await h.app.close(); h.dom.window.close(); });
  const frame = await h.open();
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin");
  assert.equal(frame.referrerPolicy, "no-referrer");
  assert.equal(frame.src, resource.sandboxUrl);
  assert.equal(h.calls.length, 0);
  assert.equal(h.dom.window.document.body.textContent!.includes("Untrusted App"), false);
  h.dispatch({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" }, "https://untrusted.example");
  h.dispatch({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" }, SANDBOX, {});
  assert.equal(h.messages.length, 0);
  await h.initialize();
  assert.deepEqual(JSON.parse(JSON.stringify(h.opened)), [{ sessionId: "session-1", toolName: "server_tool", signature: "signature" }]);
  const init = h.messages.find(({ data }) => data.id === "initialize")!.data.result as Record<string, unknown>;
  assert.equal(init.protocolVersion, "2026-01-26");
  assert.deepEqual(JSON.parse(JSON.stringify(init.hostCapabilities)), { serverTools: {}, serverResources: {}, sandbox: {} });
  assert.equal((init.hostContext as Record<string, unknown>).locale, "en");
  const inputs = h.messages.filter(({ data }) => data.method === "ui/notifications/tool-input");
  assert.equal(inputs.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(inputs[0]!.data.params)), { arguments: {} });
  assert.ok(h.messages.every(({ origin }) => origin === SANDBOX));
  assert.equal(JSON.stringify(h.messages).includes("private-dialog-token"), false);
  assert.equal(h.calls.length, 0);
});

test("App RPC rejects calls before initialization, while busy and from spoofed windows", async (t) => {
  const h = harness();
  t.after(async () => { await h.app.close(); h.dom.window.close(); });
  await h.open();
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "refresh", arguments: { step: 2 } } };
  h.dispatch(request);
  await setImmediate();
  assert.equal(h.calls.length, 0);
  assert.ok(h.messages.find(({ data }) => data.id === 1)?.data.error);
  await h.initialize();
  h.app.setBusy(true);
  h.dispatch({ ...request, id: 2 });
  await setImmediate();
  assert.equal(h.calls.length, 0);
  h.app.setBusy(false);
  h.dispatch({ ...request, id: 3 }, "https://untrusted.example");
  h.dispatch({ ...request, id: 4 }, SANDBOX, {});
  h.dispatch({ ...request, id: 5 });
  h.dispatch({ jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "data://status" } });
  h.dispatch({ jsonrpc: "2.0", id: 7, method: "ui/open-link", params: { url: "https://example.test" } });
  await setImmediate();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ id: "instance-1", name: "refresh", arguments: { step: 2 } }]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.reads)), [{ id: "instance-1", uri: "data://status" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages.find(({ data }) => data.id === 5)!.data.result)), { content: [{ type: "text", text: "tool result" }] });
  assert.ok(h.messages.find(({ data }) => data.id === 6)!.data.result);
  assert.ok(h.messages.find(({ data }) => data.id === 7)!.data.error);
});

test("initialization delivers genuine saved input before its saved tool result", async (t) => {
  const saved = { ...resource, toolInput: { prompt: "saved prompt", count: 2 }, toolResult: {
    content: [{ type: "text" as const, text: "saved result" }], structuredContent: { count: 2 }, _meta: { appState: "saved" },
  } };
  const h = harness({ openApp: async () => saved });
  t.after(async () => { await h.app.close(); h.dom.window.close(); });
  await h.open();
  await h.initialize();
  const deliveries = h.messages.filter(({ data }) => ["ui/notifications/tool-input", "ui/notifications/tool-result"].includes(String(data.method)));
  assert.deepEqual(JSON.parse(JSON.stringify(deliveries.map(({ data }) => data.params))), [
    { arguments: saved.toolInput }, saved.toolResult,
  ]);
  assert.equal(h.calls.length, 0);
  h.dispatch({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  await setImmediate();
  assert.equal(h.messages.filter(({ data }) => data.method === "ui/notifications/tool-result").length, 1);
});

test("standard cancellation reaches the v2 request signal and teardown releases the backend instance", async (t) => {
  let signal: AbortSignal | undefined;
  const h = harness({ callTool: async (_input, requestSignal) => {
    signal = requestSignal;
    return await new Promise<CallToolResult>((_resolve, reject) => requestSignal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  } });
  t.after(() => h.dom.window.close());
  await h.open();
  await h.initialize();
  h.dispatch({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "refresh" } });
  await setImmediate();
  assert.ok(signal);
  h.dispatch({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5, reason: "User stopped" } });
  await setImmediate();
  assert.equal(signal.aborted, true);
  await h.app.close();
  assert.deepEqual(h.closed, ["instance-1"]);
  assert.ok(h.messages.some(({ data }) => data.method === "ui/resource-teardown"));
  assert.equal(h.dom.window.document.querySelector("dialog"), null);
});

test("owner changes close an App and a superseded open cannot mount its late resource", async (t) => {
  const h = harness();
  t.after(() => h.dom.window.close());
  await h.open();
  await h.initialize();
  h.state.integrationConnections.revision = "2";
  h.app.sync();
  await setImmediate();
  assert.deepEqual(h.closed, ["instance-1"]);
  assert.equal(h.dom.window.document.querySelector("dialog"), null);
  let resolve!: (value: typeof resource) => void;
  const late = harness({ openApp: () => new Promise((done) => { resolve = done; }) });
  t.after(() => late.dom.window.close());
  const opening = late.app.open(tool);
  await setImmediate();
  await late.app.close();
  resolve(resource);
  await opening;
  assert.deepEqual(late.closed, ["instance-1"]);
  assert.equal(late.dom.window.document.querySelector("dialog"), null);
});

test("closing an App aborts its outstanding SDK handler and concurrent opens mount only the newest App", async (t) => {
  let signal: AbortSignal | undefined;
  const h = harness({ callTool: async (_input, requestSignal) => {
    signal = requestSignal;
    return await new Promise<CallToolResult>((_resolve, reject) => requestSignal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  } });
  t.after(() => h.dom.window.close());
  await h.open();
  await h.initialize();
  h.dispatch({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "refresh" } });
  await setImmediate();
  await h.app.close();
  assert.equal(signal?.aborted, true);
  const concurrent = harness();
  t.after(async () => { await concurrent.app.close(); concurrent.dom.window.close(); });
  await Promise.all([concurrent.app.open(tool), concurrent.app.open({ ...tool, name: "newer-tool" })]);
  assert.equal(concurrent.opened.length, 1);
  assert.equal(concurrent.dom.window.document.querySelectorAll("dialog").length, 1);
  assert.equal(concurrent.dom.window.document.querySelector("h3")!.textContent, "newer-tool");
});
