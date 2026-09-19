import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { platform } from "node:process";
import test from "node:test";
import { promisify } from "node:util";

import type { Tool } from "@modelcontextprotocol/client";

import { createHostAbortController } from "../runtime/host.js";
import { audioStorageHarness, waveBytes } from "../storage/audio-storage-test-helpers.js";
import { listMidiArtifacts } from "../storage/midi-artifacts.js";
import { saveMidiArtifact } from "../storage/midi-artifacts.js";
import {
  LIVE_SMITH_ARTIFACT_META_KEY,
  callPluginToolWithArtifacts,
  modelSchemaForArtifactTool,
  materializeMidiArtifactActionPlan,
  midiArtifactImportActionSchema,
  pluginArtifactContract,
} from "./artifacts.js";

const execFileAsync = promisify(execFile);

function midiFile(): Uint8Array {
  const track = new Uint8Array([
    0x00, 0x90, 60, 100,
    0x83, 0x60, 0x80, 60, 0x40,
    0x00, 0xff, 0x2f, 0x00,
  ]);
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.byteLength, ...track,
  ]);
}

function artifactTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "transcribe",
    description: "Transcribe audio to MIDI",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        destination: { type: "string" },
        sensitivity: { type: "number" },
      },
      required: ["source", "destination"],
      additionalProperties: false,
    },
    _meta: {
      [LIVE_SMITH_ARTIFACT_META_KEY]: {
        version: 1,
        inputs: [{ argument: "source", kind: "audio" }],
        outputs: [{ argument: "destination", kind: "midi", label: "Transcribed MIDI" }],
      },
    },
    ...overrides,
  };
}

test("artifact metadata rewrites path arguments into opaque model references", () => {
  const tool = artifactTool();
  const contract = pluginArtifactContract(tool)!;
  assert.deepEqual(contract, {
    inputs: [{ argument: "source", kind: "audio" }],
    outputs: [{ argument: "destination", kind: "midi", label: "Transcribed MIDI" }],
  });
  assert.deepEqual(modelSchemaForArtifactTool(tool.inputSchema, contract), {
    type: "object",
    properties: {
      source: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "Opaque Session audio artifact reference from Live Smith. This is not a filesystem path.",
      },
      sensitivity: { type: "number" },
    },
    required: ["source"],
    additionalProperties: false,
  });
});

test("artifact contracts reject malformed, conflicting and undeclared path arguments", () => {
  for (const extension of [
    { version: 2, inputs: [], outputs: [] },
    { version: 1, inputs: [{ argument: "../source", kind: "audio" }], outputs: [{ argument: "out", kind: "midi", label: "MIDI" }] },
    { version: 1, inputs: [{ argument: "source", kind: "audio" }], outputs: [{ argument: "source", kind: "midi", label: "MIDI" }] },
    { version: 1, inputs: [], outputs: [] },
  ]) {
    assert.throws(() => pluginArtifactContract(artifactTool({
      _meta: { [LIVE_SMITH_ARTIFACT_META_KEY]: extension },
    })));
  }
  const contract = pluginArtifactContract(artifactTool())!;
  assert.throws(() => modelSchemaForArtifactTool({
    type: "object",
    properties: { source: { type: "string" } },
  }, contract));
});

test("artifact calls stage exact Session audio and persist only validated MIDI metadata", async (t) => {
  const h = await audioStorageHarness(t);
  const source = await h.save("source", waveBytes(2));
  let stagingDirectory = "";
  const contract = pluginArtifactContract(artifactTool())!;
  const result = await callPluginToolWithArtifacts({
    contract,
    argumentsValue: { source: source.id, sensitivity: 0.8 },
    storageDirectory: h.storage,
    temporaryDirectory: h.storage,
    sessionId: h.session.id,
    pluginId: "audio-to-midi",
    serverId: "local",
    toolName: "transcribe",
    signal: h.signal,
    async call(argumentsValue) {
      const inputPath = String(argumentsValue.source);
      const outputPath = String(argumentsValue.destination);
      stagingDirectory = path.dirname(path.dirname(inputPath));
      assert.deepEqual(new Uint8Array(await fs.readFile(inputPath)), waveBytes(2));
      assert.equal((await fs.stat(inputPath)).mode & 0o777, 0o400);
      assert.equal(path.dirname(outputPath), path.join(stagingDirectory, "output"));
      await fs.writeFile(outputPath, midiFile());
      return { content: [{ type: "text", text: "transcribed" }] };
    },
  });
  assert.equal(result.artifacts.length, 1);
  assert.deepEqual(result.result, { content: [{ type: "text", text: "transcribed" }] });
  assert.deepEqual((await listMidiArtifacts(h.storage, h.session.id)).map((artifact) => ({
    id: artifact.id,
    pluginId: artifact.pluginId,
    serverId: artifact.serverId,
    toolName: artifact.toolName,
    label: artifact.label,
    noteCount: artifact.noteCount,
    durationBeats: artifact.durationBeats,
  })), [{
    id: result.artifacts[0]!.id,
    pluginId: "audio-to-midi",
    serverId: "local",
    toolName: "transcribe",
    label: "Transcribed MIDI",
    noteCount: 1,
    durationBeats: 1,
  }]);
  await assert.rejects(fs.stat(stagingDirectory));
});

test("artifact calls reject host output arguments, private-path echoes and undeclared files", async (t) => {
  const h = await audioStorageHarness(t);
  const source = await h.save();
  const contract = pluginArtifactContract(artifactTool())!;
  const base = {
    contract,
    storageDirectory: h.storage,
    temporaryDirectory: h.storage,
    sessionId: h.session.id,
    pluginId: "audio-to-midi",
    serverId: "local",
    toolName: "transcribe",
    signal: h.signal,
  };
  await assert.rejects(callPluginToolWithArtifacts({
    ...base,
    argumentsValue: { source: source.id, destination: "/tmp/stolen.mid" },
    call: async () => assert.fail("must not call"),
  }), /host-owned/u);
  await assert.rejects(callPluginToolWithArtifacts({
    ...base,
    argumentsValue: { source: source.id },
    call: async (args) => {
      await fs.writeFile(String(args.destination), midiFile());
      return { content: [{ type: "text", text: `saved:${String(args.destination)}` }] };
    },
  }), /private filesystem path/u);
  await assert.rejects(callPluginToolWithArtifacts({
    ...base,
    argumentsValue: { source: source.id },
    call: async (args) => {
      const output = String(args.destination);
      await fs.writeFile(output, midiFile());
      await fs.writeFile(path.join(path.dirname(output), "extra.mid"), midiFile());
      return { content: [] };
    },
  }), /undeclared/u);
  assert.deepEqual(await listMidiArtifacts(h.storage, h.session.id), []);
});

test("artifact output rejects directories, symlinks, FIFOs and cancellation cleans staging", async (t) => {
  const h = await audioStorageHarness(t);
  const source = await h.save();
  const contract = pluginArtifactContract(artifactTool())!;
  const base = {
    contract,
    argumentsValue: { source: source.id },
    storageDirectory: h.storage,
    temporaryDirectory: h.storage,
    sessionId: h.session.id,
    pluginId: "audio-to-midi",
    serverId: "local",
    toolName: "transcribe",
    signal: h.signal,
  };
  for (const create of [
    (target: string) => fs.mkdir(target),
    (target: string) => fs.symlink("/dev/null", target),
    ...(platform === "win32" ? [] : [async (target: string) => { await execFileAsync("mkfifo", [target]); }]),
  ]) {
    await assert.rejects(callPluginToolWithArtifacts({
      ...base,
      call: async (args) => { await create(String(args.destination)); return { content: [] }; },
    }), /regular file/u);
  }
  const controller = createHostAbortController();
  let staging = "";
  await assert.rejects(callPluginToolWithArtifacts({
    ...base,
    signal: controller.signal,
    call: async (args) => {
      staging = path.dirname(path.dirname(String(args.destination)));
      await fs.writeFile(String(args.destination), midiFile());
      controller.abort(new Error("stop fixture"));
      return { content: [] };
    },
  }), /stop fixture/u);
  await assert.rejects(fs.stat(staging));
  assert.deepEqual(await listMidiArtifacts(h.storage, h.session.id), []);
});

test("MIDI artifact actions materialize into the ordinary validated Live action contract", async (t) => {
  const h = await audioStorageHarness(t);
  const artifact = await saveMidiArtifact(h.storage, h.session.id, {
    pluginId: "audio-to-midi",
    serverId: "local",
    toolName: "transcribe",
    label: "Transcribed MIDI",
    bytes: midiFile(),
    signal: h.signal,
  });
  assert.equal((midiArtifactImportActionSchema.properties as Record<string, unknown>).artifactRef !== undefined, true);
  const plan = await materializeMidiArtifactActionPlan({
    storageDirectory: h.storage,
    sessionId: h.session.id,
    signal: h.signal,
    argumentsJson: JSON.stringify({
      message: "Import transcription",
      actions: [{
        type: "create_midi_clip_from_artifact",
        trackName: "Lead",
        startBeat: 8,
        name: "Transcription",
        artifactRef: artifact.id,
      }],
    }),
  });
  assert.deepEqual(plan, {
    message: "Import transcription",
    actions: [{
      type: "create_midi_clip",
      trackName: "Lead",
      startBeat: 8,
      durationBeats: 1,
      name: "Transcription",
      notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }],
    }],
  });
  await assert.rejects(materializeMidiArtifactActionPlan({
    storageDirectory: h.storage,
    sessionId: h.session.id,
    signal: h.signal,
    argumentsJson: JSON.stringify({ message: "Invalid", actions: [{
      type: "create_midi_clip_from_artifact",
      startBeat: 0,
      artifactRef: artifact.id,
      notes: [],
    }] }),
  }), /Action 1/u);
});
