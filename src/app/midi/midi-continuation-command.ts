import { createSessionMidiArtifactToolset } from "./midi-artifact-tools.js";
import type { ExtensionContext } from "@ableton-extensions/sdk";
import type { MidiContinuationCommand, MidiContinuationView, MidiContinuationGenerator } from "../../agent/midi-continuation-contracts.js";
import type { RuntimeProfile } from "../../model/provider.js";
import { validatePluginParameters } from "../../plugins/parameter-panel.js";
import { throwIfAborted } from "../../runtime/host.js";
import { loadAgentSettings, type AgentSettings } from "../../storage/settings.js";
import { listSessions, type AgentSession } from "../../storage/sessions.js";
import { MAX_MIDI_ARTIFACT_NOTES, MAX_MIDI_ARTIFACT_TRACKS, parseMidiArtifact, readMidiArtifact, readMidiContinuation } from "../../storage/midi-artifacts.js";
import { createRequestPluginTools, type PluginExecutionAuthorization, type RequestPluginTools } from "../plugins/request-plugin-tools.js";
import type { AgentModelTurnRequester } from "../agent-request.js";
import type { MidiArtifactImportCommand } from "../midi-artifact-import.js";
import { assertMidiContinuationOutput, assertMidiContinuationSource, configureMidiContinuation, consumeMidiContinuation, fillMidiContinuation } from "./midi-continuation.js";
import { observeMidiContinuationClips } from "./midi-continuation-context.js";
import { generateMidiContinuationWithModel } from "./midi-continuation-model.js";
import { generateMidiContinuationWithPlugin, midiContinuationGenerators, midiModelGenerator } from "./midi-continuation-generators.js";

interface Runtime {
  context: ExtensionContext<"1.0.0">;
  storageDirectory: string | undefined;
  projectKey: string;
  sessionId: string;
  signal: AbortSignal;
}
interface Dependencies extends Runtime {
  fetchImpl?: typeof fetch;
  withPluginAuthorization: PluginExecutionAuthorization;
  acquireModel(session: AgentSession, settings: AgentSettings): Promise<{ runtimeProfile: RuntimeProfile; requestTurn: AgentModelTurnRequester; release(): void }>;
  onProgress(message: string): Promise<void>;
}

async function activeSession(input: Runtime): Promise<AgentSession> {
  const session = (await listSessions(input.storageDirectory, input.projectKey)).find((entry) => entry.id === input.sessionId && !entry.archivedAt);
  if (!session) throw new Error("That MIDI continuation Session is not available in this Live Set.");
  throwIfAborted(input.signal); return session;
}

export async function refreshMidiContinuationView(input: Runtime, previous: MidiContinuationView, generatorCatalogCurrent = true): Promise<MidiContinuationView> {
  const buffer = await readMidiContinuation(input.storageDirectory, input.sessionId, input.signal);
  let stale = false; let staleReason: MidiContinuationView["staleReason"];
  if (buffer) {
    try { assertMidiContinuationSource(input.context, buffer, input.signal); }
    catch { throwIfAborted(input.signal); stale = true; staleReason = "source_changed"; }
    if (!stale) {
      const generator = buffer.generator;
      try {
        const current = generator.kind === "model"
          ? midiModelGenerator(await loadAgentSettings(input.storageDirectory), await activeSession(input))
          : previous.generators.find((choice) => choice.toolName === generator.toolName && choice.signature === generator.signature);
        if (generator.kind === "model" ? !current || !("configurationFingerprint" in current) || current.configurationFingerprint !== generator.configurationFingerprint
          : !generatorCatalogCurrent || !current) { stale = true; staleReason = "generator_changed"; }
      } catch { throwIfAborted(input.signal); stale = true; staleReason = "unavailable"; }
    }
  }
  const { buffer: _previous, staleReason: _reason, ...base } = previous;
  return { ...base, ...(buffer ? { buffer } : {}), stale, ...(staleReason ? { staleReason } : {}),
    ...(generatorCatalogCurrent ? {} : { generators: [] }) };
}

export async function runMidiContinuationCommand(command: Exclude<MidiContinuationCommand, { kind: "import_midi_continuation" }>, input: Dependencies): Promise<MidiContinuationView> {
  const session = await activeSession(input);
  const settings = await loadAgentSettings(input.storageDirectory);
  const createTools = (extra: Partial<Parameters<typeof createRequestPluginTools>[0]> = {}) => createRequestPluginTools({
    storageDirectory: input.storageDirectory, sessionId: input.sessionId, signal: input.signal,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}), withAuthorization: input.withPluginAuthorization, ...extra,
  });
  let tools: RequestPluginTools | undefined;
  let releaseModel: (() => void) | undefined;
  try {
    if (command.kind === "load_midi_continuation") tools = await createTools();
    if (command.kind === "configure_midi_continuation") {
      let generator: MidiContinuationGenerator;
      if (command.generator.kind === "model") {
        const acquired = await input.acquireModel(session, settings); releaseModel = acquired.release;
        if (!acquired.runtimeProfile.capabilities.tools) throw new Error("The current model must support tool calls to save MIDI.");
        generator = midiModelGenerator(settings, session);
      } else {
        tools = await createTools();
        const selected = command.generator;
        const choice = midiContinuationGenerators(tools).find((entry) => entry.toolName === selected.toolName && entry.signature === selected.signature);
        if (!choice) throw new Error("Choose a current, approved MIDI conditioning tool.");
        validatePluginParameters(choice.panel, { ...selected.arguments, [choice.inputArgument]: "midi-context", [choice.lengthArgument]: command.segmentBeats });
        generator = { kind: "plugin", toolName: choice.toolName, signature: choice.signature, inputArgument: choice.inputArgument, lengthArgument: choice.lengthArgument, arguments: selected.arguments };
      }
      await configureMidiContinuation({ ...input, ...command, generator });
    }
    if (command.kind === "fill_midi_continuation") {
      const buffer = await readMidiContinuation(input.storageDirectory, input.sessionId, input.signal);
      if (!buffer || buffer.id !== command.bufferId) throw new Error("Reload the current MIDI buffer before filling.");
      let model: Awaited<ReturnType<Dependencies["acquireModel"]>> | undefined;
      const beforeCommit = () => assertMidiContinuationSource(input.context, buffer, input.signal);
      const beforeSave = async (bytes: Uint8Array) => {
        await activeSession(input); beforeCommit();
        assertMidiContinuationOutput(bytes, buffer.segmentBeats, input.signal);
        if (buffer.generator.kind === "plugin") {
          const source = await readMidiArtifact(input.storageDirectory, input.sessionId, buffer.sourceArtifactRef, input.signal);
          const next = parseMidiArtifact(bytes, input.signal);
          if (next.parts.length + source.parsed.parts.length > MAX_MIDI_ARTIFACT_TRACKS) {
            throw new Error("The original context and next section must fit the MIDI conditioning file's 32-track budget.");
          }
          if (next.notes.length + source.parsed.notes.length > MAX_MIDI_ARTIFACT_NOTES) {
            throw new Error("The original context and next section must fit the MIDI conditioning file's 4096-note budget.");
          }
        }
      };
      if (buffer.generator.kind === "model") { model = await input.acquireModel(session, settings); releaseModel = model.release; }
      else tools = await createTools({ midiOutputPolicy: { validate: beforeSave, beforeCommit, generationKind: "continuation" } });
      const validateGenerator = async (generator: MidiContinuationGenerator) => {
        if (generator.kind === "model") {
          const current = midiModelGenerator(await loadAgentSettings(input.storageDirectory), await activeSession(input));
          if (current.configurationFingerprint !== generator.configurationFingerprint) throw new Error("The selected model Profile changed. Configure the MIDI buffer again.");
        } else {
          const choice = midiContinuationGenerators(tools!).find((entry) => entry.toolName === generator.toolName && entry.signature === generator.signature);
          if (!choice) throw new Error("The MIDI generator changed. Configure the buffer again.");
          await tools!.assertToolCurrent(generator.toolName);
        }
      };
      await fillMidiContinuation({ ...input, bufferId: buffer.id, validateGenerator, onProgress: input.onProgress,
        generate: (current, onEvent) => model ? generateMidiContinuationWithModel({
          storageDirectory: input.storageDirectory, buffer: current, runtimeProfile: model.runtimeProfile, requestTurn: model.requestTurn,
          readTools: createSessionMidiArtifactToolset({ storageDirectory: input.storageDirectory, sessionId: input.sessionId, signal: input.signal }),
          signal: input.signal, ...(session.creativeBrief ? { creativeBrief: session.creativeBrief } : {}),
          beforeSave, beforeCommit, onEvent, onProgress: input.onProgress,
        }) : generateMidiContinuationWithPlugin({ storageDirectory: input.storageDirectory, buffer: current, tools: tools!, signal: input.signal, beforeCommit, onEvent }),
      });
    }
    const clips = observeMidiContinuationClips(input.context);
    const view: MidiContinuationView = { sessionId: input.sessionId, clips: clips.slice(0, 256), clipsTruncated: clips.length > 256,
      generators: tools ? midiContinuationGenerators(tools) : [], stale: false };
    return refreshMidiContinuationView(input, view);
  } finally { releaseModel?.(); await tools?.close(); }
}

export async function midiContinuationImportHooks(command: Omit<MidiArtifactImportCommand, "kind"> & { bufferId: string }, input: Runtime): Promise<{
  validateSource(): void; onApplied(): Promise<void>;
}> {
  await activeSession(input);
  const buffer = await readMidiContinuation(input.storageDirectory, input.sessionId, input.signal);
  if (!buffer || buffer.id !== command.bufferId || buffer.queue[0]?.artifactRef !== command.artifactRef) throw new Error("Choose the current MIDI buffer's first section for import.");
  const validateSource = () => {
    const snapshot = assertMidiContinuationSource(input.context, buffer, input.signal);
    const destinations = new Set(command.mappings?.map((mapping) => mapping.trackId) ?? (command.trackId ? [command.trackId]
      : input.context.application.song.tracks.filter((track) => track.name.trim().toLowerCase() === command.trackName?.trim().toLowerCase()).map((track) => String(track.handle.id))));
    for (const source of snapshot.ranges) {
      if (source.location === "arrangement" && destinations.has(source.trackId) && command.startBeat < source.startBeat + source.durationBeats && command.startBeat + buffer.segmentBeats > source.startBeat) {
        throw new Error("Place the continuation outside its source clips so their musical context stays unchanged.");
      }
    }
  };
  validateSource();
  return { validateSource, onApplied: () => consumeMidiContinuation({ ...input, ...command }) };
}
