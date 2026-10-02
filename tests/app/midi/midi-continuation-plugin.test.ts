import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/client";
import { writeStandardMidi } from "../../../src/attachments/midi-writer.js";
import { LIVE_SMITH_ARTIFACT_META_KEY } from "../../../src/plugins/artifacts.js";
import { createStandaloneMcpConnection } from "../../../src/plugins/mcp/package.js";
import type { StandaloneMcpConnection } from "../../../src/plugins/integration-connections.js";
import { createRequestPluginTools } from "../../../src/app/plugins/request-plugin-tools.js";
import { generateMidiContinuationWithPlugin, midiContinuationGenerators } from "../../../src/app/midi/midi-continuation-generators.js";
import { assertMidiContinuationOutput, assertMidiContinuationSource, fillMidiContinuation } from "../../../src/app/midi/midi-continuation.js";
import { loadAgentSettings, saveGlobalSettings } from "../../../src/storage/settings.js";
import { listMidiArtifacts, parseMidiArtifact, readMidiArtifact, readMidiContinuation, saveMidiContinuation } from "../../../src/storage/midi-artifacts.js";
import { continuationHarness } from "./support/continuation-harness.js";

const tool: Tool = {
  name: "continue_midi", description: "Continue a multitrack MIDI conditioning file",
  inputSchema: { type: "object", properties: {
    source: { type: "string" }, destination: { type: "string" }, beats: { type: "integer", minimum: 1, maximum: 256 },
    style: { type: "string" },
  }, required: ["source", "destination", "beats"], additionalProperties: false },
  _meta: { [LIVE_SMITH_ARTIFACT_META_KEY]: { version: 1, inputs: [{ argument: "source", kind: "midi" }],
    outputs: [{ argument: "destination", kind: "midi", label: "Next section" }], continuation: { lengthArgument: "beats" } } },
};
const connection: StandaloneMcpConnection = { id: "midi-generator", name: "MIDI generator", enabled: true,
  mcp: { type: "stdio", command: "synthetic-midi-server", args: [] }, secrets: {}, artifactInputApproved: true, artifactOutputApproved: true };
const output = (pitch: number) => writeStandardMidi({ durationBeats: 8, tracks: [
  { name: "Bass", channel: 1, notes: [{ pitch, startTime: 0, duration: 4, velocity: 90 }] },
  { name: "Lead", channel: 2, notes: [{ pitch: pitch + 24, startTime: 1, duration: 2, velocity: 100 }] },
].reverse() });

for (const revoke of [false, true]) test(`local MIDI conditioning preserves ordered context and authentic source${revoke ? " when approval is revoked" : ""}`, async (t) => {
  const h = await continuationHarness(t);
  await saveGlobalSettings(h.directory, { integrationConnections: { action: "upsert", expectedRevision: "0", connection } });
  const staged: ReturnType<typeof parseMidiArtifact>[] = [];
  const paths: string[] = [];
  const request = await createRequestPluginTools({ storageDirectory: h.directory, sessionId: h.sessionId, signal: h.signal,
    withAuthorization: async (_signal, operation) => operation(),
    midiOutputPolicy: { generationKind: "continuation", validate: async (bytes) => assertMidiContinuationOutput(bytes, 8, h.signal),
      beforeCommit: () => { assertMidiContinuationSource(h.context, h.buffer, h.signal); } },
    createStandaloneConnection: (saved) => createStandaloneMcpConnection(saved, { connector: async () => ({
      listTools: async () => [tool], close: async () => undefined,
      callTool: async (_name, value) => {
        const args = value as Record<string, unknown>;
        const source = args.source as string; const destination = args.destination as string;
        assert.equal(args.beats, 8); assert.equal(args.style, "sparse");
        assert.equal((await fs.stat(source)).mode & 0o777, 0o400);
        paths.push(source); staged.push(parseMidiArtifact(new Uint8Array(await fs.readFile(source)), h.signal));
        await fs.writeFile(destination, output(50 + staged.length));
        if (revoke && staged.length === 2) {
          const settings = await loadAgentSettings(h.directory);
          await saveGlobalSettings(h.directory, { integrationConnections: { action: "upsert", expectedRevision: settings.integrationConnections!.revision,
            connection: { ...connection, artifactInputApproved: false } } });
        }
        return { content: [{ type: "text", text: "Saved next section" }] };
      },
    }) }),
  });
  t.after(() => request.close());
  const choice = midiContinuationGenerators(request)[0]!;
  assert.ok(choice); assert.equal(choice.inputArgument, "source"); assert.equal(choice.lengthArgument, "beats");
  await saveMidiContinuation(h.directory, h.sessionId, { ...h.buffer, generator: { kind: "plugin", toolName: choice.toolName,
    signature: choice.signature, inputArgument: choice.inputArgument, lengthArgument: choice.lengthArgument, arguments: { style: "sparse" } }, prompt: "" }, h.signal);
  const fill = () => fillMidiContinuation({ ...h, bufferId: h.buffer.id, onProgress: async () => {},
    validateGenerator: async () => request.assertToolCurrent(choice.toolName),
    generate: (buffer, onEvent) => generateMidiContinuationWithPlugin({ storageDirectory: h.directory, buffer, tools: request,
      signal: h.signal, beforeCommit: () => { assertMidiContinuationSource(h.context, buffer, h.signal); }, onEvent }) });
  if (revoke) await assert.rejects(fill(), /changed|approved|admitted|confirmed/i);
  else await fill();
  const buffer = (await readMidiContinuation(h.directory, h.sessionId))!;
  assert.equal(buffer.queue.length, revoke ? 1 : 2);
  assert.equal(staged.length, 2);
  assert.equal(staged[0]!.durationBeats, 8); assert.equal(staged[1]!.durationBeats, 16);
  assert.deepEqual(staged[0]!.parts.map((part) => part.sourceTrackName), ["Bass", "Lead"]);
  assert.deepEqual(staged[1]!.parts.map((part) => part.notes.map((note) => [note.pitch, note.startTime])), [[[48, 0]], [[72, 0]], [[75, 9]], [[51, 8]]]);
  assert.deepEqual(staged[1]!.parts.map((part) => [part.sourceTrackName, part.channel]), [["Bass", 1], ["Lead", 2], ["Lead", 2], ["Bass", 1]]);
  for (const path of paths) await assert.rejects(fs.stat(path), { code: "ENOENT" });
  for (const entry of buffer.queue) {
    const saved = await readMidiArtifact(h.directory, h.sessionId, entry.artifactRef, h.signal);
    assert.equal(saved.artifact.connectionId, connection.id); assert.equal(saved.artifact.pluginId, undefined);
    assert.equal(saved.artifact.source, undefined); assert.equal(saved.artifact.generationKind, "continuation");
  }
  const artifacts = await listMidiArtifacts(h.directory, h.sessionId);
  assert.ok(artifacts.some((artifact) => artifact.id === h.buffer.sourceArtifactRef));
  if (revoke) {
    await assert.rejects(fill(), /changed|approved|admitted/i);
    assert.equal(staged.length, 2, "revocation must prevent further generator calls");
  }
});
