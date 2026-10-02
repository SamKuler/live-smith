import type { MidiContinuationBuffer } from "../../agent/midi-continuation-contracts.js";
import { runAgentLoop, type AgentLoopTraceEvent } from "../../agent/loop.js";
import { writeStandardMidi } from "../../attachments/midi-writer.js";
import { ToolRegistry, type Toolset } from "../../plugins/registry.js";
import { throwIfAborted } from "../../runtime/host.js";
import { type MidiArtifact, saveMidiArtifact } from "../../storage/midi-artifacts.js";
import type { RuntimeProfile } from "../../model/provider.js";
import { midiArtifactAuthoringSchema, parseMidiArtifactAuthoringArguments } from "./midi-artifact-authoring.js";
import type { AgentModelTurnRequester } from "../agent-request.js";

/** Uses the existing bounded model loop with an execution-level MIDI-only tool admission. */
export async function generateMidiContinuationWithModel(input: {
  storageDirectory: string | undefined;
  buffer: MidiContinuationBuffer;
  runtimeProfile: RuntimeProfile;
  requestTurn: AgentModelTurnRequester;
  readTools: Toolset;
  signal: AbortSignal;
  beforeSave(bytes: Uint8Array): Promise<void>;
  beforeCommit(): void;
  creativeBrief?: string;
  onEvent(event: AgentLoopTraceEvent): Promise<void>;
  onProgress(message: string): Promise<void>;
}): Promise<MidiArtifact> {
  if (!input.runtimeProfile.capabilities.tools) throw new Error("The selected model must support tool calls to save MIDI candidates.");
  let artifact: MidiArtifact | undefined;
  let saveFailure: unknown;
  const save: Toolset = {
    id: "live-smith.midi-authoring",
    tools: () => [{ type: "function", function: { name: "save_midi_artifact", description: `Save one multitrack MIDI continuation of exactly ${input.buffer.segmentBeats} beats. All note times are relative to the new section. This creates a Session candidate without changing Live.`, parameters: midiArtifactAuthoringSchema } }],
    async callTool(call) {
      if (artifact) return { content: JSON.stringify({ artifacts: [{ kind: "midi", artifactRef: artifact.id, label: artifact.label }] }), stop: true };
      let bytes: Uint8Array, label: string;
      try {
        const parsed = parseMidiArtifactAuthoringArguments(JSON.parse(call.arguments)); label = parsed.label;
        bytes = writeStandardMidi({ tracks: parsed.tracks, durationBeats: input.buffer.segmentBeats, signal: input.signal });
      } catch (error) {
        throwIfAborted(input.signal);
        return { content: error instanceof Error ? error.message : "Invalid MIDI notes.", failed: true, invalidArguments: true };
      }
      try {
      await input.beforeSave(bytes);
      throwIfAborted(input.signal);
      artifact = await saveMidiArtifact(input.storageDirectory, input.buffer.sessionId, {
        source: { kind: "model", profileId: input.runtimeProfile.profile.id, model: input.runtimeProfile.model.model },
        serverId: "host", toolName: "save_midi_artifact", label, bytes, signal: input.signal,
        generationKind: "continuation", beforeCommit: input.beforeCommit,
      });
      return { content: JSON.stringify({ artifacts: [{ kind: "midi", artifactRef: artifact.id, label: artifact.label,
        durationBeats: artifact.durationBeats, trackCount: artifact.trackCount, noteCount: artifact.noteCount }] }), stop: true };
      } catch (error) {
        throwIfAborted(input.signal); saveFailure = error;
        return { content: "The MIDI candidate could not be saved against the current source.", failed: true, stop: true };
      }
    },
  };
  const registry = new ToolRegistry([input.readTools, save]);
  const parent = input.buffer.queue.at(-1)?.artifactRef ?? input.buffer.lastArtifactRef;
  const prompt = [
    `Generate the next ${input.buffer.segmentBeats}-beat multitrack MIDI section, number ${input.buffer.nextSequence + 1}.`,
    `The observed Live MIDI context is saved as artifactRef ${input.buffer.sourceArtifactRef}. Inspect its parts and notes before composing.`,
    parent ? `The immediately preceding generated section is artifactRef ${parent}. Continue after it while retaining the original Live context.` : "Continue immediately after the observed Live source material.",
    "Use list_session_artifacts and inspect_midi_artifact to read the references, then save exactly one candidate with save_midi_artifact. Preserve distinct instrumental voices. Start new note times at beat 0 and keep every note inside the requested duration.",
    input.buffer.prompt,
  ].filter(Boolean).join("\n");
  await runAgentLoop({
    signal: input.signal, maxConsecutiveFailures: 3, maxIterations: 8, maxToolCallsPerTurn: 8,
    admittedToolNames: registry.tools().map((tool) => tool.function.name),
    externalTools: { names: registry.tools().map((tool) => tool.function.name), execute: (call) => registry.callTool(call) },
    askModel: ({ messages }) => input.requestTurn({
      prompt, liveContext: "MIDI continuation generation from explicitly observed and saved source material.",
      runtimeProfile: input.runtimeProfile, ...(input.creativeBrief ? { creativeBrief: input.creativeBrief } : {}), history: [], agentMessages: messages, tools: [...registry.tools()], editScopes: [],
      signal: input.signal, onDelta: () => {},
    }),
    observe: async () => { throw new Error("Live observations are not admitted in MIDI candidate generation."); },
    confirmActions: async () => { throw new Error("Live actions are not admitted in MIDI candidate generation."); },
    executeActions: async () => { throw new Error("Live actions are not admitted in MIDI candidate generation."); },
    onEvent: input.onEvent, onProgress: input.onProgress,
  });
  throwIfAborted(input.signal);
  if (saveFailure) throw saveFailure;
  if (!artifact) throw new Error("The model did not save a MIDI candidate. Existing buffer entries are unchanged.");
  return artifact;
}
