import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import { strToU8, zipSync } from "fflate/browser";
import { PLUGIN_CONFIG_NAMESPACE } from "../../../src/plugins/user-config.js";
import { installPlugin, setPluginEnabled, setPluginMcpServerApproved, preparePluginRuntime, readPluginConfig, savePluginConfigInTransaction } from "../../../src/storage/plugins.js";
import { createSession } from "../../../src/storage/sessions.js";
import { saveGlobalSettings, loadAgentSettings } from "../../../src/storage/settings.js";
import { withStorageTransaction } from "../../../src/storage/persistence.js";
import { readMcpOAuthCredentialInTransaction } from "../../../src/storage/mcp-oauth.js";
import { signInMcpOAuth, signOutMcpOAuth, createMcpOAuthAuthProvider, mcpOAuthStates } from "../../../src/app/plugins/mcp-oauth.js";
import { createRequestPluginTools } from "../../../src/app/plugins/request-plugin-tools.js";
import { oauthServer } from "./support/mcp-oauth-server.js";

test("named package OAuth replaces anonymous discovery and unrelated Plugin preferences retain credentials", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugin-oauth-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const server = await oauthServer(t);
  const plugin = await installPlugin(directory, zipSync({
    "plugin.json": strToU8(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "oauth-fixture",
      extensions: { [PLUGIN_CONFIG_NAMESPACE]: { userConfig: {
        style: { type: "string", title: "Style", description: "Creative style", default: "ambient" },
        tenant: { type: "string", title: "Workspace", description: "Resource workspace", default: "first" },
      } } } })),
    "mcp.json": strToU8(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { remote: { type: "streamable-http", url: server.origin + "/mcp?root=${PLUGIN_ROOT}&data=${PLUGIN_DATA}", oauth: {}, headers: { "X-Tenant": "${user_config.tenant}" } } } })),
  }));
  await setPluginEnabled(directory, plugin.id, true);
  await setPluginMcpServerApproved(directory, plugin.id, "remote", true);
  const unboundSession = await createSession(directory, { title: "Unbound", projectKey: "project", scope: { kind: "track", identity: "track", label: "Bass" } });
  const unbound = await createRequestPluginTools({ storageDirectory: directory, sessionId: unboundSession.id, signal: new AbortController().signal });
  assert.equal(server.requests.length, 0, "a declared OAuth server must not be discovered anonymously");
  assert.ok(unbound.issues.some((issue) => issue.serverId === "remote" && issue.code === "invalid_configuration"));
  await unbound.close();
  await saveGlobalSettings(directory, { integrationConnections: { action: "upsert", expectedRevision: "0", connection: {
    id: "plugin-account", name: "Plugin account", enabled: true, pluginId: plugin.id,
    configuration: { serverId: "remote", pluginDigest: plugin.sha256 }, oauth: {},
  } } });
  const signal = new AbortController().signal;
  const session = await createSession(directory, { title: "OAuth", projectKey: "project", scope: { kind: "track", identity: "track", label: "Bass" } });
  const before = await createRequestPluginTools({ storageDirectory: directory, sessionId: session.id, signal });
  assert.ok(before.issues.some((issue) => issue.connectionId === "plugin-account" && issue.code === "authorization_required"));
  assert.equal(server.requests.length, 0);
  await before.close();
  await signInMcpOAuth({ storageDirectory: directory, connectionId: "plugin-account", signal, openBrowser: (url) => server.authorize(url) });
  const paths = await preparePluginRuntime(directory, plugin.id);
  const challenge = server.requests.find((entry) => entry.path === "/mcp")!;
  assert.equal(new URL(challenge.url, server.origin).searchParams.get("root"), paths.pluginRoot);
  assert.equal(new URL(challenge.url, server.origin).searchParams.get("data"), paths.pluginData);
  const provider = createMcpOAuthAuthProvider(directory, "plugin-account", signal);
  const token = await provider.token();
  const request = await createRequestPluginTools({ storageDirectory: directory, sessionId: session.id, signal });
  assert.equal(request.issues.length, 0);
  assert.ok(server.requests.filter((entry) => entry.path === "/mcp").every((entry) => new URL(entry.url, server.origin).searchParams.get("root") === paths.pluginRoot));
  assert.equal(request.toolsets.flatMap((toolset) => toolset.tools()).filter((tool) => tool.function.name.includes("echo")).length, 1);
  assert.ok(request.catalogTools().some((tool) => tool.connectionId === "plugin-account"));
  const originalSignature = request.catalogTools().find((tool) => tool.connectionId === "plugin-account")!.panel!.signature;
  await request.close();
  await signOutMcpOAuth(directory, "plugin-account");
  await signInMcpOAuth({ storageDirectory: directory, connectionId: "plugin-account", signal, openBrowser: (url) => server.authorize(url) });
  const relogged = await createRequestPluginTools({ storageDirectory: directory, sessionId: session.id, signal });
  assert.notEqual(relogged.catalogTools().find((tool) => tool.connectionId === "plugin-account")!.panel!.signature, originalSignature);
  await relogged.close();
  const currentProvider = createMcpOAuthAuthProvider(directory, "plugin-account", signal);
  const currentToken = await currentProvider.token();
  await assert.rejects(provider.token(), /changed/u);
  assert.notEqual(currentToken, token);
  const update = async (values: Record<string, unknown>) => {
    const saved = await readPluginConfig(directory, plugin.id);
    await withStorageTransaction(directory, (transaction) => savePluginConfigInTransaction(transaction, directory, {
      pluginId: plugin.id, sha256: plugin.sha256, revision: saved.revision, values: { ...saved.values, ...values }, secretUpdates: {},
    }));
  };
  await update({ style: "jazz" });
  assert.equal(await currentProvider.token(), currentToken);
  assert.equal((await mcpOAuthStates(directory))[0]?.status, "signed-in");
  await update({ tenant: "second" });
  await update({ tenant: "first" });
  await assert.rejects(currentProvider.token(), /changed/u);
  assert.equal(await withStorageTransaction(directory, (transaction) => readMcpOAuthCredentialInTransaction(transaction, directory, "plugin-account")), undefined);
  const settings = await loadAgentSettings(directory);
  const connection = settings.integrationConnections!.connections[0]!;
  await saveGlobalSettings(directory, { integrationConnections: { action: "upsert", expectedRevision: settings.integrationConnections!.revision,
    connection: { ...connection, enabled: false } } });
  const count = server.requests.length;
  const disabled = await createRequestPluginTools({ storageDirectory: directory, sessionId: session.id, signal });
  assert.equal(server.requests.length, count);
  assert.equal(disabled.toolsets.flatMap((toolset) => toolset.tools()).some((tool) => tool.function.name.includes("echo")), false);
  await disabled.close();
});
