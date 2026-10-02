import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder } from "node:util";
import { zipSync } from "fflate/browser";
import { buildPluginAppExample } from "../../../scripts/build-plugin-app-example.js";
import { createRequestPluginTools, type RequestPluginTools } from "../../../src/app/plugins/request-plugin-tools.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { installPlugin, savePluginConfigInTransaction, setPluginEnabled, setPluginMcpServerApproved, setPluginArtifactPermissionApproved } from "../../../src/storage/plugins.js";
import { withStorageTransaction } from "../../../src/storage/persistence.js";
import { createSession } from "../../../src/storage/sessions.js";
import { openPluginArchive } from "../../../src/plugins/archive.js";
import { appResourceDocument } from "../../../src/plugins/mcp/apps.js";

const bytes = await buildPluginAppExample();
const decoder = new TextDecoder();

test("MCP Apps demo packages a self-contained SDK view with matching portable and native configuration", async () => {
  const archive = await openPluginArchive(bytes);
  assert.equal(archive.manifest.id, "fixture.mcp-app");
  assert.equal(archive.manifest.sourceFormat, "agent-plugins-1.0");
  assert.deepEqual(archive.manifest.unsupportedComponents ?? [], []);
  assert.deepEqual(archive.manifest.userConfig?.map((field) => [field.name, field.default]), [["default_bars", 4], ["style", "ambient"]]);
  assert.equal(archive.files.has("app.ts"), false);
  assert.equal(archive.files.has("THIRD_PARTY_NOTICES.md"), true);
  const html = decoder.decode(archive.files.get("app.html"));
  assert.match(html, /<title>Pattern lab<\/title>/u);
  assert.doesNotMatch(html, /__MCP_APP_SCRIPT__|<script[^>]+src=|<link[^>]+href=/u);
  for (const [sourceFormat, omit] of [
    ["codex", ["plugin.json"]], ["claude", ["plugin.json", ".codex-plugin/plugin.json"]],
  ] as const) {
    const overlay = await openPluginArchive(zipSync(Object.fromEntries([...archive.files].filter(([name]) => !omit.includes(name as never)))));
    assert.equal(overlay.manifest.sourceFormat, sourceFormat);
    assert.deepEqual(overlay.manifest.userConfig, archive.manifest.userConfig);
  }
});

test("real stdio App preserves saved defaults and call state while hiding App tools and blocking other servers", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-app-fixture-");
  let request: RequestPluginTools | undefined;
  t.after(async () => { await request?.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const plugin = await installPlugin(directory, bytes);
  await withStorageTransaction(directory, (transaction) => savePluginConfigInTransaction(transaction, directory, {
    pluginId: plugin.id, sha256: plugin.sha256, revision: "0", values: { style: "jazz", default_bars: 6 }, secretUpdates: {},
  }));
  await setPluginMcpServerApproved(directory, plugin.id, "fixture", true);
  await setPluginEnabled(directory, plugin.id, true);
  await setPluginArtifactPermissionApproved(directory, plugin.id, "fixture", "output", true);
  const otherRoot = fileURLToPath(new URL("../../../test-fixtures/plugins/portable-skill-mcp/", import.meta.url));
  const otherBytes = zipSync(Object.fromEntries(await Promise.all(["plugin.json", "mcp.json", "server.mjs"].map(async (name) =>
    [name, await fs.readFile(path.join(otherRoot, name))] as const))));
  const other = await installPlugin(directory, otherBytes);
  await setPluginMcpServerApproved(directory, other.id, "fixture", true);
  await setPluginEnabled(directory, other.id, true);
  const session = await createSession(directory, { title: "Pattern lab", projectKey: "app-fixture", scope: {
    kind: "selection", identity: "app-fixture", label: "Pattern lab",
  } });
  const signal = createHostAbortController().signal;
  request = await createRequestPluginTools({ storageDirectory: directory, sessionId: session.id, signal,
    withAuthorization: async (_signal, operation) => operation() });
  assert.deepEqual(request.issues, []);
  const catalog = request.catalogTools();
  const source = catalog.find((entry) => entry.pluginId === plugin.id && entry.name === "pattern_lab")!;
  assert.ok(source.app);
  assert.ok(source.panel);
  assert.equal(source.app.resourceUri, "ui://pattern-lab/app.html");
  assert.match(source.app.signature, /^[a-f0-9]{64}$/u);
  assert.equal(catalog.some((entry) => entry.name === "get_settings"), false);
  assert.equal(request.tools().length, 4);
  assert.ok(request.tools().some((entry) => entry.function.name === "list_session_artifacts"));
  assert.ok(request.tools().some((entry) => entry.function.name === "inspect_midi_artifact"));
  assert.equal(request.tools().some((entry) => entry.function.description.includes("current server call count")), false);
  const owner = source.app.toolName;
  const document = appResourceDocument(await request.readAppResource(owner, source.app.resourceUri, signal), source.app.resourceUri);
  assert.match(document.html, /MCP Apps demo/u);
  assert.doesNotMatch(document.html, /__MCP_APP_SCRIPT__/u);
  const settings = await request.callAppTool(owner, "get_settings", {}, signal);
  assert.deepEqual(settings.result.structuredContent, { kind: "settings", defaultStyle: "jazz", defaultBars: 6, callCount: 1, generatedCount: 0 });
  const args = { prompt: "A repeated brass motif", bars: 3 };
  const generated = await request.callAppTool(owner, "pattern_lab", args, signal);
  const pattern = generated.result.structuredContent as { style: string; bars: number; notes: unknown[]; callCount: number; generatedCount: number };
  assert.equal(pattern.style, "jazz");
  assert.equal(pattern.bars, 3);
  assert.equal(pattern.notes.length, 24);
  assert.equal(pattern.callCount, 2);
  assert.equal(pattern.generatedCount, 1);
  const repeated = await request.callAppTool(owner, "pattern_lab", args, signal);
  assert.deepEqual((repeated.result.structuredContent as typeof pattern).notes, pattern.notes);
  assert.equal((repeated.result.structuredContent as typeof pattern).callCount, 3);
  const refreshed = await request.callAppTool(owner, "get_settings", {}, signal);
  assert.deepEqual(refreshed.result.structuredContent, { kind: "settings", defaultStyle: "jazz", defaultBars: 6, callCount: 4, generatedCount: 2 });
  await assert.rejects(request.callAppTool(owner, "echo", { text: "other server" }, signal), /not available/u);
  await assert.rejects(request.readAppResource(owner, "ui://other-server/app.html", signal));
  const hidden = request.appTool(owner, "get_settings");
  assert.throws(() => request!.callTool({ id: "hidden", name: hidden.tool.function.name, arguments: "{}" }), /not registered/u);
  const stillCurrent = await request.callAppTool(owner, "get_settings", {}, signal);
  assert.equal((stillCurrent.result.structuredContent as { callCount: number }).callCount, 5);
});
