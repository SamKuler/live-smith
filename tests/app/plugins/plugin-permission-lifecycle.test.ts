import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { fstatSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { strToU8, zipSync } from "fflate/browser";
import { createRequestPluginTools } from "../../../src/app/plugins/request-plugin-tools.js";
import { createSession } from "../../../src/storage/sessions.js";
import { StorageCommitOutcomeUnknownError } from "../../../src/storage/persistence.js";
import { createPluginLifecycle } from "../../../src/app/plugins/plugin-lifecycle.js";
import { ChatBridgeConflictError, parseCommandInput } from "../../../src/app/chat/chat-bridge-http.js";
import { listInstalledPlugins } from "../../../src/storage/plugins.js";
import { createHostAbortController } from "../../../src/runtime/host.js";

function packageBytes(command: string): Uint8Array {
  return zipSync({
    "plugin.json": strToU8(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "race-plugin", version: "1.0.0", description: "Permission ownership fixture" })),
    "mcp.json": strToU8(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { server: { type: "stdio", command } } })),
  });
}

for (const permission of ["server", "input", "output"] as const) {
  test(`a held ${permission} grant rejects a replaced package before changing permission`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-permission-race-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const lifecycle = createPluginLifecycle({ storageDirectory: directory,
      withRequestConfiguration: async (_signal, action) => action(),
      notifyGlobalStateChanged() {}, notifySessionStateChanged() {} });
    const signal = createHostAbortController().signal;
    const reviewed = await lifecycle.install({ bytes: packageBytes("./reviewed"), replace: false }, signal);
    const next = await lifecycle.install({ bytes: packageBytes("./replacement"), replace: true }, signal);
    assert.notEqual(reviewed.sha256, next.sha256);
    const serverCommand = { kind: "set_plugin_mcp_server_approved" as const,
      pluginId: reviewed.id, sha256: next.sha256, serverId: "server", approved: true };
    if (permission !== "server") await lifecycle.change(serverCommand, signal);
    const command = permission === "server" ? { ...serverCommand, sha256: reviewed.sha256 }
      : { kind: "set_plugin_artifact_permission" as const, pluginId: reviewed.id,
        sha256: reviewed.sha256, serverId: "server", permission, approved: true };
    await assert.rejects(lifecycle.change(command, signal), ChatBridgeConflictError);
    const current = (await listInstalledPlugins(directory))[0]!;
    assert.equal(current.sha256, next.sha256);
    assert.deepEqual(current.approvedMcpServerIds, permission === "server" ? [] : ["server"]);
    assert.deepEqual(current.approvedArtifactInputServerIds, []);
    assert.deepEqual(current.approvedArtifactOutputServerIds, []);
    await lifecycle.change({ ...command, sha256: next.sha256 }, signal);
    const granted = (await listInstalledPlugins(directory))[0]!;
    assert.deepEqual(permission === "server" ? granted.approvedMcpServerIds
      : permission === "input" ? granted.approvedArtifactInputServerIds : granted.approvedArtifactOutputServerIds, ["server"]);
    await assert.rejects(lifecycle.change(command, signal), ChatBridgeConflictError);
    await lifecycle.change({ ...command, sha256: next.sha256, approved: false }, signal);
  });
}

test("permission commands require the reviewed digest and preserve it through parsing", () => {
  for (const fields of [
    { kind: "set_plugin_mcp_server_approved" },
    { kind: "set_plugin_artifact_permission", permission: "input" },
    { kind: "set_plugin_artifact_permission", permission: "output" },
  ]) {
    const command = { ...fields, pluginId: "race-plugin", serverId: "server", approved: true, sha256: "a".repeat(64) };
    assert.deepEqual(parseCommandInput(command), command);
    for (const digest of [undefined, "", "bad", "A".repeat(64)]) {
      assert.throws(() => parseCommandInput({ ...command, sha256: digest }));
    }
  }
});


async function runningReplacement(t: TestContext, permission: "server" | "input" | "output") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-stale-revoke-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lifecycle = createPluginLifecycle({ storageDirectory: directory,
    withRequestConfiguration: async (_signal, action) => action(),
    notifyGlobalStateChanged() {}, notifySessionStateChanged() {} });
  const signal = createHostAbortController().signal;
  const reviewed = await lifecycle.install({ bytes: packageBytes("./reviewed"), replace: false }, signal);
  const current = await lifecycle.install({ bytes: packageBytes("./replacement"), replace: true }, signal);
  const identity = { pluginId: current.id, sha256: current.sha256, serverId: "server" };
  await lifecycle.change({ kind: "set_plugin_mcp_server_approved", ...identity, approved: true }, signal);
  const revoke = permission === "server"
    ? { kind: "set_plugin_mcp_server_approved" as const, ...identity, approved: false }
    : { kind: "set_plugin_artifact_permission" as const, ...identity, permission, approved: false };
  if (permission !== "server") await lifecycle.change({ ...revoke, approved: true }, signal);
  await lifecycle.change({ kind: "set_plugin_enabled", pluginId: current.id, enabled: true }, signal);
  const session = await createSession(directory, { title: "Permission fixture", projectKey: "fixture",
    scope: { kind: "track", identity: "fixture", label: "Fixture" } });
  let closed = 0;
  const request = await createRequestPluginTools({ storageDirectory: directory, sessionId: session.id, signal,
    createPackage: (runtime) => ({ manifest: runtime.archive.manifest,
      tools: async () => ({ tools: [], issues: [] }), callTool: async () => ({ content: [] }),
      close: async () => { closed += 1; } }) });
  t.after(() => request.close());
  return { directory, lifecycle, signal, reviewed, revoke, get closed() { return closed; } };
}

for (const permission of ["server", "input", "output"] as const) {
  test(`a stale ${permission} revocation leaves replacement connections open until an admitted revocation`, async (t) => {
    const h = await runningReplacement(t, permission);
    await assert.rejects(h.lifecycle.change({ ...h.revoke, sha256: h.reviewed.sha256 }, h.signal), ChatBridgeConflictError);
    assert.equal(h.closed, 0);
    const current = (await listInstalledPlugins(h.directory))[0]!;
    assert.deepEqual(permission === "server" ? current.approvedMcpServerIds
      : permission === "input" ? current.approvedArtifactInputServerIds : current.approvedArtifactOutputServerIds, ["server"]);
    await h.lifecycle.change(h.revoke, h.signal);
    assert.equal(h.closed, 1);
    const revoked = (await listInstalledPlugins(h.directory))[0]!;
    assert.deepEqual(permission === "server" ? revoked.approvedMcpServerIds
      : permission === "input" ? revoked.approvedArtifactInputServerIds : revoked.approvedArtifactOutputServerIds, []);
  });
}

test("an admitted revocation closes its connections even when the catalog commit outcome is unknown", async (t) => {
  const h = await runningReplacement(t, "server");
  const handle = await fs.open(path.join(h.directory, "live-smith-plugins"), "r");
  const identity = await handle.stat();
  const prototype = Object.getPrototypeOf(handle) as fs.FileHandle;
  const sync = prototype.sync;
  await handle.close();
  let injected = false;
  t.mock.method(prototype, "sync", async function (this: fs.FileHandle) {
    const current = fstatSync(this.fd);
    if (!injected && current.dev === identity.dev && current.ino === identity.ino) {
      injected = true;
      throw new Error("Injected catalog durability failure.");
    }
    return sync.call(this);
  });
  await assert.rejects(h.lifecycle.change(h.revoke, h.signal), StorageCommitOutcomeUnknownError);
  assert.equal(injected, true);
  assert.equal(h.closed, 1);
  assert.deepEqual((await listInstalledPlugins(h.directory))[0]!.approvedMcpServerIds, []);
});
