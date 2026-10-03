import { uiMessage, type UiMessage } from "../../i18n/ui-message.js";
import type { ExtensionContext } from "@ableton-extensions/sdk";
import type { AgentLoopTraceEvent } from "../../agent/loop.js";
import type { MidiContinuationBuffer, MidiContinuationGenerator, MidiContinuationClipRef } from "../../agent/midi-continuation-contracts.js";
import { writeStandardMidi } from "../../attachments/midi-writer.js";
import { cloneJsonValue } from "../../model/json-clone.js";
import { throwIfAborted } from "../../runtime/host.js";
import { appendSessionEvent, type SessionEventInput } from "../../storage/events.js";
import { createStorageId } from "../../storage/id.js";
import { readMidiArtifact, readMidiContinuation, saveMidiArtifact, saveMidiContinuation, parseMidiArtifact, type MidiArtifact } from "../../storage/midi-artifacts.js";
import { listSessions } from "../../storage/sessions.js";
import { captureMidiContinuationContext } from "./midi-continuation-context.js";

type Runtime = { context: ExtensionContext<"1.0.0">; storageDirectory: string | undefined; sessionId: string; projectKey: string; signal: AbortSignal };

export function assertMidiContinuationSource(context: Runtime["context"], buffer: MidiContinuationBuffer, signal: AbortSignal): ReturnType<typeof captureMidiContinuationContext> {
  throwIfAborted(signal);
  const snapshot = captureMidiContinuationContext(context, buffer.sourceClips, signal);
  if (snapshot.fingerprint !== buffer.sourceFingerprint) {
    throw new Error("The source MIDI notes, clip timing or Live tempo changed. Observe the sources again before continuing.");
  }
  return snapshot;
}

async function requireActiveSession(input: Runtime): Promise<void> {
  if (!(await listSessions(input.storageDirectory, input.projectKey)).some((session) => session.id === input.sessionId && !session.archivedAt)) {
    throw new Error("The owning MIDI continuation Session is no longer available.");
  }
  throwIfAborted(input.signal);
}

/** Configuration replaces only the buffer record; previously saved artifacts remain available. */
export async function configureMidiContinuation(input: Runtime & {
  expectedBufferId: string | null; sourceClips: MidiContinuationClipRef[]; segmentBeats: number;
  capacity: number; generator: MidiContinuationGenerator; prompt: string;
}): Promise<MidiContinuationBuffer> {
  await requireActiveSession(input);
  const previous = await readMidiContinuation(input.storageDirectory, input.sessionId, input.signal);
  if ((previous?.id ?? null) !== input.expectedBufferId) throw new Error("The MIDI buffer changed in another window. Reload before configuring it.");
  const snapshot = captureMidiContinuationContext(input.context, input.sourceClips, input.signal);
  const bytes = writeStandardMidi({ tracks: snapshot.tracks, durationBeats: snapshot.durationBeats, signal: input.signal });
  const current = () => {
    throwIfAborted(input.signal);
    if (captureMidiContinuationContext(input.context, input.sourceClips, input.signal).fingerprint !== snapshot.fingerprint) {
      throw new Error("The MIDI sources changed while being captured. Observe them again.");
    }
  };
  const source = await saveMidiArtifact(input.storageDirectory, input.sessionId, {
    source: { kind: "host", operation: "live-midi-context" }, serverId: "host", toolName: "observe_midi_continuation",
    label: "Live MIDI context", bytes, signal: input.signal, beforeCommit: current,
  });
  current();
  const buffer: MidiContinuationBuffer = {
    id: createStorageId("midibuffer"), sessionId: input.sessionId, sourceArtifactRef: source.id,
    sourceFingerprint: snapshot.fingerprint, sourceClips: input.sourceClips.map((ref) => ({ ...ref })),
    segmentBeats: input.segmentBeats, capacity: input.capacity, insertBeat: snapshot.insertBeat,
    nextSequence: 0, consumedCount: 0, queue: [], generator: cloneJsonValue(input.generator), prompt: input.prompt,
    updatedAt: new Date().toISOString(),
  };
  await saveMidiContinuation(input.storageDirectory, input.sessionId, buffer, input.signal);
  return buffer;
}

export function assertMidiContinuationOutput(bytes: Uint8Array, segmentBeats: number, signal: AbortSignal): void {
  const parsed = parseMidiArtifact(bytes, signal);
  if (Math.abs(parsed.durationBeats - segmentBeats) > 1 / parsed.ticksPerQuarterNote) {
    throw new Error(`The generator returned ${parsed.durationBeats} beats; the configured section length is ${segmentBeats} beats.`);
  }
}

/** The caller holds the Session send fence. Fill creates only the currently vacant ordered slots. */
export async function fillMidiContinuation(input: Runtime & {
  bufferId: string;
  validateGenerator(generator: MidiContinuationGenerator): Promise<void>;
  generate(buffer: MidiContinuationBuffer, record: (event: AgentLoopTraceEvent) => Promise<void>): Promise<MidiArtifact>;
  onProgress(message: UiMessage): Promise<void>;
}): Promise<MidiContinuationBuffer> {
  await requireActiveSession(input);
  let buffer = await readMidiContinuation(input.storageDirectory, input.sessionId, input.signal);
  if (!buffer || buffer.id !== input.bufferId) throw new Error("The MIDI buffer changed. Reload it before filling.");
  assertMidiContinuationSource(input.context, buffer, input.signal);
  await input.validateGenerator(buffer.generator);
  const request = await appendSessionEvent(input.storageDirectory, input.sessionId, { kind: "tool_call", name: "fill_midi_continuation",
    content: JSON.stringify({ bufferId: buffer.id, segmentBeats: buffer.segmentBeats, capacity: buffer.capacity, sourceArtifactRef: buffer.sourceArtifactRef, prompt: buffer.prompt }) });
  try {
    while (buffer.queue.length < buffer.capacity) {
      await requireActiveSession(input);
      assertMidiContinuationSource(input.context, buffer, input.signal);
      await input.validateGenerator(buffer.generator);
      const parentCandidate = { kind: "midi" as const, id: buffer.queue.at(-1)?.artifactRef ?? buffer.lastArtifactRef ?? buffer.sourceArtifactRef };
      const record = async (event: AgentLoopTraceEvent) => {
        const record = { ...event, ...(event.kind === "tool_call" ? { parentCandidate, requestEventId: request.id } : {}) } as SessionEventInput;
        await appendSessionEvent(input.storageDirectory, input.sessionId, record);
      };
      await input.onProgress(uiMessage("Generating MIDI section {section} ({count}/{capacity})", { section: String(buffer.nextSequence + 1), count: String(buffer.queue.length + 1), capacity: String(buffer.capacity) }));
      const artifact = await input.generate(cloneJsonValue(buffer), record);
      await requireActiveSession(input);
      assertMidiContinuationSource(input.context, buffer, input.signal);
      await input.validateGenerator(buffer.generator);
      const saved = await readMidiArtifact(input.storageDirectory, input.sessionId, artifact.id, input.signal);
      assertMidiContinuationOutput(saved.bytes, buffer.segmentBeats, input.signal);
      buffer = { ...buffer, nextSequence: buffer.nextSequence + 1, lastArtifactRef: artifact.id,
        queue: [...buffer.queue, { artifactRef: artifact.id, sequence: buffer.nextSequence, label: artifact.label, noteCount: artifact.noteCount }],
        updatedAt: new Date().toISOString() };
      await saveMidiContinuation(input.storageDirectory, input.sessionId, buffer, input.signal);
    }
    await appendSessionEvent(input.storageDirectory, input.sessionId, { kind: "tool_result", name: "fill_midi_continuation",
      content: JSON.stringify({ status: "completed", bufferId: buffer.id, queuedSections: buffer.queue.length }) });
    return buffer;
  } catch (error) {
    await appendSessionEvent(input.storageDirectory, input.sessionId, { kind: "tool_result", name: "fill_midi_continuation",
      content: JSON.stringify({ status: input.signal.aborted ? "cancelled" : "failed", bufferId: buffer.id,
        message: "Existing saved MIDI artifacts were retained." }) }).catch(() => {});
    throw error;
  }
}

/** Called only after confirmed Live execution succeeds, inside the import's recovery boundary. */
export async function consumeMidiContinuation(input: Runtime & { bufferId: string; artifactRef: string; startBeat: number }): Promise<void> {
  const buffer = await readMidiContinuation(input.storageDirectory, input.sessionId, input.signal);
  if (!buffer || buffer.id !== input.bufferId || buffer.queue[0]?.artifactRef !== input.artifactRef) {
    throw new Error("The MIDI buffer head changed while importing. Inspect Live before continuing.");
  }
  await saveMidiContinuation(input.storageDirectory, input.sessionId, { ...buffer,
    insertBeat: input.startBeat - buffer.consumedCount * buffer.segmentBeats,
    consumedCount: buffer.consumedCount + 1, queue: buffer.queue.slice(1), updatedAt: new Date().toISOString(),
  }, input.signal);
}
