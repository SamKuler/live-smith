import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";

import type { Tool } from "@modelcontextprotocol/client";

import { LIVE_SMITH_ARTIFACT_META_KEY } from "../plugins/artifacts.js";
import { createStandaloneMcpConnection } from "../plugins/mcp/package.js";
import type { StandaloneMcpConnection } from "../plugins/integration-connections.js";
import { audioStorageHarness, waveBytes } from "../storage/audio-storage-test-helpers.js";
import { listMidiArtifacts, readMidiArtifact } from "../storage/midi-artifacts.js";
import { saveGlobalSettings } from "../storage/settings.js";
import { createRequestPluginTools } from "./request-plugin-tools.js";

const artifactTool: Tool = {
  name: "transcribe", description: "Transcribe Session audio",
  inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } },
    required: ["source", "destination"], additionalProperties: false },
  _meta: { [LIVE_SMITH_ARTIFACT_META_KEY]: {
    version: 1, inputs: [{ argument: "source", kind: "audio" }],
    outputs: [{ argument: "destination", kind: "midi", label: "Standalone MIDI" }],
  } },
};
const midi = new Uint8Array([77,84,104,100,0,0,0,6,0,0,0,1,1,224,77,84,114,107,
  0,0,0,13,0,144,60,100,131,96,128,60,64,0,255,47,0]);

function connection(input: boolean, output: boolean): StandaloneMcpConnection {
  return { id: "transcription", name: "Transcription", enabled: true,
    mcp: { type: "stdio", command: "synthetic-server", args: [] }, secrets: {},
    artifactInputApproved: input, artifactOutputApproved: output };
}

test("standalone artifacts require independent grants and preserve only Connection provenance", async (t) => {
  for (const [input, output] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    await t.test(`input=${input}, output=${output}`, async (t) => {
      const h = await audioStorageHarness(t);
      const source = await h.save();
      await saveGlobalSettings(h.storage, { integrationConnections: { action: "upsert", expectedRevision: "0",
        connection: connection(input, output) } });
      let calls = 0;
      let stagedInput = "";
      const request = await createRequestPluginTools({ storageDirectory: h.storage, sessionId: h.session.id,
        signal: h.signal, withAuthorization: async (_signal, operation) => operation(),
        createStandaloneConnection: (saved) => createStandaloneMcpConnection(saved, { connector: async () => ({
          listTools: async () => [artifactTool],
          callTool: async (_name, argumentsValue) => {
            calls++;
            const args = argumentsValue as Record<string, string>;
            stagedInput = args.source!;
            assert.deepEqual(new Uint8Array(await fs.readFile(stagedInput)), waveBytes());
            assert.equal((await fs.stat(stagedInput)).mode & 0o777, 0o400);
            await fs.writeFile(args.destination!, midi);
            return { content: [{ type: "text", text: "Transcribed" }] };
          }, close: async () => undefined,
        }) }),
      });
      t.after(() => request.close());
      if (!input || !output) {
        assert.deepEqual(request.tools().map((entry) => entry.function.name), ["list_session_artifacts"]);
        assert.deepEqual(request.catalogTools(), []);
        assert.deepEqual(request.issues, [{ connectionId: "transcription", serverId: "server",
          code: "artifact_permission_required", message: "MCP artifact tool requires separate input or output approval." }]);
        assert.equal(calls, 0);
        return;
      }
      assert.deepEqual(request.issues, []);
      const tool = request.tools().find((entry) => entry.function.name.startsWith("mcp_"))!;
      assert.doesNotMatch(JSON.stringify(tool.function.parameters), /destination/u);
      const result = await request.callTool({ id: "transcribe", name: tool.function.name,
        arguments: JSON.stringify({ source: source.id }) });
      assert.equal(result.failed, undefined);
      assert.equal(calls, 1);
      assert.equal(result.content.includes(h.storage), false);
      assert.equal(result.content.includes(stagedInput), false);
      await assert.rejects(fs.stat(stagedInput), { code: "ENOENT" });
      const artifacts = await listMidiArtifacts(h.storage, h.session.id);
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0]!.connectionId, "transcription");
      assert.equal(Object.hasOwn(artifacts[0]!, "pluginId"), false);
      const read = await readMidiArtifact(h.storage, h.session.id, artifacts[0]!.id, h.signal);
      assert.deepEqual(read.bytes, midi);
      assert.deepEqual(read.parsed.notes, [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }]);
      assert.equal(JSON.parse(result.content).artifacts[0].artifactRef, artifacts[0]!.id);
    });
  }
});

test("standalone HTTP tool metadata cannot opt into the local artifact bridge", async (t) => {
  const h = await audioStorageHarness(t);
  await saveGlobalSettings(h.storage, { integrationConnections: { action: "upsert", expectedRevision: "0",
    connection: { ...connection(false, false), mcp: { type: "streamable-http", url: "https://mcp.example.test/mcp" } } } });
  let calls = 0;
  const request = await createRequestPluginTools({ storageDirectory: h.storage, sessionId: h.session.id,
    signal: h.signal, withAuthorization: async (_signal, operation) => operation(),
    createStandaloneConnection: (saved) => createStandaloneMcpConnection(saved, { connector: async () => ({
      listTools: async () => [artifactTool], callTool: async () => { calls++; return { content: [] }; },
      close: async () => undefined,
    }) }),
  });
  t.after(() => request.close());
  assert.deepEqual(request.tools(), []);
  assert.deepEqual(request.issues.map(({ connectionId, code }) => ({ connectionId, code })),
    [{ connectionId: "transcription", code: "invalid_tool" }]);
  assert.equal(calls, 0);
});
