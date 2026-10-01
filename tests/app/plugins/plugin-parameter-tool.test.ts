import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import test from "node:test";
import { URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { zipSync } from "fflate/browser";
import { installPlugin, setPluginEnabled, setPluginMcpServerApproved } from "../../../src/storage/plugins.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import { createSession } from "../../../src/storage/sessions.js";
import { saveGlobalSettings } from "../../../src/storage/settings.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import type { ChatDialogState } from "../../../src/ui/chat-state.js";
import type { LiveInteractionContext } from "../../../src/live/context.js";
import { runAgentFlow } from "../../../src/app/agent-flow.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";
import { parseCommandInput } from "../../../src/app/chat/chat-bridge-http.js";
import { createRequestPluginTools } from "../../../src/app/plugins/request-plugin-tools.js";
import { runPluginParameterTool } from "../../../src/app/plugins/plugin-parameter-tool.js";

const fixtureRoot = new URL("../../../test-fixtures/plugins/portable-skill-mcp/", import.meta.url);
const authorize = async <T>(_signal: AbortSignal, operation: () => Promise<T>): Promise<T> => operation();

test("Plugin parameter commands accept only a bound tool, Session, signature and arguments", () => {
  const input = { kind: "run_plugin_tool", sessionId: "session-one", toolName: "plg_fixture_echo",
    signature: "a".repeat(64), arguments: { text: "hello" } };
  assert.deepEqual(parseCommandInput(input), input);
  for (const invalid of [
    { ...input, sessionId: "../session" }, { ...input, signature: "" }, { ...input, toolName: "" },
    { ...input, arguments: [] }, { ...input, apiKey: "synthetic-secret" }, { ...input, settings: {} },
  ]) assert.throws(() => parseCommandInput(invalid));
});

test("an installed Plugin parameter panel runs without a model and saves the actual MCP result", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-panel-flow-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = await Promise.all(["plugin.json", "mcp.json", "server.mjs"].map(async (name) =>
    [name, await fs.readFile(new URL(name, fixtureRoot))] as const));
  await installPlugin(directory, zipSync(Object.fromEntries(files)));
  await setPluginEnabled(directory, "fixture.portable", true);
  await setPluginMcpServerApproved(directory, "fixture.portable", "fixture", true);
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"), summary: "Track: Lead", target: {},
    scope: { kind: "track", identity: "track-one", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  await runAgentFlow({
    application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: directory },
    ui: { showModalDialog: async (url: string) => {
      let sequence = 0;
      const endpoint = (pathname: string) => { const target = new URL(url); target.pathname = pathname; return target; };
      const post = (pathname: string, input: unknown, id = `panel-${++sequence}`) => fetch(endpoint(pathname), {
        method: "POST", headers: { "Content-Type": "application/json", "X-Live-Smith-Command-Id": id },
        body: JSON.stringify(input),
      });
      const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
      assert.equal(initial.runtimeProfile, null);
      const response = await post("/session-tools", { kind: "load_session_tools", sessionId: initial.activeSessionId });
      assert.equal(response.status, 200);
      const state = await response.json() as ChatDialogState;
      const panel = state.sessionToolCatalog!.groups.find((group) => group.kind === "mcp")!.tools[0]!.panel!;
      assert.deepEqual(panel.fields.map((field) => field.name), ["text", "repeat", "letterCase", "showLength"]);
      const command = { kind: "run_plugin_tool", sessionId: initial.activeSessionId,
        toolName: panel.toolName, signature: panel.signature,
        arguments: { text: "hello", repeat: 2, letterCase: "upper", showLength: true } };
      const invalid = await post("/command", { ...command, arguments: { ...command.arguments, repeat: 9 } });
      assert.notEqual(invalid.status, 200);
      assert.equal((await loadSessionEvents(directory, initial.activeSessionId)).length, 0);
      const run = await post("/command", command, "one-run-only");
      const runText = await run.text();
      assert.equal(run.status, 200, runText);
      const completed = JSON.parse(runText) as ChatDialogState;
      assert.equal(completed.runtimeProfile, null);
      const events = await loadSessionEvents(directory, initial.activeSessionId);
      assert.deepEqual(events.map((event) => event.kind), ["tool_call", "tool_result"]);
      assert.deepEqual(JSON.parse(events[0]!.content), command.arguments);
      assert.deepEqual(JSON.parse(events[1]!.content).structuredContent, { echoed: "HELLO HELLO", characters: 11 });
      assert.equal((await post("/command", command, "one-run-only")).status, 409);
      assert.equal((await loadSessionEvents(directory, initial.activeSessionId)).length, 2);
      await setPluginMcpServerApproved(directory, "fixture.portable", "fixture", false);
      assert.equal((await post("/command", command)).status, 409);
      assert.equal((await loadSessionEvents(directory, initial.activeSessionId)).length, 2);
      assert.equal((await post("/command", { ...command, sessionId: "another-session" })).status, 409);
    } },
  } as never, interaction, { renderHtml: () => "<html></html>" });
});

test("standalone panels reject definition and credential revision changes before tool execution", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-panel-drift-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const serverPath = path.join(directory, "server.mjs");
  const source = await fs.readFile(new URL("server.mjs", fixtureRoot), "utf8");
  await fs.writeFile(serverPath, source);
  const connection = { id: "panel-server", name: "Panel server", enabled: true,
    mcp: { type: "stdio" as const, command: "node", args: [serverPath] }, secrets: {},
    artifactInputApproved: false, artifactOutputApproved: false };
  await saveGlobalSettings(directory, { integrationConnections: {
    action: "upsert", expectedRevision: "0", connection,
  } });
  const session = await createSession(directory, { title: "Panel", projectKey: "project", scope: {
    kind: "track", identity: "track", label: "Lead",
  } });
  const input = { storageDirectory: directory, sessionId: session.id,
    signal: createHostAbortController().signal, withPluginAuthorization: authorize };
  const discovery = await createRequestPluginTools({ ...input, withAuthorization: authorize });
  const panel = discovery.catalogTools()[0]!.panel!;
  await discovery.close();
  const run = { ...input, toolName: panel.toolName, signature: panel.signature, arguments: { text: "hello" } };
  await fs.writeFile(serverPath, source.replace('maximum: 8', 'maximum: 4'));
  await assert.rejects(runPluginParameterTool(run), /changed/);
  assert.equal((await loadSessionEvents(directory, session.id)).length, 0);
  await fs.writeFile(serverPath, source);
  await fs.writeFile(serverPath, source.replace('Echo fixture text', 'Replace remote content'));
  await assert.rejects(runPluginParameterTool(run), /changed/);
  assert.equal((await loadSessionEvents(directory, session.id)).length, 0);
  await fs.writeFile(serverPath, source);
  await saveGlobalSettings(directory, { integrationConnections: {
    action: "upsert", expectedRevision: "1", connection: { ...connection, secrets: { TOKEN: "synthetic-new-secret" } },
  } });
  await assert.rejects(runPluginParameterTool(run), /changed/);
  assert.equal((await loadSessionEvents(directory, session.id)).length, 0);
  const refreshed = await createRequestPluginTools({ ...input, withAuthorization: authorize });
  const freshPanel = refreshed.catalogTools()[0]!.panel!;
  await refreshed.close();
  assert.doesNotMatch(JSON.stringify(freshPanel), /synthetic-new-secret/);
  assert.deepEqual(await runPluginParameterTool({ ...run, signature: freshPanel.signature }), { failed: false });
});

test("Stop after an MCP call starts returns its uncertain outcome and saved Session state", { timeout: 10_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-panel-stop-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "performed-work");
  const source = await fs.readFile(new URL("server.mjs", fixtureRoot), "utf8");
  const serverPath = path.join(directory, "server.mjs");
  await fs.writeFile(serverPath, 'import { writeFileSync } from "node:fs";\n' + source.replace(
    'const args = request.params.arguments || {};',
    `writeFileSync(${JSON.stringify(marker)}, "performed"); return;\n const args = request.params.arguments || {};`,
  ));
  await saveGlobalSettings(directory, { integrationConnections: { action: "upsert", expectedRevision: "0",
    connection: { id: "stop-server", name: "Stop server", enabled: true,
      mcp: { type: "stdio", command: "node", args: [serverPath] }, secrets: {},
      artifactInputApproved: false, artifactOutputApproved: false },
  } });
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"), summary: "Track: Lead", target: {},
    scope: { kind: "track", identity: "track-one", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  await runAgentFlow({
    application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: directory },
    ui: { showModalDialog: async (url: string) => {
      const endpoint = (pathname: string) => { const target = new URL(url); target.pathname = pathname; return target; };
      const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
      const headers = { "Content-Type": "application/json", "X-Live-Smith-Command-Id": "panel-stop" };
      const catalog = await (await fetch(endpoint("/session-tools"), { method: "POST", headers,
        body: JSON.stringify({ kind: "load_session_tools", sessionId: initial.activeSessionId }) })).json() as ChatDialogState;
      const panel = catalog.sessionToolCatalog!.groups.find((group) => group.kind === "mcp")!.tools[0]!.panel!;
      const running = fetch(endpoint("/command"), { method: "POST", headers, body: JSON.stringify({
        kind: "run_plugin_tool", sessionId: initial.activeSessionId, toolName: panel.toolName,
        signature: panel.signature, arguments: { text: "start" },
      }) });
      let performed = false;
      for (let attempts = 0; attempts < 100; attempts++) {
        performed = await fs.access(marker).then(() => true, () => false);
        if (performed) break;
        await delay(10);
      }
      assert.equal(performed, true, "The server must have performed work before Stop.");
      assert.equal((await fetch(endpoint("/stop"), { method: "POST", headers, body: "{}" })).status, 200);
      const response = await running;
      const outcome = await response.json() as { commandOutcome: string; state?: ChatDialogState; error: string };
      assert.equal(outcome.commandOutcome, "unknown");
      assert.match(outcome.error, /confirmed result/);
      assert.equal(outcome.state?.events.at(-1)?.kind, "tool_result");
      assert.match(outcome.state?.events.at(-1)?.content ?? "", /confirmed result/);
      assert.equal(await fs.readFile(marker, "utf8"), "performed");
    } },
  } as never, interaction, { renderHtml: () => "<html></html>" });
});
