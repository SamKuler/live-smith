import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { URL } from "node:url";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate/browser";

import { buildPluginAppExample } from "../../../scripts/build-plugin-app-example.js";
import type { LiveInteractionContext } from "../../../src/live/context.js";
import type { PluginAppDescriptor } from "../../../src/plugins/mcp/apps.js";
import { LIVE_SMITH_ARTIFACT_META_KEY } from "../../../src/plugins/artifacts.js";
import { inspectMidiArtifacts, readMidiArtifact } from "../../../src/storage/midi-artifacts.js";
import { PLUGIN_CONFIG_NAMESPACE } from "../../../src/plugins/user-config.js";
import { createHostAbortController, resolveFetchImplementation } from "../../../src/runtime/host.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import { installPlugin, readPluginConfig, setPluginEnabled, setPluginMcpServerApproved, setPluginArtifactPermissionApproved } from "../../../src/storage/plugins.js";
import { createSession, deleteSession, listSessions } from "../../../src/storage/sessions.js";
import type { ChatBridgeState } from "../../../src/ui/chat-state.js";
import { runAgentFlow } from "../../../src/app/agent-flow.js";
import { ChatBridgeConflictError } from "../../../src/app/chat/chat-bridge-http.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";
import { createOpenResponseRelay } from "./support/plugin-apps-test-http-relay.js";
import { MAX_PLUGIN_APP_PAGE_REQUEST_BYTES, createPluginAppSessions } from "../../../src/app/plugins/plugin-apps.js";
import { createRequestPluginTools, type PluginExecutionAuthorization } from "../../../src/app/plugins/request-plugin-tools.js";
import { SessionMutationFence, sessionMutationFenceKey } from "../../../src/app/session/session-mutation-fence.js";
import { resolveSkillContext } from "../../../src/app/context/skill-context.js";

const exampleBytes = await buildPluginAppExample();
const pluginId = "fixture.mcp-app";
const resourceUri = "ui://pattern-lab/app.html";
const authorize: PluginExecutionAuthorization = async (_signal, operation) => operation();

function visibilityArchive(): Uint8Array {
  const files = unzipSync(exampleBytes);
  const source = strFromU8(files["server.mjs"]!);
  const withModelOnly = source.replace("const tools = [{", `const tools = [{
  name: "model_only", description: "A tool reserved for model requests.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  _meta: { ui: { visibility: ["model"] } },
}, {`);
  assert.notEqual(withModelOnly, source);
  files["server.mjs"] = strToU8(withModelOnly);
  files["foreign.mjs"] = strToU8(withModelOnly.replace('name: "get_settings"', 'name: "foreign_only"'));
  const mcp = JSON.parse(strFromU8(files["mcp.json"]!));
  mcp.mcpServers.foreign = { ...mcp.mcpServers.fixture, args: ["${PLUGIN_ROOT}/foreign.mjs"] };
  files["mcp.json"] = strToU8(JSON.stringify(mcp));
  return zipSync(files);
}

async function fixture(t: TestContext, bytes = exampleBytes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-app-flow-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const plugin = await installPlugin(directory, bytes);
  await setPluginEnabled(directory, pluginId, true);
  await setPluginMcpServerApproved(directory, pluginId, "fixture", true);
  await setPluginArtifactPermissionApproved(directory, pluginId, "fixture", "output", true);
  return { directory, plugin };
}

interface HttpResult { status: number; body: Record<string, unknown>; raw: string }
interface Bridge {
  endpoint(pathname: string): URL;
  state(): Promise<ChatBridgeState>;
  post(pathname: string, body: unknown): Promise<HttpResult>;
  command(body: unknown): Promise<ChatBridgeState>;
  catalog(sessionId: string): Promise<NonNullable<ChatBridgeState["sessionToolCatalog"]>>;
}

async function withFlow(directory: string, use: (bridge: Bridge) => Promise<void>): Promise<void> {
  const interaction: LiveInteractionContext = { presentation: liveContextPresentationFixture("Lead"), summary: "Track: Lead", target: {},
    scope: { kind: "track", identity: "app-track", label: "Lead" } };
  interaction.selectionContext = { refresh: () => interaction };
  await runAgentFlow({ application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: directory },
    ui: { showModalDialog: async (url: string) => {
      let sequence = 0;
      const endpoint = (pathname: string) => { const target = new URL(url); target.pathname = pathname; return target; };
      const post = async (pathname: string, body: unknown): Promise<HttpResult> => {
        const response = await fetch(endpoint(pathname), { method: "POST", headers: { "Content-Type": "application/json",
          "X-Live-Smith-Command-Id": `app-flow-${++sequence}` }, body: JSON.stringify(body) });
        const raw = await response.text();
        return { status: response.status, body: JSON.parse(raw) as Record<string, unknown>, raw };
      };
      await use({ endpoint, post,
        async state() { return await (await fetch(endpoint("/state"))).json() as ChatBridgeState; },
        async command(body) { const result = await post("/command", body); assert.equal(result.status, 200, result.raw); return result.body as unknown as ChatBridgeState; },
        async catalog(sessionId) {
          const result = await post("/session-tools", { kind: "load_session_tools", sessionId });
          assert.equal(result.status, 200, result.raw);
          return (result.body as unknown as ChatBridgeState).sessionToolCatalog!;
        },
      });
    } },
  } as never, interaction, { renderHtml: () => "<html></html>" });
}

function appDescriptor(catalog: NonNullable<ChatBridgeState["sessionToolCatalog"]>, serverId = "fixture"): PluginAppDescriptor {
  const app = catalog.groups.find((group) => group.kind === "mcp" && group.serverId === serverId)?.tools.find((tool) => tool.name === "pattern_lab")?.app;
  assert.ok(app);
  return app;
}

async function openApp(bridge: Bridge, sessionId: string, app: PluginAppDescriptor): Promise<Record<string, unknown> & { id: string }> {
  const id = randomUUID();
  const opened = await bridge.post("/plugin-apps/open", { id, sessionId, toolName: app.toolName, signature: app.signature });
  assert.equal(opened.status, 200, opened.raw);
  assert.equal(opened.body.id, id);
  return opened.body as Record<string, unknown> & { id: string };
}

async function eventStream(bridge: Bridge, signal: AbortSignal) {
  const response = await fetch(bridge.endpoint("/events"), { signal });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const events: Array<Record<string, unknown>> = [];
  const waiting = new Set<{ predicate: (value: Record<string, unknown>) => boolean; resolve(value: Record<string, unknown>): void; reject(error: unknown): void }>();
  const reading = (async () => {
    let pending = "";
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        pending += Buffer.from(part.value).toString("utf8");
        let end;
        while ((end = pending.indexOf("\n\n")) !== -1) {
          const block = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
          if (!data) continue;
          const event = JSON.parse(data) as Record<string, unknown>;
          events.push(event);
          for (const waiter of waiting) if (waiter.predicate(event)) { waiting.delete(waiter); waiter.resolve(event); }
        }
      }
      for (const waiter of waiting) waiter.reject(new Error("The event stream closed before the expected event."));
    } catch (error) { for (const waiter of waiting) waiter.reject(error); }
  })();
  return { events,
    next(predicate: (value: Record<string, unknown>) => boolean) {
      return new Promise<Record<string, unknown>>((resolve, reject) => { waiting.add({ predicate, resolve, reject }); });
    },
    async close() { await reader.cancel(); await reading; },
  };
}

test("MCP App reports an unconfirmed outcome when a server exits after its side effect", { timeout: 15_000 }, async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-app-outcome-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const marker = path.join(temporary, "invoked");
  const files = unzipSync(exampleBytes);
  const source = strFromU8(files["server.mjs"]!);
  const changed = source.replace('case "tools/call": {', `case "tools/call": {
      writeFileSync(process.env.OUTCOME_MARKER, "called"); process.exit(0);`);
  assert.notEqual(changed, source);
  files["server.mjs"] = strToU8(changed);
  const mcp = JSON.parse(strFromU8(files["mcp.json"]!));
  mcp.mcpServers.fixture.env.OUTCOME_MARKER = marker;
  files["mcp.json"] = strToU8(JSON.stringify(mcp));
  const { directory } = await fixture(t, zipSync(files));
  await withFlow(directory, async (bridge) => {
    const sessionId = (await bridge.state()).activeSessionId;
    const tool = (await bridge.catalog(sessionId)).groups.flatMap((group) => group.tools).find((entry) => entry.app)!;
    const opened = await bridge.post("/plugin-apps/open", { id: randomUUID(), sessionId, toolName: tool.app!.toolName, signature: tool.app!.signature });
    assert.equal(opened.status, 200);
    const response = await bridge.post("/plugin-apps/call", { id: opened.body.id, name: "get_settings", arguments: {} });
    assert.equal(response.status, 409);
    assert.match(response.raw, /unconfirmed/u);
    assert.equal(await fs.readFile(marker, "utf8"), "called");
    const events = await loadSessionEvents(directory, sessionId);
    assert.equal(events.filter((event) => event.kind === "tool_call").length, 1);
    assert.match(events.at(-1)!.content, /confirmed result/u);
  });
});

test("MCP App HTTP resource lists preserve single pages and opaque server cursors", { timeout: 15_000 }, async (t) => {
  const files = unzipSync(exampleBytes);
  let source = strFromU8(files["server.mjs"]!);
  const list = 'case "resources/list": return { result: { resources: [{ uri: RESOURCE_URI, name: "Pattern lab", mimeType: MIME_TYPE }] } };';
  const templates = 'case "resources/templates/list": return { result: { resourceTemplates: [] } };';
  assert.ok(source.includes(list) && source.includes(templates));
  const pageFunction = String.raw`
function resourcePage(request, templates) {
  const cursors = Array.from({ length: 16 }, (_unused, index) => "opaque page/" + (index + 1) + " +?&=");
  const cursor = request.params?.cursor;
  const page = cursor === undefined ? 0 : cursors.indexOf(cursor) + 1;
  if (cursor !== undefined && page === 0) return { error: { code: -32602, message: "Unknown cursor." } };
  return { result: {
    [templates ? "resourceTemplates" : "resources"]: [templates
      ? { name: "Page " + page, uriTemplate: "resource://pattern/" + page + "/{id}" }
      : { name: "Page " + page, uri: "resource://pattern/" + page }],
    ...(page < 16 ? { nextCursor: cursors[page] } : {}),
    _meta: { page, received: request.params ?? {} },
  } };
}
`;
  source = source.replace(list, 'case "resources/list": return resourcePage(request, false);')
    .replace(templates, 'case "resources/templates/list": return resourcePage(request, true);') + pageFunction;
  files["server.mjs"] = strToU8(source);
  const { directory } = await fixture(t, zipSync(files));
  await withFlow(directory, async (bridge) => {
    const sessionId = (await bridge.state()).activeSessionId;
    const opened = await openApp(bridge, sessionId, appDescriptor(await bridge.catalog(sessionId)));
    for (const operation of ["resources", "resource-templates"] as const) {
      let cursor: string | undefined;
      for (let page = 0; page < 17; page++) {
        const response = await bridge.post(`/plugin-apps/${operation}`, { id: opened.id, ...(cursor === undefined ? {} : { cursor }) });
        assert.equal(response.status, 200, response.raw);
        assert.deepEqual(response.body._meta, { page, received: cursor === undefined ? {} : { cursor } });
        assert.deepEqual(response.body[operation === "resources" ? "resources" : "resourceTemplates"], [operation === "resources"
          ? { name: `Page ${page}`, uri: `resource://pattern/${page}` }
          : { name: `Page ${page}`, uriTemplate: `resource://pattern/${page}/{id}` }]);
        assert.equal(response.body.nextCursor, page < 16 ? `opaque page/${page + 1} +?&=` : undefined);
        cursor = response.body.nextCursor as string | undefined;
      }
      assert.equal(cursor, undefined);
    }
    assert.deepEqual(await loadSessionEvents(directory, sessionId), []);
    assert.equal((await bridge.post("/plugin-apps/close", { id: opened.id })).status, 200);
  });
});

test("MCP App resource continuation preserves long opaque strings", { timeout: 15_000 }, async (t) => {
  const files = unzipSync(exampleBytes);
  const cursor = "opaque:\0" + "😀".repeat(300_000);
  const source = strFromU8(files["server.mjs"]!);
  const changed = source.replace('case "resources/list":', 'case "resources/list":\n    case "resources/templates/list": return { result: {\n' +
    '  [request.method === "resources/list" ? "resources" : "resourceTemplates"]: [],\n' +
    '  ...(request.params?.cursor === undefined ? { nextCursor: "opaque:\\0" + "😀".repeat(300_000) } : {}),\n' +
    '  _meta: { received: request.params ?? {} },\n} };\n    case "unused/resources/list":');
  assert.notEqual(changed, source);
  files["server.mjs"] = strToU8(changed);
  const { directory } = await fixture(t, zipSync(files));
  await withFlow(directory, async (bridge) => {
    const sessionId = (await bridge.state()).activeSessionId;
    const opened = await openApp(bridge, sessionId, appDescriptor(await bridge.catalog(sessionId)));
    for (const operation of ["resources", "resource-templates"] as const) {
      const page = await bridge.post(`/plugin-apps/${operation}`, { id: opened.id });
      assert.equal(page.status, 200, page.raw);
      assert.equal(page.body.nextCursor, cursor);
      const next = await bridge.post(`/plugin-apps/${operation}`, { id: opened.id, cursor: page.body.nextCursor });
      assert.equal(next.status, 200, next.raw);
      assert.deepEqual(next.body._meta, { received: { cursor } });
      assert.equal(next.body.nextCursor, undefined);
    }
    const oversized = await bridge.post("/plugin-apps/resources", {
      id: opened.id, cursor: "x".repeat(MAX_PLUGIN_APP_PAGE_REQUEST_BYTES),
    });
    assert.equal(oversized.status, 400);
    assert.match(String(oversized.body.error), /Request body exceeds/u);
    assert.equal((await bridge.post("/plugin-apps/close", { id: opened.id })).status, 200);
    assert.deepEqual(await loadSessionEvents(directory, sessionId), []);
  });
});

test("MCP App ownership survives cancellation during its open response body", { timeout: 15_000 }, async (t) => {
  const { directory } = await fixture(t);
  await withFlow(directory, async (bridge) => {
    const sessionId = (await bridge.state()).activeSessionId;
    const descriptor = appDescriptor(await bridge.catalog(sessionId));
    for (let attempt = 0; attempt < 4; attempt++) {
      const id = randomUUID();
      const controller = createHostAbortController();
      const relay = await createOpenResponseRelay(t, bridge.endpoint("/plugin-apps/open"));
      try {
        const response = await fetch(relay.url, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ id, sessionId, toolName: descriptor.toolName, signature: descriptor.signature }),
        });
        assert.equal(response.status, 200);
        let settled = false;
        const parsed = response.json().then((value) => { settled = true; return { value }; },
          (error: unknown) => { settled = true; return { error }; });
        const held = await relay.held;
        assert.equal(held.body.id, id, "The real bridge has completed the open and registered the requested owner.");
        assert.ok(held.sentBytes < held.totalBytes);
        assert.equal(response.bodyUsed, true);
        const owned = await bridge.post("/plugin-apps/resource", { id, uri: resourceUri });
        assert.equal(owned.status, 200, "The open instance exists before its client receives the complete response.");
        assert.equal(settled, false, "The JSON reader must still be waiting for the withheld response body.");
        assert.equal(relay.isBodyHeld(), true);
        controller.abort(new Error("App window closed during response reading."));
        assert.ok("error" in await parsed, "The cancelled open cannot depend on receiving the instance ID.");
        await relay.clientClosed;
        assert.equal(relay.isBodyHeld(), false);
      } finally {
        controller.abort();
        await relay.close();
      }
      const closed = await bridge.post("/plugin-apps/close", { id });
      assert.equal(closed.status, 200, closed.raw);
      const resource = await bridge.post("/plugin-apps/resource", { id, uri: resourceUri });
      assert.equal(resource.status, 409, "The closed instance must release its retained connection.");
    }
    const opened = await openApp(bridge, sessionId, descriptor);
    const duplicate = await bridge.post("/plugin-apps/open", { id: opened.id, sessionId,
      toolName: descriptor.toolName, signature: descriptor.signature });
    assert.equal(duplicate.status, 409, "An existing instance must not be overwritten by another open.");
    assert.equal((await bridge.post("/plugin-apps/resource", { id: opened.id, uri: resourceUri })).status, 200);
    assert.equal((await bridge.post("/plugin-apps/close", { id: opened.id })).status, 200);
    assert.deepEqual(await loadSessionEvents(directory, sessionId), []);
  });
});

test("MCP App HTTP lifecycle delivers resources, enforces tool visibility, publishes local Session changes and reopens real history", { timeout: 15_000 }, async (t) => {
  const { directory, plugin } = await fixture(t, visibilityArchive());
  await setPluginMcpServerApproved(directory, pluginId, "foreign", true);
  await setPluginArtifactPermissionApproved(directory, pluginId, "foreign", "output", true);
  await withFlow(directory, async (bridge) => {
    const initial = await bridge.state();
    const sessionId = initial.activeSessionId;
    assert.equal(initial.runtimeProfile, null);
    await bridge.command({ kind: "set_plugin_user_config", pluginId, sha256: plugin.sha256, revision: "0",
      values: { style: "jazz", default_bars: 6 }, secretUpdates: {} });
    const catalog = await bridge.catalog(sessionId);
    assert.equal(catalog.groups.some((group) => group.tools.some((tool) => tool.name === "get_settings" || tool.name === "foreign_only")), false);
    assert.ok(catalog.groups.some((group) => group.tools.some((tool) => tool.name === "model_only")));
    const descriptor = appDescriptor(catalog);
    const opened = await openApp(bridge, sessionId, descriptor);
    assert.equal(opened.toolName, "pattern_lab");
    assert.equal(opened.resourceUri, resourceUri);
    assert.equal(opened.toolInput, undefined);
    assert.equal(opened.toolResult, undefined);
    assert.match(String(opened.html), /MCP Apps demo/);
    assert.match(String(opened.sandboxUrl), /^http:\/\/127\.0\.0\.1:/);
    assert.deepEqual(await loadSessionEvents(directory, sessionId), []);
    const resources = await bridge.post("/plugin-apps/resources", { id: opened.id });
    assert.equal(resources.status, 200, resources.raw);
    assert.deepEqual(resources.body.resources, [{ uri: resourceUri, name: "Pattern lab", mimeType: "text/html;profile=mcp-app" }]);
    const templates = await bridge.post("/plugin-apps/resource-templates", { id: opened.id });
    assert.equal(templates.status, 200, templates.raw);
    assert.deepEqual(templates.body, { resourceTemplates: [] });
    const resource = await bridge.post("/plugin-apps/resource", { id: opened.id, uri: resourceUri });
    assert.equal(resource.status, 200, resource.raw);
    assert.equal((resource.body.contents as Array<{ text: string }>)[0]!.text, opened.html);
    const stream = await eventStream(bridge, t.signal);
    try {
      const settingsInvalidation = stream.next((event) => event.type === "session_state_invalidated" && event.sessionId === sessionId);
      const settings = await bridge.post("/plugin-apps/call", { id: opened.id, name: "get_settings", arguments: {} });
      assert.equal(settings.status, 200, settings.raw);
      assert.deepEqual(settings.body.structuredContent, { kind: "settings", defaultStyle: "jazz", defaultBars: 6, callCount: 1, generatedCount: 0 });
      await settingsInvalidation;
      const args = { prompt: "A repeated brass motif", bars: 3 };
      const patternInvalidation = stream.next((event) => event.type === "session_state_invalidated" && event.sessionId === sessionId);
      const generated = await bridge.post("/plugin-apps/call", { id: opened.id, name: "pattern_lab", arguments: args });
      assert.equal(generated.status, 200, generated.raw);
      const pattern = generated.body.structuredContent as { style: string; bars: number; notes: unknown[]; callCount: number };
      assert.equal(pattern.style, "jazz"); assert.equal(pattern.bars, 3); assert.equal(pattern.notes.length, 24); assert.equal(pattern.callCount, 2);
      const extension = (generated.body._meta as Record<string, unknown>)[LIVE_SMITH_ARTIFACT_META_KEY] as {
        version: number; artifacts: Array<{ artifactRef: string; noteCount: number; durationBeats: number }>;
      };
      assert.equal(extension.version, 1);
      assert.equal(extension.artifacts.length, 1);
      const artifact = extension.artifacts[0]!;
      assert.equal(artifact.noteCount, 24);
      assert.equal(artifact.durationBeats, 12);
      const saved = await readMidiArtifact(directory, sessionId, artifact.artifactRef, t.signal);
      assert.equal(saved.parsed.notes.length, pattern.notes.length);
      assert.equal(saved.artifact.toolName, "pattern_lab");
      assert.equal(generated.raw.includes(directory), false);
      await patternInvalidation;
      const events = await loadSessionEvents(directory, sessionId);
      assert.deepEqual(events.map((event) => event.kind), ["tool_call", "tool_result", "tool_call", "tool_result"]);
      assert.deepEqual(events.filter(event => event.kind === "tool_result").map(event => event.outcome), ["success", "success"]);
      assert.equal(events[2]!.name, descriptor.toolName);
      assert.deepEqual(JSON.parse(events[2]!.content), args);
      assert.deepEqual(JSON.parse(events[3]!.content).structuredContent, pattern);
      assert.deepEqual(JSON.parse(events[3]!.content).artifacts, extension.artifacts);
      assert.deepEqual(events[3]!.artifacts, [{ kind: "midi", id: artifact.artifactRef }]);
      assert.deepEqual((await bridge.state()).events, events);
      for (const name of ["missing_tool", "model_only", "foreign_only"]) {
        const denied = await bridge.post("/plugin-apps/call", { id: opened.id, name, arguments: {} });
        assert.notEqual(denied.status, 200, denied.raw);
        assert.match(String(denied.body.error), /not available/);
      }
      assert.deepEqual(await loadSessionEvents(directory, sessionId), events);
      const foreign = await openApp(bridge, sessionId, appDescriptor(catalog, "foreign"));
      const foreignResult = await bridge.post("/plugin-apps/call", { id: foreign.id, name: "foreign_only", arguments: {} });
      assert.equal(foreignResult.status, 200, foreignResult.raw);
      assert.equal((foreignResult.body.structuredContent as { kind: string }).kind, "settings");
      assert.equal((await bridge.post("/plugin-apps/close", { id: foreign.id })).status, 200);
      assert.equal((await bridge.post("/plugin-apps/close", { id: opened.id })).status, 200);
      const beforeClosedCalls = await loadSessionEvents(directory, sessionId);
      for (const [operation, extra] of [["call", { name: "pattern_lab", arguments: args }], ["resource", { uri: resourceUri }],
        ["resources", {}], ["resource-templates", {}]] as const) {
        const denied = await bridge.post(`/plugin-apps/${operation}`, { id: opened.id, ...extra });
        assert.equal(denied.status, 409, denied.raw);
      }
      assert.deepEqual(await loadSessionEvents(directory, sessionId), beforeClosedCalls);
      const reopened = await openApp(bridge, sessionId, descriptor);
      assert.notEqual(reopened.id, opened.id);
      assert.deepEqual(reopened.toolInput, args);
      assert.deepEqual(reopened.toolResult, generated.body);
      assert.deepEqual(await loadSessionEvents(directory, sessionId), beforeClosedCalls, "opening never fabricates a tool result");
      const resetProcess = await bridge.post("/plugin-apps/call", { id: reopened.id, name: "get_settings", arguments: {} });
      assert.equal((resetProcess.body.structuredContent as { callCount: number }).callCount, 1);
      assert.equal((await bridge.post("/plugin-apps/close", { id: reopened.id })).status, 200);
    } finally { await stream.close(); }
  });
});

test("MCP App requests stay bound to their active Session and saved configuration revision", { timeout: 15_000 }, async (t) => {
  const { directory, plugin } = await fixture(t);
  await withFlow(directory, async (bridge) => {
    const initial = await bridge.state();
    const firstId = initial.activeSessionId;
    const descriptor = appDescriptor(await bridge.catalog(firstId));
    const opened = await openApp(bridge, firstId, descriptor);
    const recorded = await bridge.post("/plugin-apps/call", { id: opened.id, name: "get_settings", arguments: {} });
    assert.equal(recorded.status, 200, recorded.raw);
    const beforeSwitch = await loadSessionEvents(directory, firstId);
    const second = await bridge.command({ kind: "new_session" });
    assert.notEqual(second.activeSessionId, firstId);
    for (const [operation, body] of [["open", { id: randomUUID(), sessionId: firstId, toolName: descriptor.toolName, signature: descriptor.signature }],
      ["call", { id: opened.id, name: "get_settings", arguments: {} }], ["resource", { id: opened.id, uri: resourceUri }]] as const) {
      const denied = await bridge.post(`/plugin-apps/${operation}`, body);
      assert.equal(denied.status, 409, denied.raw);
    }
    assert.deepEqual(await loadSessionEvents(directory, firstId), beforeSwitch);
    assert.deepEqual(await loadSessionEvents(directory, second.activeSessionId), []);
    await bridge.command({ kind: "select_session", sessionId: firstId });
    await bridge.command({ kind: "set_plugin_user_config", pluginId, sha256: plugin.sha256, revision: "0",
      values: { style: "jazz", default_bars: 5 }, secretUpdates: {} });
    const staleOpen = await bridge.post("/plugin-apps/open", { id: randomUUID(), sessionId: firstId, toolName: descriptor.toolName, signature: descriptor.signature });
    assert.equal(staleOpen.status, 409, staleOpen.raw);
    const staleResource = await bridge.post("/plugin-apps/resource", { id: opened.id, uri: resourceUri });
    assert.notEqual(staleResource.status, 200, staleResource.raw);
    const staleCall = await bridge.post("/plugin-apps/call", { id: opened.id, name: "get_settings", arguments: {} });
    assert.equal(staleCall.body.isError, true, staleCall.raw);
    assert.equal(staleCall.body.structuredContent, undefined);
    assert.equal((await bridge.post("/plugin-apps/close", { id: opened.id })).status, 200);
    const currentDescriptor = appDescriptor(await bridge.catalog(firstId));
    assert.notEqual(currentDescriptor.signature, descriptor.signature);
    const current = await openApp(bridge, firstId, currentDescriptor);
    const settings = await bridge.post("/plugin-apps/call", { id: current.id, name: "get_settings", arguments: {} });
    assert.equal(settings.status, 200, settings.raw);
    assert.deepEqual(settings.body.structuredContent, { kind: "settings", defaultStyle: "jazz", defaultBars: 5, callCount: 1, generatedCount: 0 });
    await bridge.post("/plugin-apps/close", { id: current.id });
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const change of ["delete", "switch"] as const) {
  test(`an App mutation queued behind a Session ${change} revalidates after acquiring the fence`, { timeout: 10_000 }, async (t) => {
    const { directory } = await fixture(t);
    const session = await createSession(directory, { title: "App owner", projectKey: "fixture", scope: {
      kind: "selection", identity: "owner", label: "App owner",
    } });
    const other = await createSession(directory, { title: "Other Session", projectKey: "fixture", scope: {
      kind: "selection", identity: "other", label: "Other Session",
    } });
    const signal = createHostAbortController().signal;
    const discovered = await createRequestPluginTools({ storageDirectory: directory, sessionId: session.id, signal, withAuthorization: authorize });
    const descriptor = discovered.catalogTools().find((tool) => tool.name === "pattern_lab")!.app!;
    await discovered.close();
    const fence = new SessionMutationFence();
    const key = sessionMutationFenceKey(directory, session.id);
    const precedingStarted = deferred();
    const releasePreceding = deferred();
    const appQueued = deferred();
    let activeSessionId = session.id;
    let validationCount = 0;
    const changedSessions: string[] = [];
    const apps = createPluginAppSessions({ storageDirectory: directory, fetchImpl: resolveFetchImplementation(), withAuthorization: authorize,
      async validateSession(sessionId) {
        validationCount++;
        if (sessionId !== activeSessionId) throw new ChatBridgeConflictError("The App Session is no longer active.");
        if (!(await listSessions(directory)).some((entry) => entry.id === sessionId && !entry.archivedAt)) {
          throw new ChatBridgeConflictError("The App Session is no longer available.");
        }
      },
      mutateSession(sessionId, requestSignal, operation) {
        const queued = fence.run(sessionMutationFenceKey(directory, sessionId), requestSignal, operation);
        appQueued.resolve();
        return queued;
      },
      sessionChanged(sessionId) { changedSessions.push(sessionId); },
    });
    try {
      const opened = await apps.request({ operation: "open", id: randomUUID(), sessionId: session.id,
        toolName: descriptor.toolName, signature: descriptor.signature }, signal) as { id: string };
      validationCount = 0;
      const preceding = fence.run(key, async () => {
        precedingStarted.resolve();
        await releasePreceding.promise;
        if (change === "delete") await deleteSession(directory, session.id);
        else activeSessionId = other.id;
      });
      await precedingStarted.promise;
      const running = apps.request({ operation: "call", id: opened.id, name: "pattern_lab",
        arguments: { prompt: "Queued pattern", bars: 2 } }, signal);
      const rejected = assert.rejects(running, /no longer (?:active|available)/);
      await appQueued.promise;
      assert.equal(fence.queuedOrActiveCount(key), 2);
      assert.equal(validationCount, 1, "the pre-queue Session check has completed");
      releasePreceding.resolve();
      await preceding;
      await rejected;
      assert.equal(validationCount, 2, "the queued mutation rechecks the Session under the acquired fence");
      assert.deepEqual(await loadSessionEvents(directory, session.id), []);
      assert.deepEqual(changedSessions, []);
      assert.equal((await listSessions(directory)).some((entry) => entry.id === session.id), change !== "delete");
    } finally { releasePreceding.resolve(); await apps.close(); }
  });
}

test("request Plugin snapshots bind package defaults by digest even while the persisted config revision remains zero", { timeout: 10_000 }, async (t) => {
  const files = unzipSync(exampleBytes);
  files["skills/defaults/SKILL.md"] = strToU8("---\nname: defaults\ndescription: Use the saved pattern defaults\n---\nDefault style: ${user_config.style}.\n");
  const { directory, plugin } = await fixture(t, zipSync(files));
  const session = await createSession(directory, { title: "Snapshot", projectKey: "fixture", scope: {
    kind: "selection", identity: "snapshot", label: "Snapshot",
  } });
  const skillInput = { storageDirectory: directory, sessionSkillIds: [`${pluginId}:defaults`], prompt: "Continue" };
  const admitted = await resolveSkillContext(skillInput);
  assert.match(admitted.instructionBlock, /Default style: ambient/);
  assert.deepEqual(admitted.pluginConfigSnapshots, { [pluginId]: { sha256: plugin.sha256, revision: "0" } });
  for (const file of ["plugin.json", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
    const manifest = JSON.parse(strFromU8(files[file]!));
    manifest.version = "2.0.0";
    const fields = manifest.userConfig ?? manifest.extensions[PLUGIN_CONFIG_NAMESPACE].userConfig;
    fields.style.default = "jazz";
    files[file] = strToU8(JSON.stringify(manifest));
  }
  const replacement = await installPlugin(directory, zipSync(files), { replace: true });
  assert.notEqual(replacement.sha256, plugin.sha256);
  assert.equal((await readPluginConfig(directory, pluginId)).revision, "0");
  await setPluginEnabled(directory, pluginId, true);
  await setPluginMcpServerApproved(directory, pluginId, "fixture", true);
  await setPluginArtifactPermissionApproved(directory, pluginId, "fixture", "output", true);
  const signal = createHostAbortController().signal;
  for (const pluginConfigSnapshots of [admitted.pluginConfigSnapshots!, {}]) {
    const rejected = await createRequestPluginTools({ storageDirectory: directory, sessionId: session.id, signal,
      withAuthorization: authorize, pluginConfigSnapshots });
    try {
      assert.deepEqual(rejected.tools(), []);
      assert.deepEqual(rejected.catalogTools(), []);
      assert.ok(rejected.issues.some((issue) => issue.pluginId === pluginId && issue.code === "invalid_configuration"));
    } finally { await rejected.close(); }
  }
  const current = await resolveSkillContext(skillInput);
  assert.match(current.instructionBlock, /Default style: jazz/);
  assert.deepEqual(current.pluginConfigSnapshots, { [pluginId]: { sha256: replacement.sha256, revision: "0" } });
  const accepted = await createRequestPluginTools({ storageDirectory: directory, sessionId: session.id, signal,
    withAuthorization: authorize, pluginConfigSnapshots: current.pluginConfigSnapshots });
  try {
    assert.deepEqual(accepted.issues, []);
    const owner = accepted.catalogTools().find((tool) => tool.name === "pattern_lab")!.app!.toolName;
    const result = await accepted.callAppTool(owner, "get_settings", {}, signal);
    assert.equal((result.result.structuredContent as { defaultStyle: string }).defaultStyle, "jazz");
  } finally { await accepted.close(); }
});


test("MCP App MIDI outputs require explicit permission and reject caller-owned paths", { timeout: 15_000 }, async (t) => {
  const { directory } = await fixture(t);
  await withFlow(directory, async (bridge) => {
    const sessionId = (await bridge.state()).activeSessionId;
    const descriptor = appDescriptor(await bridge.catalog(sessionId));
    const opened = await openApp(bridge, sessionId, descriptor);
    const deniedPath = await bridge.post("/plugin-apps/call", { id: opened.id, name: "pattern_lab",
      arguments: { prompt: "A melody", bars: 2, outputMidi: "/tmp/forged.mid" } });
    assert.equal(deniedPath.body.isError, true);
    assert.deepEqual((await inspectMidiArtifacts(directory, sessionId)).artifacts, []);
    await setPluginArtifactPermissionApproved(directory, pluginId, "fixture", "output", false);
    const deniedPermission = await bridge.post("/plugin-apps/call", { id: opened.id, name: "pattern_lab",
      arguments: { prompt: "A melody", bars: 2 } });
    assert.equal(deniedPermission.body.isError, true);
    assert.deepEqual((await inspectMidiArtifacts(directory, sessionId)).artifacts, []);
    await bridge.post("/plugin-apps/close", { id: opened.id });
  });
});

test("MCP App replaces forged server artifact refs with host metadata", { timeout: 15_000 }, async (t) => {
  const files = unzipSync(exampleBytes);
  files["server.mjs"] = strToU8(strFromU8(files["server.mjs"]!).replace('structuredContent: { kind: "settings",',
    '_meta: { "io.github.samkuler/live-smith-artifacts": { version: 1, artifacts: [{ artifactRef: "forged" }] }, "fixture/meta": true }, structuredContent: { kind: "settings",'));
  const { directory } = await fixture(t, zipSync(files));
  await withFlow(directory, async (bridge) => {
    const sessionId = (await bridge.state()).activeSessionId;
    const opened = await openApp(bridge, sessionId, appDescriptor(await bridge.catalog(sessionId)));
    const result = await bridge.post("/plugin-apps/call", { id: opened.id, name: "get_settings", arguments: {} });
    assert.deepEqual(result.body._meta, { "fixture/meta": true, [LIVE_SMITH_ARTIFACT_META_KEY]: { version: 1, artifacts: [] } });
    assert.equal((await loadSessionEvents(directory, sessionId)).some((event) => event.content.includes("forged")), false);
    await bridge.post("/plugin-apps/close", { id: opened.id });
  });
});
