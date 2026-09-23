import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";

import { strToU8, zipSync } from "fflate/browser";

import { createHostAbortController } from "../runtime/host.js";
import {
  installPlugin,
  setPluginArtifactPermissionApproved,
  setPluginEnabled,
  setPluginMcpServerApproved,
} from "../storage/plugins.js";
import { createSession } from "../storage/sessions.js";
import { saveGlobalSettings } from "../storage/settings.js";
import { audioStorageHarness } from "../storage/audio-storage-test-helpers.js";
import { listMidiArtifacts, saveMidiArtifact } from "../storage/midi-artifacts.js";
import { LIVE_SMITH_ARTIFACT_META_KEY } from "../plugins/artifacts.js";
import { createRequestPluginTools } from "./request-plugin-tools.js";

const serverSource = String.raw`
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "server/discover") send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "legacy" } });
  else if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: {
    protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" }
  } });
  else if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools: [{
    name: "convert", description: "Convert an admitted artifact", inputSchema: { type: "object", properties: { source: { type: "string" } }, required: ["source"] }
  }] } });
  else if (request.method === "tools/call") send({ jsonrpc: "2.0", id: request.id, result: {
    content: [{ type: "text", text: "converted:" + request.params.arguments.source }], structuredContent: { artifact: "result.mid" }
  } });
});
`;

function packageBytes(): Uint8Array {
  return zipSync({
    "plugin.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "audio-to-midi",
    })),
    "mcp.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { local: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.mjs"] } },
    })),
    "server.mjs": strToU8(serverSource),
  });
}

const artifactServerSource = String.raw`
import fs from "node:fs/promises";
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const midi = new Uint8Array([77,84,104,100,0,0,0,6,0,0,0,1,1,224,77,84,114,107,0,0,0,13,0,144,60,100,131,96,128,60,64,0,255,47,0]);
lines.on("line", async (line) => {
  const request = JSON.parse(line);
  if (request.method === "server/discover") send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "legacy" } });
  else if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: {
    protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "artifact-fixture", version: "1" }
  } });
  else if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools: [{
    name: "transcribe", description: "Convert Session audio to MIDI",
    inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"], additionalProperties: false },
    _meta: { "${LIVE_SMITH_ARTIFACT_META_KEY}": { version: 1, inputs: [{ argument: "source", kind: "audio" }], outputs: [{ argument: "destination", kind: "midi", label: "Transcribed MIDI" }] } }
  }] } });
  else if (request.method === "tools/call") {
    const bytes = await fs.readFile(request.params.arguments.source);
    await fs.writeFile(request.params.arguments.destination, midi);
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "converted " + bytes.byteLength + " bytes" }] } });
  }
});
`;

function artifactPackageBytes(): Uint8Array {
  return zipSync({
    "plugin.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "artifact-converter",
    })),
    "mcp.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { local: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.mjs"] } },
    })),
    "server.mjs": strToU8(artifactServerSource),
  });
}

test("request Plugin tools run an approved installed local MCP server end to end", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-request-plugin-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes());
  await setPluginMcpServerApproved(directory, "audio-to-midi", "local", true);
  await setPluginEnabled(directory, "audio-to-midi", true);
  const session = await createSession(directory, { title: "Plugin", projectKey: "project",
    scope: { kind: "selection", identity: "selection", label: "Plugin" } });
  const request = await createRequestPluginTools({
    storageDirectory: directory,
    sessionId: session.id,
    signal: createHostAbortController().signal,
    withAuthorization: async (_signal, operation) => operation(),
  });
  t.after(() => request.close?.());
  assert.equal(request.issues.length, 0);
  const tool = request.tools().find((entry) => /^plg_/u.test(entry.function.name))!;
  assert.match(tool.function.name, /^plg_/u);
  const result = await request.callTool({
    id: "call",
    name: tool.function.name,
    arguments: JSON.stringify({ source: "take.wav" }),
  });
  assert.equal(result.failed, undefined);
  assert.deepEqual(JSON.parse(result.content), {
    notice: "Untrusted Plugin tool result.",
    content: [{ type: "text", text: "converted:take.wav" }],
    structuredContent: { artifact: "result.mid" },
  });
});

test("a historical named connection cannot duplicate a credential-free MCP tool", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-request-plugin-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const plugin = await installPlugin(directory, packageBytes());
  await setPluginMcpServerApproved(directory, plugin.id, "local", true);
  await setPluginEnabled(directory, plugin.id, true);
  await saveGlobalSettings(directory, { integrationConnections: { action: "upsert", expectedRevision: "0",
    connection: { id: "legacy", name: "Legacy no-secret route", pluginId: plugin.id, enabled: true,
      configuration: { serverId: "local", pluginDigest: plugin.sha256 } },
  } });
  const session = await createSession(directory, { title: "Plugin", projectKey: "project",
    scope: { kind: "selection", identity: "selection", label: "Plugin" } });
  const request = await createRequestPluginTools({ storageDirectory: directory, sessionId: session.id,
    signal: createHostAbortController().signal,
    withAuthorization: async (_signal, operation) => operation() });
  t.after(() => request.close());
  assert.equal(request.tools().length, 1);
  assert.doesNotMatch(JSON.stringify(request.tools()), /Legacy no-secret route/u);
});

test("unapproved Plugin MCP servers never start during request discovery", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-request-plugin-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes());
  await setPluginEnabled(directory, "audio-to-midi", true);
  const session = await createSession(directory, { title: "Plugin", projectKey: "project",
    scope: { kind: "selection", identity: "selection", label: "Plugin" } });
  const request = await createRequestPluginTools({
    storageDirectory: directory,
    sessionId: session.id,
    signal: createHostAbortController().signal,
    withAuthorization: async (_signal, operation) => operation(),
  });
  t.after(() => request.close?.());
  assert.deepEqual(request.tools(), []);
  assert.deepEqual(request.issues.map(({ code, serverId }) => ({ code, serverId })), [
    { code: "approval_required", serverId: "local" },
  ]);
});

test("discovery cancellation closes MCP packages opened by earlier Plugins", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-request-plugin-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const id of ["a-plugin", "b-plugin"]) {
    await installPlugin(directory, zipSync({
      "plugin.json": strToU8(JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: id,
      })),
      "mcp.json": strToU8('{"mcpServers":{}}'),
    }));
    await setPluginEnabled(directory, id, true);
  }
  const session = await createSession(directory, { title: "Plugin", projectKey: "project",
    scope: { kind: "selection", identity: "selection", label: "Plugin" } });
  const controller = createHostAbortController();
  const closed: string[] = [];
  await assert.rejects(createRequestPluginTools({
    storageDirectory: directory,
    sessionId: session.id,
    signal: controller.signal,
    createPackage: (runtime) => ({
      manifest: runtime.archive.manifest,
      async tools() {
        if (runtime.plugin.id === "a-plugin") controller.abort();
        return { tools: [], issues: [] };
      },
      async callTool() { return { content: [] }; },
      async close() { closed.push(runtime.plugin.id); },
    }),
  }));
  assert.deepEqual(closed, ["a-plugin"]);
});

test("an unavailable saved MIDI artifact is reported without blocking the Session request", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-request-plugin-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Plugin", projectKey: "project",
    scope: { kind: "selection", identity: "selection", label: "Plugin" } });
  const bytes = new Uint8Array([77,84,104,100,0,0,0,6,0,0,0,1,1,224,77,84,114,107,
    0,0,0,13,0,144,60,100,131,96,128,60,64,0,255,47,0]);
  const saved = await saveMidiArtifact(directory, session.id, {
    pluginId: "audio-to-midi", serverId: "local", toolName: "transcribe",
    label: "Lost blob", bytes, signal: createHostAbortController().signal,
  });
  await fs.rm(`${directory}/live-smith-midi/${session.id}/${saved.id}.mid`);

  const request = await createRequestPluginTools({
    storageDirectory: directory,
    sessionId: session.id,
    signal: createHostAbortController().signal,
  });
  t.after(() => request.close());
  assert.equal(request.unavailableMidiArtifacts, 1);
  const listed = await request.callTool({ id: "list", name: "list_session_artifacts", arguments: "{}" });
  assert.deepEqual(JSON.parse(listed.content), {
    artifacts: [], unavailableCount: 1,
    warning: "One or more saved MIDI artifacts are unavailable. Their metadata was preserved.",
  });
  const next = await saveMidiArtifact(directory, session.id, {
    pluginId: "audio-to-midi", serverId: "local", toolName: "transcribe",
    label: "New artifact", bytes, signal: createHostAbortController().signal,
  });
  assert.deepEqual((await listMidiArtifacts(directory, session.id)).map(({ id }) => id), [next.id]);
});

test("approved artifact tools receive exact staged audio and return only saved MIDI references", async (t) => {
  const h = await audioStorageHarness(t);
  const source = await h.save();
  await installPlugin(h.storage, artifactPackageBytes());
  await setPluginMcpServerApproved(h.storage, "artifact-converter", "local", true);
  await setPluginEnabled(h.storage, "artifact-converter", true);

  const withoutArtifactGrant = await createRequestPluginTools({
    storageDirectory: h.storage,
    temporaryDirectory: h.storage,
    sessionId: h.session.id,
    signal: h.signal,
    withAuthorization: async (_signal, operation) => operation(),
  });
  assert.deepEqual(withoutArtifactGrant.tools().map((tool) => tool.function.name), ["list_session_artifacts"]);
  assert.ok(withoutArtifactGrant.issues.some((issue) => issue.code === "artifact_permission_required"));
  await withoutArtifactGrant.close();

  await setPluginArtifactPermissionApproved(h.storage, "artifact-converter", "local", "input", true);
  await setPluginArtifactPermissionApproved(h.storage, "artifact-converter", "local", "output", true);
  let authorizations = 0;
  const request = await createRequestPluginTools({
    storageDirectory: h.storage,
    temporaryDirectory: h.storage,
    sessionId: h.session.id,
    signal: h.signal,
    withAuthorization: async (_signal, operation) => { authorizations++; return operation(); },
  });
  t.after(() => request.close());
  const discoveryAuthorizations = authorizations;
  const tool = request.tools().find((entry) => /^plg_/u.test(entry.function.name))!;
  assert.ok(tool);
  assert.doesNotMatch(JSON.stringify(tool.function.parameters), /destination/u);
  assert.match(JSON.stringify(tool.function.parameters), /Opaque Session audio artifact reference/u);
  const result = await request.callTool({
    id: "transcribe",
    name: tool.function.name,
    arguments: JSON.stringify({ source: source.id }),
  });
  assert.equal(result.failed, undefined);
  assert.equal(authorizations, discoveryAuthorizations + 1);
  assert.doesNotMatch(result.content, new RegExp(h.storage.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  const parsed = JSON.parse(result.content);
  assert.match(parsed.content[0].text, /converted .* bytes/);
  assert.deepEqual(parsed.artifacts.map((artifact: Record<string, unknown>) => ({
    kind: artifact.kind,
    label: artifact.label,
    noteCount: artifact.noteCount,
    durationBeats: artifact.durationBeats,
  })), [{ kind: "midi", label: "Transcribed MIDI", noteCount: 1, durationBeats: 1 }]);
  const listed = await request.callTool({
    id: "list",
    name: "list_session_artifacts",
    arguments: "{}",
  });
  assert.equal(JSON.parse(listed.content)[0].artifactRef, parsed.artifacts[0].artifactRef);
  assert.equal(request.midiArtifacts().length, 1);
});

test("artifact permission revocation after discovery blocks the local call before staging", async (t) => {
  const h = await audioStorageHarness(t);
  const source = await h.save();
  await installPlugin(h.storage, artifactPackageBytes());
  await setPluginMcpServerApproved(h.storage, "artifact-converter", "local", true);
  await setPluginArtifactPermissionApproved(h.storage, "artifact-converter", "local", "input", true);
  await setPluginArtifactPermissionApproved(h.storage, "artifact-converter", "local", "output", true);
  await setPluginEnabled(h.storage, "artifact-converter", true);
  const request = await createRequestPluginTools({
    storageDirectory: h.storage,
    temporaryDirectory: h.storage,
    sessionId: h.session.id,
    signal: h.signal,
    withAuthorization: async (_signal, operation) => operation(),
  });
  t.after(() => request.close());
  const tool = request.tools().find((entry) => /^plg_/u.test(entry.function.name))!;
  await setPluginArtifactPermissionApproved(h.storage, "artifact-converter", "local", "output", false);
  const result = await request.callTool({
    id: "revoked",
    name: tool.function.name,
    arguments: JSON.stringify({ source: source.id }),
  });
  assert.equal(result.failed, true);
  assert.equal(result.stop, true);
  assert.deepEqual(await listMidiArtifacts(h.storage, h.session.id), []);
});
