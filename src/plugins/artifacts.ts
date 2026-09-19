import type { Tool } from "@modelcontextprotocol/client";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { cloneJsonValue } from "../model/json-clone.js";
import { validateAgentPlan, type AgentPlan } from "../agent/actions.js";
import { throwIfAborted } from "../runtime/host.js";
import { readAudioAsset } from "../storage/audio-assets.js";
import {
  MAX_MIDI_ARTIFACT_BYTES,
  parseMidiArtifact,
  readMidiArtifact,
  saveMidiArtifact,
  type MidiArtifact,
} from "../storage/midi-artifacts.js";
import { isSafeStorageId } from "../storage/id.js";
import { safeRegularFileOpenFlags } from "../live/safe-file-read.js";
import type { PluginArtifactToolContract, PluginToolResult } from "./contracts.js";

export const LIVE_SMITH_ARTIFACT_META_KEY = "io.github.samkuler/live-smith-artifacts";
const argumentPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const MAX_ARTIFACT_INPUTS = 4;

export const midiArtifactImportActionSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["create_midi_clip_from_artifact"] },
    trackName: { type: "string", minLength: 1 },
    trackRef: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
    laneIndex: { type: "integer", minimum: 0, maximum: 4095 },
    laneName: { type: "string", minLength: 1 },
    startBeat: { type: "number" },
    name: { type: "string", minLength: 1 },
    artifactRef: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "Exact MIDI artifactRef returned by a Plugin tool or list_session_artifacts.",
    },
  },
  required: ["type", "startBeat", "artifactRef"],
  additionalProperties: false,
};

export function pluginArtifactContract(tool: Tool): PluginArtifactToolContract | undefined {
  const raw = tool._meta?.[LIVE_SMITH_ARTIFACT_META_KEY];
  if (raw === undefined) return undefined;
  if (!plainRecord(raw) || Object.keys(raw).some((key) => !["version", "inputs", "outputs"].includes(key)) ||
      raw.version !== 1 || !Array.isArray(raw.inputs) || !Array.isArray(raw.outputs) ||
      raw.inputs.length > MAX_ARTIFACT_INPUTS || raw.outputs.length !== 1) {
    throw new Error("Plugin artifact contract is invalid.");
  }
  const inputs = raw.inputs.map((entry) => {
    if (!plainRecord(entry) || Object.keys(entry).some((key) => !["argument", "kind"].includes(key)) ||
        typeof entry.argument !== "string" || !argumentPattern.test(entry.argument) || entry.kind !== "audio") {
      throw new Error("Plugin artifact input is invalid.");
    }
    return { argument: entry.argument as string, kind: "audio" as const };
  });
  const outputs = raw.outputs.map((entry) => {
    if (!plainRecord(entry) || Object.keys(entry).some((key) => !["argument", "kind", "label"].includes(key)) ||
        typeof entry.argument !== "string" || !argumentPattern.test(entry.argument) ||
        entry.kind !== "midi" || !safeLabel(entry.label)) {
      throw new Error("Plugin artifact output is invalid.");
    }
    return { argument: entry.argument as string, kind: "midi" as const, label: entry.label };
  });
  const argumentsSet = new Set([...inputs, ...outputs].map((entry) => entry.argument));
  if (argumentsSet.size !== inputs.length + outputs.length) throw new Error("Plugin artifact arguments conflict.");
  return { inputs, outputs };
}

export function modelSchemaForArtifactTool(
  inputSchema: Tool["inputSchema"],
  contract: PluginArtifactToolContract | undefined,
): Record<string, unknown> {
  const schema = cloneJsonValue(inputSchema) as Record<string, unknown>;
  if (!contract) return schema;
  if (!plainRecord(schema.properties)) throw new Error("Plugin artifact tool requires object properties.");
  if (schema.required !== undefined &&
      (!Array.isArray(schema.required) || !schema.required.every((entry) => typeof entry === "string"))) {
    throw new Error("Plugin artifact tool has an invalid required-field list.");
  }
  const properties = { ...schema.properties };
  const required = Array.isArray(schema.required) && schema.required.every((entry) => typeof entry === "string")
    ? new Set(schema.required)
    : new Set<string>();
  for (const input of contract.inputs) {
    if (!Object.hasOwn(properties, input.argument)) throw new Error("Plugin artifact input argument is missing from its schema.");
    properties[input.argument] = {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "Opaque Session audio artifact reference from Live Smith. This is not a filesystem path.",
    };
    required.add(input.argument);
  }
  for (const output of contract.outputs) {
    if (!Object.hasOwn(properties, output.argument)) throw new Error("Plugin artifact output argument is missing from its schema.");
    delete properties[output.argument];
    required.delete(output.argument);
  }
  return {
    ...schema,
    properties,
    ...(required.size ? { required: [...required] } : { required: [] }),
  };
}

export async function callPluginToolWithArtifacts(input: {
  contract: PluginArtifactToolContract;
  argumentsValue: unknown;
  storageDirectory: string | undefined;
  temporaryDirectory: string | undefined;
  sessionId: string;
  pluginId: string;
  serverId: string;
  toolName: string;
  signal: AbortSignal;
  forbiddenPaths?: readonly string[];
  call(argumentsValue: Record<string, unknown>): Promise<PluginToolResult>;
}): Promise<{ result: PluginToolResult; artifacts: MidiArtifact[] }> {
  if (!plainRecord(input.argumentsValue)) throw new Error("Plugin tool arguments must be an object.");
  const temporaryRoot = input.temporaryDirectory ?? input.storageDirectory;
  if (!temporaryRoot || !path.isAbsolute(temporaryRoot)) throw new Error("Plugin artifact staging is unavailable.");
  const argumentsValue = cloneJsonValue(input.argumentsValue) as Record<string, unknown>;
  for (const output of input.contract.outputs) {
    if (Object.hasOwn(argumentsValue, output.argument)) throw new Error("Plugin output paths are host-owned.");
  }
  let stagingDirectory: string | undefined;
  try {
    stagingDirectory = await fs.mkdtemp(path.join(temporaryRoot, "live-smith-plugin-call-"));
    await fs.chmod(stagingDirectory, 0o700);
    const inputDirectory = path.join(stagingDirectory, "input");
    const outputDirectory = path.join(stagingDirectory, "output");
    await fs.mkdir(inputDirectory, { mode: 0o700 });
    await fs.mkdir(outputDirectory, { mode: 0o700 });
    for (const [index, descriptor] of input.contract.inputs.entries()) {
      const artifactRef = argumentsValue[descriptor.argument];
      if (typeof artifactRef !== "string") throw new Error("Plugin artifact input reference is invalid.");
      const { asset, bytes } = await readAudioAsset(
        input.storageDirectory,
        input.sessionId,
        artifactRef,
        input.signal,
      );
      const target = path.join(inputDirectory, `${index + 1}.${asset.mediaType === "audio/mpeg" ? "mp3" : "wav"}`);
      await fs.writeFile(target, bytes, { flag: "wx", mode: 0o400 });
      argumentsValue[descriptor.argument] = target;
    }
    const output = input.contract.outputs[0]!;
    const outputName = "1.mid";
    const outputPath = path.join(outputDirectory, outputName);
    argumentsValue[output.argument] = outputPath;
    throwIfAborted(input.signal);
    const result = await input.call(argumentsValue);
    throwIfAborted(input.signal);
    const realStaging = await fs.realpath(stagingDirectory);
    assertPluginResultHasNoPrivatePaths(result, [
      stagingDirectory,
      realStaging,
      ...(input.forbiddenPaths ?? []),
    ]);
    if (result.isError) return { result, artifacts: [] };
    const entries = await fs.readdir(outputDirectory);
    if (entries.length !== 1 || entries[0] !== outputName) throw new Error("Plugin produced undeclared artifact output.");
    const bytes = await readRegularOutput(outputPath, input.signal);
    parseMidiArtifact(bytes, input.signal);
    const artifact = await saveMidiArtifact(input.storageDirectory, input.sessionId, {
      pluginId: input.pluginId,
      serverId: input.serverId,
      toolName: input.toolName,
      label: output.label,
      bytes,
      signal: input.signal,
    });
    return { result, artifacts: [artifact] };
  } finally {
    if (stagingDirectory) await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function materializeMidiArtifactActionPlan(input: {
  argumentsJson: string;
  storageDirectory: string | undefined;
  sessionId: string;
  signal: AbortSignal;
}): Promise<AgentPlan> {
  let value: unknown;
  try { value = JSON.parse(input.argumentsJson || "{}"); }
  catch { throw new Error("Invalid JSON arguments for tool call."); }
  if (!plainRecord(value) || !Array.isArray(value.actions)) {
    return validateAgentPlan(value);
  }
  const actions: unknown[] = [];
  for (const [index, raw] of value.actions.entries()) {
    if (!plainRecord(raw) || raw.type !== "create_midi_clip_from_artifact") {
      actions.push(raw);
      continue;
    }
    try {
      const allowed = new Set(["type", "trackName", "trackRef", "laneIndex", "laneName", "startBeat", "name", "artifactRef"]);
      if (Object.keys(raw).some((key) => !allowed.has(key)) || !isSafeStorageId(raw.artifactRef)) {
        throw new Error("MIDI artifact action fields are invalid.");
      }
      const { parsed } = await readMidiArtifact(
        input.storageDirectory,
        input.sessionId,
        raw.artifactRef,
        input.signal,
      );
      actions.push({
        type: "create_midi_clip",
        ...(raw.trackName === undefined ? {} : { trackName: raw.trackName }),
        ...(raw.trackRef === undefined ? {} : { trackRef: raw.trackRef }),
        ...(raw.laneIndex === undefined ? {} : { laneIndex: raw.laneIndex }),
        ...(raw.laneName === undefined ? {} : { laneName: raw.laneName }),
        startBeat: raw.startBeat,
        durationBeats: parsed.durationBeats,
        ...(raw.name === undefined ? {} : { name: raw.name }),
        notes: parsed.notes,
      });
    } catch (error) {
      throw new Error(`Action ${index + 1} could not load its saved MIDI artifact.`, { cause: error });
    }
  }
  return validateAgentPlan({ ...value, actions });
}

async function readRegularOutput(target: string, signal: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  const before = await fs.lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 ||
      before.size > MAX_MIDI_ARTIFACT_BYTES) throw new Error("Plugin artifact output is not a bounded regular file.");
  const handle = await fs.open(target, safeRegularFileOpenFlags(fsConstants));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("Plugin artifact output changed while opening.");
    }
    const bytes = new Uint8Array(await handle.readFile());
    throwIfAborted(signal);
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || bytes.byteLength !== opened.size) {
      throw new Error("Plugin artifact output changed while reading.");
    }
    return bytes;
  } finally { await handle.close(); }
}

export function assertPluginResultHasNoPrivatePaths(
  value: unknown,
  paths: readonly string[],
): void {
  const candidates = [...new Set(paths.filter((entry) => entry && path.isAbsolute(entry)))];
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === "string" && candidates.some((candidate) => current.includes(candidate))) {
      throw new Error("Plugin result contains a private filesystem path.");
    }
    if (Array.isArray(current)) pending.push(...current);
    else if (plainRecord(current)) pending.push(...Object.values(current));
  }
}

function safeLabel(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 120 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
