import { createHash } from "node:crypto";
import type { MidiContinuationBuffer, MidiContinuationGenerator, MidiContinuationGeneratorChoice } from "../../agent/midi-continuation-contracts.js";
import type { AgentLoopTraceEvent } from "../../agent/loop.js";
import { writeStandardMidi } from "../../attachments/midi-writer.js";
import { validatePluginParameters } from "../../plugins/parameter-panel.js";
import { throwIfAborted } from "../../runtime/host.js";
import { readMidiArtifact, saveMidiArtifact, type MidiArtifact, type ParsedMidiArtifact } from "../../storage/midi-artifacts.js";
import { activeSavedProfile, savedProfileRevision, type AgentSettings } from "../../storage/settings.js";
import type { AgentSession } from "../../storage/sessions.js";
import { effectiveSessionModelSelection } from "../model/dialog-model-state.js";
import type { RequestPluginTools } from "../plugins/request-plugin-tools.js";

export function midiModelGenerator(settings: AgentSettings, session: AgentSession): Extract<MidiContinuationGenerator, { kind: "model" }> {
  const profile = activeSavedProfile(settings);
  if (!profile) throw new Error("Choose a saved model Profile before generating MIDI.");
  const selection = effectiveSessionModelSelection(profile, session);
  return { kind: "model", profileId: profile.id, model: selection.model,
    configurationFingerprint: createHash("sha256").update(JSON.stringify([savedProfileRevision(profile), selection])).digest("hex") };
}

export function midiContinuationGenerators(tools: RequestPluginTools): MidiContinuationGeneratorChoice[] {
  return tools.catalogTools().flatMap((tool) => tool.continuation && tool.panel ? [{
    toolName: tool.panel.toolName, signature: tool.panel.signature,
    label: [tool.connectionName ?? tool.pluginId, tool.name].filter(Boolean).join(" · "),
    ...tool.continuation, panel: tool.panel,
  }] : []);
}

/** Output admission and subsequent generation use the same bounded conditioning encoding. */
export function encodeMidiContinuationConditioning(source: ParsedMidiArtifact, parent: ParsedMidiArtifact, signal: AbortSignal): Uint8Array {
  // Track order and names are not stable voice identities across generated artifacts.
  // Keep both files' parts independent instead of combining unrelated voices by index.
  const tracks = [
    ...source.parts.map((part) => ({ name: part.sourceTrackName ?? `Original part ${part.sourceTrackIndex + 1}`,
      channel: part.channel, notes: part.notes })),
    ...parent.parts.map((part) => ({ name: part.sourceTrackName ?? `Previous part ${part.sourceTrackIndex + 1}`,
      channel: part.channel, notes: part.notes.map((note) => ({ ...note, startTime: note.startTime + source.durationBeats })) })),
  ];
  return writeStandardMidi({ tracks, durationBeats: source.durationBeats + parent.durationBeats, signal });
}

/** A single conditioning file retains the original voices followed by the previous generated section. */
async function pluginConditioningSource(input: {
  storageDirectory: string | undefined; buffer: MidiContinuationBuffer; signal: AbortSignal; beforeCommit(): void;
}): Promise<string> {
  const previous = input.buffer.queue.at(-1)?.artifactRef ?? input.buffer.lastArtifactRef;
  if (!previous) return input.buffer.sourceArtifactRef;
  const source = await readMidiArtifact(input.storageDirectory, input.buffer.sessionId, input.buffer.sourceArtifactRef, input.signal);
  const parent = await readMidiArtifact(input.storageDirectory, input.buffer.sessionId, previous, input.signal);
  const bytes = encodeMidiContinuationConditioning(source.parsed, parent.parsed, input.signal);
  const condition = await saveMidiArtifact(input.storageDirectory, input.buffer.sessionId, {
    source: { kind: "host", operation: "midi-conditioning-context" }, serverId: "host", toolName: "condition_midi_continuation",
    label: `MIDI context for section ${input.buffer.nextSequence + 1}`, bytes, signal: input.signal, beforeCommit: input.beforeCommit,
  });
  return condition.id;
}

export async function generateMidiContinuationWithPlugin(input: {
  storageDirectory: string | undefined; buffer: MidiContinuationBuffer; tools: RequestPluginTools;
  signal: AbortSignal; beforeCommit(): void; onEvent(event: AgentLoopTraceEvent): Promise<void>;
}): Promise<MidiArtifact> {
  if (input.buffer.generator.kind !== "plugin") throw new Error("Choose a MIDI conditioning tool.");
  const generator = input.buffer.generator;
  const choice = midiContinuationGenerators(input.tools).find((tool) => tool.toolName === generator.toolName && tool.signature === generator.signature);
  if (!choice) throw new Error("The MIDI generator or its configuration changed. Reload and configure the buffer again.");
  const sourceId = await pluginConditioningSource(input);
  const args = validatePluginParameters(choice.panel, { ...generator.arguments,
    [choice.inputArgument]: sourceId, [choice.lengthArgument]: input.buffer.segmentBeats });
  const previous = new Set(input.tools.midiArtifacts().map((artifact) => artifact.id));
  await input.onEvent({ kind: "tool_call", name: generator.toolName, content: JSON.stringify(args) });
  const result = await input.tools.callTool({ id: `midi-section-${input.buffer.nextSequence}`, name: generator.toolName, arguments: JSON.stringify(args) });
  await input.onEvent({ kind: "tool_result", name: generator.toolName, content: result.content, ...(result.artifacts ? { artifacts: result.artifacts } : {}) });
  throwIfAborted(input.signal);
  if (result.failed || result.outcomeUnknown) throw new Error("The MIDI generator did not return a confirmed artifact. Existing buffer entries were retained.");
  const created = input.tools.midiArtifacts().filter((artifact) => !previous.has(artifact.id));
  if (created.length !== 1) throw new Error("The MIDI generator must return exactly one saved artifact per section.");
  return created[0]!;
}
