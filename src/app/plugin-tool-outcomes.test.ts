import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { URL } from "node:url";
import { createHostAbortController } from "../runtime/host.js";
import { createSession } from "../storage/sessions.js";
import { loadSessionEvents } from "../storage/events.js";
import { saveGlobalSettings } from "../storage/settings.js";
import { createRequestPluginTools } from "./request-plugin-tools.js";
import { runPluginParameterTool } from "./plugin-parameter-tool.js";
import { ChatBridgeCommandOutcomeUnknownError } from "./chat-bridge.js";

const authorize = async <T>(_signal: AbortSignal, operation: () => Promise<T>): Promise<T> => operation();

test("MCP transport loss after dispatch is uncertain; confirmed errors and admission rejection remain distinct", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-tool-outcomes-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "performed-work");
  const serverPath = path.join(directory, "server.mjs");
  const fixture = await fs.readFile(new URL("../../test-fixtures/plugins/portable-skill-mcp/server.mjs", import.meta.url), "utf8");
  await fs.writeFile(serverPath, 'import { writeFileSync } from "node:fs";\n' + fixture.replace(
    "const args = request.params.arguments || {};",
    `const args = request.params.arguments || {};
    if (args.text === "disconnect") {
      writeFileSync(${JSON.stringify(marker)}, "performed");
      process.exit(0);
    }
    if (args.text === "error") {
      send({ jsonrpc: "2.0", id: request.id, result: {
        content: [{ type: "text", text: "Input was rejected by the server." }], isError: true
      } });
      return;
    }`,
  ));
  const connection = { id: "outcome-server", name: "Outcome server", enabled: true,
    mcp: { type: "stdio" as const, command: "node", args: [serverPath] }, secrets: {},
    artifactInputApproved: false, artifactOutputApproved: false };
  await saveGlobalSettings(directory, { integrationConnections: { action: "upsert", expectedRevision: "0", connection } });
  const session = await createSession(directory, { title: "Outcomes", projectKey: "project", scope: {
    kind: "track", identity: "track", label: "Lead",
  } });
  const input = { storageDirectory: directory, sessionId: session.id, signal: createHostAbortController().signal };
  const discovery = await createRequestPluginTools({ ...input, withAuthorization: authorize });
  const panel = discovery.catalogTools()[0]!.panel!;
  await discovery.close();
  const run = { ...input, toolName: panel.toolName, signature: panel.signature, withPluginAuthorization: authorize };

  assert.deepEqual(await runPluginParameterTool({ ...run, arguments: { text: "error" } }), { failed: true });
  let events = await loadSessionEvents(directory, session.id);
  assert.equal(JSON.parse(events.at(-1)!.content).isError, true);
  await assert.rejects(fs.access(marker), /ENOENT/);

  await assert.rejects(runPluginParameterTool({ ...run, arguments: { text: "disconnect" } }),
    ChatBridgeCommandOutcomeUnknownError);
  assert.equal(await fs.readFile(marker, "utf8"), "performed");
  events = await loadSessionEvents(directory, session.id);
  assert.equal(events.at(-1)!.kind, "tool_result");
  assert.match(events.at(-1)!.content, /did not return a confirmed result/);
  await fs.unlink(marker);

  let admissions = 0;
  const revokeBeforeExecution = async <T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> => {
    if (++admissions === 2) await saveGlobalSettings(directory, { integrationConnections: {
      action: "upsert", expectedRevision: "1", connection: { ...connection, enabled: false },
    } });
    return authorize(signal, operation);
  };
  assert.deepEqual(await runPluginParameterTool({ ...run, arguments: { text: "disconnect" },
    withPluginAuthorization: revokeBeforeExecution }), { failed: true });
  await assert.rejects(fs.access(marker), /ENOENT/);
  events = await loadSessionEvents(directory, session.id);
  assert.match(events.at(-1)!.content, /could not start/);
});
