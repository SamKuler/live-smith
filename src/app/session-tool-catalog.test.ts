import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { URL } from "node:url";

import { strToU8, zipSync } from "fflate/browser";

import type { LiveInteractionContext } from "../live/context.js";
import { installPlugin, setPluginEnabled, setPluginMcpServerApproved } from "../storage/plugins.js";
import { saveGlobalSettings } from "../storage/settings.js";
import { chatDialogStateForWire, type ChatDialogState } from "../ui/chat-state.js";
import { runAgentFlow } from "./agent-flow.js";
import { parseCommandInput } from "./chat-bridge-http.js";
import { liveContextPresentationFixture } from "./live-context.test-harness.js";
import { sessionToolCatalogOwner } from "./session-tool-catalog.js";

const serverSource = String.raw`
import fs from "node:fs";
import readline from "node:readline";
fs.writeFileSync(process.argv[2], "started");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "server/discover") send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "legacy" } });
  else if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: {
    protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "catalog-fixture", version: "1" }
  } });
  else if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools: [{
    name: "convert_audio", description: "Convert one audio asset", inputSchema: { type: "object", properties: {} }
  }, {
    name: "long_description", description: "x".repeat(700), inputSchema: { type: "object", properties: {} }
  }] } });
  else if (request.method === "tools/call") fs.writeFileSync(process.argv[3], "called");
});
`;

function packageBytes(startedPath: string, calledPath: string): Uint8Array {
  return zipSync({
    "plugin.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "catalog-fixture",
    })),
    "mcp.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { local: { type: "stdio", command: "node",
        args: ["${PLUGIN_ROOT}/server.mjs", startedPath, calledPath] } },
    })),
    "server.mjs": strToU8(serverSource),
  });
}

function route(url: string, pathname: string): URL {
  const endpoint = new URL(url);
  endpoint.pathname = pathname;
  return endpoint;
}

test("tool catalog command accepts only its Session identifier", () => {
  const input = { kind: "load_session_tools", sessionId: "session-one" };
  assert.deepEqual(parseCommandInput(input), input);
  for (const invalid of [
    { ...input, sessionId: "" },
    { ...input, sessionId: "../other" },
    { ...input, apiKey: "synthetic-secret" },
    { ...input, profileId: "profile-one" },
  ]) assert.throws(() => parseCommandInput(invalid));
});

test("tool catalog ownership changes with Session, Profile, Plugin, and Connection state", () => {
  const state = {
    activeSessionId: "session-one", activeProfileRevision: null, runtimeProfile: null,
    integrationConnections: { revision: "0", connections: [] }, plugins: [],
    sunoAccounts: [], audioJobs: [], events: [],
  } as unknown as ChatDialogState;
  const owner = sessionToolCatalogOwner(state);
  const absentMedia = { ...state };
  delete absentMedia.sunoAccounts;
  delete absentMedia.audioJobs;
  assert.equal(sessionToolCatalogOwner(absentMedia), owner);
  for (const changed of [
    { ...state, activeSessionId: "session-two" },
    { ...state, activeProfileRevision: "a".repeat(64) },
    { ...state, runtimeProfile: { selection: { model: "other-model" } } },
    { ...state, integrationConnections: { revision: "1", connections: [] } },
    { ...state, plugins: [{ id: "fixture", enabled: true }] },
    { ...state, audioJobs: [{ id: "job-one", status: "completed", outputs: [] }] },
  ] as ChatDialogState[]) assert.notEqual(sessionToolCatalogOwner(changed), owner);
});

test("tool catalog wire projection exposes only display fields", () => {
  const projected = chatDialogStateForWire({ sessionToolCatalog: {
    sessionId: "session-one", loadedAt: "2026-09-25T00:00:00.000Z", modelToolsSupported: true,
    truncated: false, credential: "synthetic-secret",
    groups: [{ kind: "mcp", pluginId: "catalog-fixture", serverId: "local", credential: "synthetic-secret",
      tools: [{ name: "convert_audio", description: "Convert audio", credential: "synthetic-secret" }] }],
    issues: [],
  } } as unknown as ChatDialogState);
  assert.deepEqual(projected.sessionToolCatalog, {
    sessionId: "session-one", loadedAt: "2026-09-25T00:00:00.000Z", modelToolsSupported: true,
    truncated: false,
    groups: [{ kind: "mcp", pluginId: "catalog-fixture", serverId: "local",
      tools: [{ name: "convert_audio", description: "Convert audio" }] }],
    issues: [],
  });
  assert.doesNotMatch(JSON.stringify(projected), /synthetic-secret/u);
});

for (const source of ["plugin", "standalone"] as const) test(`explicit Session tool load discovers ${source} MCP names and invalidates its modal snapshot`, async (t) => {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-tool-catalog-"));
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const startedPath = path.join(storageDirectory, "mcp-started");
  const calledPath = path.join(storageDirectory, "mcp-called");
  const directConnection = {
    id: "direct-catalog", name: "Local catalog", enabled: true,
    mcp: { type: "stdio" as const, command: "node",
      args: [path.join(storageDirectory, "server.mjs"), startedPath, calledPath] },
    secrets: {}, artifactInputApproved: false, artifactOutputApproved: false,
  };
  if (source === "plugin") {
    await installPlugin(storageDirectory, packageBytes(startedPath, calledPath));
    await setPluginMcpServerApproved(storageDirectory, "catalog-fixture", "local", true);
    await setPluginEnabled(storageDirectory, "catalog-fixture", true);
  } else {
    await fs.writeFile(path.join(storageDirectory, "server.mjs"), serverSource);
    await saveGlobalSettings(storageDirectory, { integrationConnections: {
      action: "upsert", expectedRevision: "0", connection: directConnection,
    } });
  }
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"), summary: "Track: Lead", target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  let commandSequence = 0;
  await runAgentFlow({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory },
    ui: { showModalDialog: async (url: string) => {
      const readState = async (): Promise<ChatDialogState> => {
        const response = await fetch(route(url, "/state"));
        assert.equal(response.status, 200);
        return response.json() as Promise<ChatDialogState>;
      };
      const command = async (body: unknown): Promise<ChatDialogState> => {
        const response = await fetch(route(url, "/command"), {
          method: "POST", headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Command-Id": `tools-command-${++commandSequence}`,
          }, body: JSON.stringify(body),
        });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        return JSON.parse(text) as ChatDialogState;
      };
      const initial = await readState();
      assert.equal(initial.sessionToolCatalog, undefined, "opening the dialog does not discover MCP tools");
      await assert.rejects(fs.access(startedPath), "opening the dialog must not start MCP");
      const loaded = await command({ kind: "load_session_tools", sessionId: initial.activeSessionId });
      assert.equal(await fs.readFile(startedPath, "utf8"), "started");
      await assert.rejects(fs.access(calledPath), "loading the directory must not invoke a tool");
      const catalog = loaded.sessionToolCatalog;
      assert.ok(catalog);
      assert.equal(catalog.sessionId, initial.activeSessionId);
      assert.equal(catalog.modelToolsSupported, false, "no active Profile cannot use function tools");
      assert.ok(catalog.groups.some((group) => group.kind === "live" &&
        group.tools.some((tool) => tool.name === "inspect_current_object")));
      const mcpGroups = catalog.groups.filter((group) => group.kind === "mcp");
      assert.ok(mcpGroups.every((group) => group.tools.every((tool) => tool.panel?.fields.length === 0)));
      assert.deepEqual(mcpGroups.map((group) => ({ ...group, tools: group.tools.map(({ name, description }) => ({ name, description })) })), [{
        kind: "mcp", ...(source === "plugin" ? { pluginId: "catalog-fixture", serverId: "local" }
          : { serverId: "server", connectionId: directConnection.id, connectionName: directConnection.name }), tools: [
          { name: "convert_audio", description: "Convert one audio asset" },
          { name: "long_description", description: "x".repeat(511) + "…" },
        ],
      }]);
      assert.deepEqual(catalog.issues, []);
      assert.doesNotMatch(JSON.stringify(catalog), /synthetic-secret/u);
      assert.deepEqual((await readState()).sessionToolCatalog, catalog);
      await command({ kind: "rename_session", sessionId: initial.activeSessionId, title: "Original" });
      const nextSession = await command({ kind: "new_session" });
      assert.notEqual(nextSession.activeSessionId, initial.activeSessionId);
      assert.equal(nextSession.sessionToolCatalog, undefined);
      const returned = await command({ kind: "select_session", sessionId: initial.activeSessionId });
      assert.equal(returned.sessionToolCatalog, undefined, "switching back does not revive a stale snapshot");
      assert.ok((await command({ kind: "load_session_tools", sessionId: initial.activeSessionId })).sessionToolCatalog);
      const disabled = await command(source === "plugin"
        ? { kind: "set_plugin_enabled", pluginId: "catalog-fixture", enabled: false }
        : { kind: "save_global_settings", integrationConnections: {
          action: "upsert", expectedRevision: "1", connection: { ...directConnection, enabled: false },
        } });
      assert.equal(disabled.sessionToolCatalog, undefined);
      assert.equal((await readState()).sessionToolCatalog, undefined);
    } },
  } as never, interaction, { renderHtml: () => "<html></html>" });
});
