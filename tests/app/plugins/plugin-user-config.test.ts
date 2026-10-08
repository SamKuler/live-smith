import { modelMessageText } from "../../model/support/model-message-test-helpers.js";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { fstatSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

import { strToU8, zipSync } from "fflate/browser";

import type { LiveInteractionContext } from "../../../src/live/context.js";
import type { SavedProfile } from "../../../src/model/profile.js";
import type { TransportRequest } from "../../../src/model/provider.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import { installPlugin } from "../../../src/storage/plugins.js";
import { saveSavedProfile } from "../../../src/storage/settings.js";
import type { ChatBridgeState } from "../../../src/ui/chat-state.js";
import { runAgentFlow, type AgentFlowDependencies } from "../../../src/app/agent-flow.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";

const pluginId = "config-runtime";
const token = "fixture-private-config-token";
const defaultSecret = "fixture-private-config-default";
const values = { style: "jazz", amount: 0.75, enabled: true, directory: "/Music folder", tags: ["slow\npulse", "loose"] };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function fixtureArchive(): Uint8Array {
  const fields = {
    style: { type: "string", title: "Style", description: "Musical style", default: "ambient", options: ["ambient", "jazz"] },
    amount: { type: "number", title: "Amount", description: "Processing amount", required: true, default: 0.25, min: 0, max: 1 },
    enabled: { type: "boolean", title: "Enabled", description: "Processing state", default: false },
    directory: { type: "directory", title: "Directory", description: "Output destination", required: true, default: "/Music" },
    tags: { type: "string", title: "Tags", description: "Style tags", multiple: true, default: ["steady"] },
    token: { type: "string", title: "Token", description: "Runtime credential", sensitive: true, required: true },
    defaultSecret: { type: "string", title: "Private default", description: "Packaged credential", sensitive: true, default: defaultSecret },
  };
  const server = `
import readline from "node:readline";
import process from "node:process";
import { createHash } from "node:crypto";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "server/discover") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "legacy" } }) + "\\n");
  } else if (request.method === "initialize") {
    send(request.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "config-runtime", version: "1.0.0" } });
  } else if (request.method === "tools/list") {
    send(request.id, { tools: [{ name: "inspect_config", description: "Return the saved Plugin configuration.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
  } else if (request.method === "tools/call") {
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    send(request.id, { content: [{ type: "text", text: "Configuration received." }], structuredContent: {
      style: process.env.CONFIG_STYLE, amount: Number(process.env.CONFIG_AMOUNT), enabled: process.env.CONFIG_ENABLED === "true",
      directory: process.argv[2], tags: JSON.parse(process.argv[3]), tokenDigest: hash(process.env.CONFIG_TOKEN),
      defaultSecretDigest: hash(process.env.CONFIG_DEFAULT_SECRET),
    } });
  }
});
`;
  return zipSync({
    ".claude-plugin/plugin.json": strToU8(JSON.stringify({ name: pluginId, version: "1.0.0", userConfig: fields })),
    ".mcp.json": strToU8(JSON.stringify({ mcpServers: { fixture: { command: process.execPath,
      args: ["${PLUGIN_ROOT}/server.mjs", "${user_config.directory}", "${user_config.tags}"],
      env: { CONFIG_STYLE: "${user_config.style}", CONFIG_AMOUNT: "${user_config.amount}", CONFIG_ENABLED: "${user_config.enabled}",
        CONFIG_TOKEN: "${user_config.token}", CONFIG_DEFAULT_SECRET: "${user_config.defaultSecret}" },
    } } })),
    "server.mjs": strToU8(server),
    "skills/music/SKILL.md": strToU8("---\nname: music\ndescription: Use configured music settings\n---\n" +
      "Style ${user_config.style}; amount ${user_config.amount}; enabled ${user_config.enabled}; location ${user_config.directory}; " +
      "tags ${user_config.tags}; token ${user_config.token}; private default ${user_config.defaultSecret}.\n"),
  });
}

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-config-flow-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const plugin = await installPlugin(directory, fixtureArchive());
  return { directory, plugin };
}

interface BridgeResult {
  status: number;
  commandId: string;
  raw: string;
  body: Record<string, unknown>;
}

interface Bridge {
  endpoint(pathname: string): URL;
  state(): Promise<ChatBridgeState>;
  post(pathname: string, body: unknown): Promise<BridgeResult>;
  command(body: unknown): Promise<ChatBridgeState>;
}

async function withFlow(directory: string, use: (bridge: Bridge) => Promise<void>, dependencies: AgentFlowDependencies = {}): Promise<void> {
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"), summary: "Track: Lead", target: {},
    scope: { kind: "track", identity: "track-one", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  await runAgentFlow({
    application: { song: { handle: { id: 1n }, tempo: 120, tracks: [], returnTracks: [], scenes: [], cuePoints: [] } },
    environment: { storageDirectory: directory, tempDirectory: directory },
    ui: { showModalDialog: async (url: string) => {
      let sequence = 0;
      const endpoint = (pathname: string) => { const target = new URL(url); target.pathname = pathname; return target; };
      const post = async (pathname: string, body: unknown): Promise<BridgeResult> => {
        const commandId = `plugin-config-${++sequence}`;
        const response = await fetch(endpoint(pathname), { method: "POST", headers: { "Content-Type": "application/json",
          [pathname === "/send" ? "X-Live-Smith-Send-Id" : "X-Live-Smith-Command-Id"]: commandId }, body: JSON.stringify(body) });
        const raw = await response.text();
        return { status: response.status, commandId, raw, body: JSON.parse(raw) as Record<string, unknown> };
      };
      await use({ endpoint, post,
        async state() {
          const response = await fetch(endpoint("/state"));
          const raw = await response.text();
          assert.equal(response.status, 200, raw);
          return JSON.parse(raw) as ChatBridgeState;
        },
        async command(body) {
          const response = await post("/command", body);
          assert.equal(response.status, 200, response.raw);
          return response.body as unknown as ChatBridgeState;
        },
      });
    } },
  } as never, interaction, { renderHtml: () => "<html></html>", ...dependencies });
}

function configuration(state: ChatBridgeState) {
  const plugin = state.plugins.find((entry) => entry.id === pluginId);
  assert.ok(plugin?.userConfig);
  return plugin.userConfig;
}

function saveInput(sha256: string, revision = "0") {
  return { kind: "set_plugin_user_config", pluginId, sha256, revision, values, secretUpdates: { token } };
}

function assertPrivate(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes(defaultSecret), false);
}

async function collectEvents(bridge: Bridge) {
  const response = await fetch(bridge.endpoint("/events"));
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const events: Array<Record<string, unknown>> = [];
  const reading = (async () => {
    let pending = "";
    while (true) {
      const part = await reader.read();
      if (part.done) return;
      pending += Buffer.from(part.value).toString("utf8");
      let end;
      while ((end = pending.indexOf("\n\n")) !== -1) {
        const block = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (data) events.push(JSON.parse(data) as Record<string, unknown>);
      }
    }
  })();
  return { events,
    async terminal(commandId: string) {
      for (let attempts = 0; attempts < 100; attempts++) {
        const event = events.find((entry) => entry.commandId === commandId && ["state", "error"].includes(String(entry.type)));
        if (event) return event;
        await delay(10);
      }
      assert.fail(`No terminal event arrived for ${commandId}.`);
    },
    async close() { await reader.cancel(); await reading; },
  };
}

test("Plugin configuration persists through the HTTP bridge and reopen without leaking secrets into state or events", { timeout: 10_000 }, async (t) => {
  const { directory, plugin } = await fixture(t);
  let sessionId = "";
  await withFlow(directory, async (bridge) => {
    const initial = await bridge.state();
    sessionId = initial.activeSessionId;
    assert.equal(initial.runtimeProfile, null);
    assert.deepEqual(configuration(initial).invalidFields, ["token"]);
    assert.equal(configuration(initial).fields.find((field) => field.name === "defaultSecret")!.default, undefined);
    assertPrivate(initial);
    const stream = await collectEvents(bridge);
    try {
      const saved = await bridge.post("/command", saveInput(plugin.sha256));
      assert.equal(saved.status, 200, saved.raw);
      const state = saved.body as unknown as ChatBridgeState;
      assert.equal(configuration(state).revision, "1");
      assert.deepEqual(configuration(state).values, values);
      assert.deepEqual(configuration(state).configuredSecrets, ["defaultSecret", "token"]);
      assert.deepEqual(configuration(state).invalidFields, []);
      const terminal = await stream.terminal(saved.commandId);
      assert.equal(terminal.type, "state");
      assert.equal(configuration(terminal.state as ChatBridgeState).revision, "1");
      assertPrivate([saved.body, await bridge.state(), stream.events]);
      assert.deepEqual(await loadSessionEvents(directory, sessionId), []);
    } finally { await stream.close(); }
  });
  await withFlow(directory, async (bridge) => {
    const reopened = await bridge.state();
    assert.equal(configuration(reopened).revision, "1");
    assert.deepEqual(configuration(reopened).values, values);
    assert.deepEqual(configuration(reopened).configuredSecrets, ["defaultSecret", "token"]);
    assertPrivate(reopened);
  });
});

test("configuration commands reject stale owners, wrong typed values and credential-bearing extra fields without changing storage", { timeout: 10_000 }, async (t) => {
  const { directory, plugin } = await fixture(t);
  await withFlow(directory, async (bridge) => {
    const saved = await bridge.command(saveInput(plugin.sha256));
    const input = { ...saveInput(plugin.sha256, "1"), secretUpdates: {} };
    const malformed = [
      { ...input, apiKey: token }, { ...input, profile: { apiKey: token } }, { ...input, sessionId: saved.activeSessionId },
      { ...input, values: [] }, { ...input, secretUpdates: [] }, { ...input, revision: 1 }, { ...input, revision: "01" },
      { ...input, sha256: "invalid" }, { ...input, pluginId: "../plugin" },
      { ...input, values: { ...values, token } }, { ...input, values: { ...values, unknown: token } },
      { ...input, secretUpdates: { style: token } }, { ...input, secretUpdates: { token: 42 } },
      { ...input, secretUpdates: { token: null } },
      ...[-0.1, 1.1, "0.5"].map((amount) => ({ ...input, values: { ...values, amount } })),
      { ...input, values: { ...values, enabled: "false" } }, { ...input, values: { ...values, tags: [1] } },
      { ...input, values: { ...values, directory: " " } }, { ...input, values: { ...values, style: "unknown" } },
    ];
    for (const command of malformed) {
      const rejected = await bridge.post("/command", command);
      assert.equal(rejected.status, 400, rejected.raw);
      assert.equal(typeof rejected.body.error, "string");
      assertPrivate(rejected.body);
    }
    for (const command of [{ ...input, sha256: "b".repeat(64) }, { ...input, revision: "0" }, { ...input, pluginId: "missing-plugin" }]) {
      const rejected = await bridge.post("/command", command);
      assert.equal(rejected.status, 409, rejected.raw);
      assertPrivate(rejected.body);
    }
    const current = await bridge.state();
    assert.deepEqual(configuration(current), configuration(saved));
    assert.deepEqual(await loadSessionEvents(directory, saved.activeSessionId), []);
  });
});

test("saved configuration reaches selected Skill instructions and a real MCP process through the ordinary model tool loop", { timeout: 15_000 }, async (t) => {
  const { directory, plugin } = await fixture(t);
  const profile: SavedProfile = { id: "offline", name: "Offline fixture", connection: { kind: "direct-api", apiFamily: "openai",
    apiMode: "responses", baseUrl: "https://unused.example.test/v1", apiKey: "fixture-profile-key" }, defaultModel: "fixture-model",
    models: [{ model: "fixture-model", parameters: { maxOutputTokens: 2048, reasoning: { mode: "default" } }, advanced: {} }] };
  await saveSavedProfile(directory, profile);
  let toolName = "";
  let expected = values;
  const requests: TransportRequest[] = [];
  const results: unknown[] = [];
  await withFlow(directory, async (bridge) => {
    const initial = await bridge.state();
    await bridge.command(saveInput(plugin.sha256));
    await bridge.command({ kind: "set_plugin_enabled", pluginId, enabled: true });
    await bridge.command({ kind: "set_plugin_mcp_server_approved", pluginId, sha256: plugin.sha256, serverId: "fixture", approved: true });
    await bridge.command({ kind: "set_session_skills", sessionId: initial.activeSessionId, skillIds: [`${pluginId}:music`] });
    const catalog = await bridge.post("/session-tools", { kind: "load_session_tools", sessionId: initial.activeSessionId });
    assert.equal(catalog.status, 200, catalog.raw);
    const panel = (catalog.body as unknown as ChatBridgeState).sessionToolCatalog!.groups.find((group) => group.kind === "mcp")!.tools[0]!.panel!;
    toolName = panel.toolName;
    const first = await bridge.post("/send", { prompt: "Inspect configured settings.", sessionId: initial.activeSessionId });
    assert.equal(first.status, 200, first.raw);
    assert.deepEqual(results[0], { ...values, tokenDigest: digest(token), defaultSecretDigest: digest(defaultSecret) });
    expected = { ...values, style: "ambient", amount: 0.125, enabled: false, tags: ["updated"] };
    await bridge.command({ ...saveInput(plugin.sha256, "1"), values: expected, secretUpdates: {} });
    const staleTool = await bridge.post("/command", { kind: "run_plugin_tool", sessionId: initial.activeSessionId,
      toolName, signature: panel.signature, arguments: {} });
    assert.equal(staleTool.status, 409, staleTool.raw);
    const second = await bridge.post("/send", { prompt: "Inspect the updated settings.", sessionId: initial.activeSessionId });
    assert.equal(second.status, 200, second.raw);
    assert.deepEqual(results[1], { ...expected, tokenDigest: digest(token), defaultSecretDigest: digest(defaultSecret) });
    assert.equal(requests.length, 4);
    assertPrivate([first.body, second.body, await bridge.state(), await loadSessionEvents(directory, initial.activeSessionId)]);
  }, {
    modelBackendManager: {
      async forProfile() {
        return { kind: "direct-api" as const, async listModels() { return []; }, async close() {},
          async createToolTurn(request) {
            requests.push(request);
            assert.ok(request.systemInstructions.includes(`<skill id="${pluginId}:music">`));
            assert.ok(request.systemInstructions.includes(`Style ${expected.style}; amount ${expected.amount}; enabled ${expected.enabled}; location ${expected.directory};`));
            assert.ok(request.systemInstructions.includes(`tags ${JSON.stringify(expected.tags)}; token [sensitive value]; private default [sensitive value].`));
            assertPrivate(request);
            if (request.agentMessages.length === 0) {
              assert.ok(request.tools.some((tool) => tool.type === "function" && tool.function.name === toolName));
              return { content: "Inspecting configuration.", toolCalls: [{ id: `inspect-${requests.length}`, name: toolName, arguments: "{}" }] };
            }
            const result = JSON.parse(modelMessageText(request.agentMessages.at(-1)));
            results.push(result.structuredContent);
            return { content: "Configuration inspected.", toolCalls: [] };
          },
        };
      },
      async oauth() { throw new Error("Unexpected OAuth backend."); },
      async oauthLease() { throw new Error("Unexpected OAuth backend."); },
      async invalidateOAuth() {}, async close() {},
    },
  });
});

test("a configuration durability failure reports an unknown outcome with the readable committed revision", { timeout: 10_000 }, async (t) => {
  const { directory, plugin } = await fixture(t);
  const packageDirectory = path.join(directory, "live-smith-plugins", "packages", pluginId);
  const handle = await fs.open(packageDirectory, "r");
  const identity = await handle.stat();
  const prototype = Object.getPrototypeOf(handle) as fs.FileHandle;
  const sync = prototype.sync;
  await handle.close();
  let armed = false;
  let injected = false;
  t.mock.method(prototype, "sync", async function (this: fs.FileHandle) {
    const current = fstatSync(this.fd);
    if (armed && !injected && current.dev === identity.dev && current.ino === identity.ino) {
      injected = true;
      throw new Error("Injected directory durability failure.");
    }
    return sync.call(this);
  });
  await withFlow(directory, async (bridge) => {
    const stream = await collectEvents(bridge);
    try {
      armed = true;
      const response = await bridge.post("/command", saveInput(plugin.sha256));
      assert.equal(injected, true);
      assert.equal(response.status, 500, response.raw);
      assert.equal(response.body.commandOutcome, "unknown");
      assert.equal(configuration(response.body.state as ChatBridgeState).revision, "1");
      const terminal = await stream.terminal(response.commandId);
      assert.equal(terminal.type, "error");
      assert.equal(terminal.commandOutcome, "unknown");
      assert.equal(configuration(terminal.state as ChatBridgeState).revision, "1");
      const current = await bridge.state();
      assert.equal(configuration(current).revision, "1");
      assert.deepEqual(configuration(current).values, values);
      assertPrivate([response.body, terminal, current]);
      const stale = await bridge.post("/command", saveInput(plugin.sha256));
      assert.equal(stale.status, 409, stale.raw);
    } finally { await stream.close(); }
  });
});
