import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate/browser";

import { createRequestPluginTools } from "../../../src/app/plugins/request-plugin-tools.js";
import { LIVE_SMITH_ARTIFACT_META_KEY } from "../../../src/plugins/artifacts.js";
import { listPluginAudioArtifacts, readExpectedSessionAudioArtifact, type PluginAudioArtifact } from "../../../src/storage/audio-artifacts.js";
import { installPlugin, setPluginArtifactPermissionApproved, setPluginEnabled, setPluginMcpServerApproved } from "../../../src/storage/plugins.js";
import { audioStorageHarness, generationJobCases, waveBytes } from "../../storage/support/audio-storage-test-helpers.js";

const server = String.raw`
import fs from "node:fs/promises";
import readline from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", async (line) => {
  const request = JSON.parse(line);
  if (request.method === "server/discover") send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "legacy" } });
  else if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: {
    protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "audio-renderer", version: "1" }
  } });
  else if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools: [{
    name: "render", description: "Process an audio artifact",
    inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"], additionalProperties: false },
    _meta: { "${LIVE_SMITH_ARTIFACT_META_KEY}": { version: 1, inputs: [{ argument: "source", kind: "audio" }],
      outputs: [{ argument: "destination", kind: "audio", format: "wav", label: "Processed take" }] } }
  }] } });
  else if (request.method === "tools/call") {
    const bytes = await fs.readFile(request.params.arguments.source);
    await fs.writeFile(request.params.arguments.destination, bytes);
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "Processed " + bytes.byteLength + " bytes" }] } });
  }
});
`;

test("installed local audio outputs require independent grants and are reusable in the same request", async (t) => {
  const h = await audioStorageHarness(t, generationJobCases[0]!.input);
  const source = await h.saveResult("music");
  const plugin = await installPlugin(h.storage, zipSync({
    "plugin.json": strToU8(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "audio-renderer" })),
    "mcp.json": strToU8(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { local: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.mjs"] } } })),
    "server.mjs": strToU8(server),
  }));
  await setPluginMcpServerApproved(h.storage, plugin.id, "local", true);
  await setPluginEnabled(h.storage, plugin.id, true);
  for (const [input, output] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    await setPluginArtifactPermissionApproved(h.storage, plugin.id, "local", "input", input);
    await setPluginArtifactPermissionApproved(h.storage, plugin.id, "local", "output", output);
    const registered: PluginAudioArtifact[] = [];
    const request = await createRequestPluginTools({ storageDirectory: h.storage, temporaryDirectory: h.storage,
      sessionId: h.session.id, signal: h.signal, artifactRevisionOf: { kind: "audio", id: source.id },
      withAuthorization: async (_signal, operation) => operation(),
      async onAudioArtifacts(artifacts) {
        for (const artifact of artifacts) {
          assert.deepEqual(await readExpectedSessionAudioArtifact(h.storage, h.session.id, artifact, h.signal), waveBytes());
          registered.push(artifact);
        }
      },
    });
    try {
      if (!input || !output) {
        assert.deepEqual(request.tools(), []);
        assert.equal(request.hasAudioOutputs, false);
        assert.equal(request.issues[0]?.code, "artifact_permission_required");
        continue;
      }
      assert.deepEqual(request.issues, []);
      assert.equal(request.hasAudioOutputs, true);
      const tool = request.tools()[0]!;
      assert.doesNotMatch(JSON.stringify(tool.function.parameters), /destination/);
      for (let index = 0; index < 2; index++) {
        const result = await request.callTool({ id: `render-${index}`, name: tool.function.name,
          arguments: JSON.stringify({ source: index === 0 ? source.id : registered[0]!.id }) });
        assert.equal(result.failed, undefined);
        assert.equal(registered.length, index + 1, "the async callback completed before the tool result");
        assert.equal(result.content.includes(h.storage), false);
        const meta = JSON.parse(result.content).artifacts[0];
        assert.equal(meta.kind, "audio"); assert.equal(meta.artifactRef, registered[index]!.id);
        assert.equal(meta.mediaType, "audio/wav"); assert.equal(meta.durationSeconds, 1);
        assert.deepEqual(meta.version, { groupId: source.version!.groupId, number: index + 2, derivedFromId: source.id });
      }
      assert.deepEqual(request.midiArtifacts(), []);
    } finally { await request.close(); }
  }
  assert.equal((await listPluginAudioArtifacts(h.storage, h.session.id)).length, 2);
});
