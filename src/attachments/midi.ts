import { TextDecoder } from "node:util";

import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import { AttachmentProcessingError, MAX_MIDI_ATTACHMENT_BYTES } from "./contracts.js";
import { BoundedDocumentTextBuilder, type ExtractedDocumentText } from "./document-text.js";

export const MAX_MIDI_ATTACHMENT_TRACKS = 256;
export const MAX_STANDARD_MIDI_EVENTS = 200_000;
export const MAX_MIDI_ATTACHMENT_NOTES = 100_000;
const MAX_TEXT_EVENT_BYTES = 4 * 1024;
const MAX_RETAINED_TEXT_BYTES = 256 * 1024;
const CHECKPOINT_INTERVAL = 1024;

interface EventPosition { tick: number; beat: number }

/** Channels use 1–16, pitches and programs use their MIDI 0–127 values. */
export interface StandardMidiNote {
  type: "note";
  channel: number;
  pitch: number;
  startTick: number;
  startBeat: number;
  durationTicks: number | null;
  durationBeats: number | null;
  velocity: number;
  releaseVelocity?: number;
}

export type StandardMidiEvent = StandardMidiNote | EventPosition & (
  | { type: "program_change"; channel: number; program: number }
  | { type: "control_change"; channel: number; controller: number; value: number }
  | { type: "pitch_bend"; channel: number; value14Bit: number; signedValue: number }
  | { type: "poly_pressure"; channel: number; pitch: number; pressure: number }
  | { type: "channel_pressure"; channel: number; pressure: number }
  | { type: "unmatched_note_off"; channel: number; pitch: number; velocity: number }
  | { type: "tempo"; microsecondsPerQuarterNote: number; bpm: number }
  | { type: "time_signature"; numerator: number; denominator: number;
      denominatorPower: number; clocksPerMetronomeClick: number; thirtySecondNotesPerQuarter: number }
  | { type: "key_signature"; sharpsOrFlats: number; mode: "major" | "minor" }
  | { type: "sequence_number"; sequenceNumber: number }
  | { type: "channel_prefix"; channel: number }
  | { type: "midi_port"; port: number }
  | { type: "text"; textKind: string; text: string; encoding: "utf-8" | "latin1"; truncated: boolean }
  | { type: "meta"; metaType: number; byteLength: number }
  | { type: "sysex"; status: number; byteLength: number }
);

export interface StandardMidiTrack {
  index: number;
  name?: string;
  instrumentName?: string;
  channels: number[];
  durationTicks: number;
  durationBeats: number;
  eventCount: number;
  unmatchedNoteOffCount: number;
  unfinishedNoteCount: number;
  notes: StandardMidiNote[];
  events: StandardMidiEvent[];
}

export interface ParsedStandardMidi {
  format: 0 | 1 | 2;
  trackCount: number;
  ticksPerQuarterNote: number;
  durationBeats: number;
  eventCount: number;
  noteCount: number;
  metadataTruncated: boolean;
  tracks: StandardMidiTrack[];
}

export interface StandardMidiParseOptions {
  purpose?: "attachment" | "artifact";
  signal?: AbortSignal;
}

/** The two callers share SMF decoding; artifacts retain stricter admission limits. */
export function parseStandardMidi(
  bytes: Uint8Array,
  options: StandardMidiParseOptions = {},
): ParsedStandardMidi {
  const parser = parseFile(bytes, options);
  let result = parser.next();
  while (!result.done) result = parser.next();
  return result.value;
}

export async function extractMidiText(input: {
  bytes: Uint8Array;
  signal?: AbortSignal;
}): Promise<ExtractedDocumentText> {
  const parser = parseFile(input.bytes, {
    ...(input.signal ? { signal: input.signal } : {}),
  });
  let result = parser.next();
  while (!result.done) {
    await yieldToHost(input.signal);
    result = parser.next();
  }
  const midi = result.value;
  const builder = new BoundedDocumentTextBuilder();
  let detailTruncated = false;
  let emittedEvents = 0;
  const channelCount = new Set(midi.tracks.flatMap((track) => track.channels)).size;
  const summary = (truncated: boolean, representedSemanticEventCount: number): object => ({
    type: "extraction_summary", truncated, trackCount: midi.trackCount, channelCount,
    totalNoteCount: midi.noteCount, totalEventCount: midi.eventCount, representedSemanticEventCount,
  });
  const summaryReserve = JSON.stringify(summary(false, MAX_STANDARD_MIDI_EVENTS)).length + 1;
  const append = (value: object): boolean => {
    const line = JSON.stringify(value);
    // Keep JSON records complete, including escaped untrusted metadata.
    if ([...line].length + 1 > builder.maxCharacters - builder.characterCount - summaryReserve) {
      detailTruncated = true;
      return false;
    }
    return builder.appendLine(line);
  };
  append({
    type: "standard_midi",
    format: midi.format,
    timeline: midi.format === 2 ? "independent track sequences" : "simultaneous tracks",
    timing: "PPQN",
    ticksPerQuarterNote: midi.ticksPerQuarterNote,
    beatUnit: "quarter note",
    channelNumbering: "1-16",
    pitchAndProgramNumbering: "0-127",
    defaultTempoBpm: 120,
    defaultTimeSignature: [4, 4],
    noteDurationMeaning: "note-on to matching note-off; sustain/control events remain separate; null means no matching note-off",
    trackCount: midi.trackCount,
    channelCount,
    totalNoteCount: midi.noteCount,
    totalEventCount: midi.eventCount,
    maximumTrackDurationBeats: midi.durationBeats,
    metadataTruncated: midi.metadataTruncated,
    sysexAndUnknownMetaPayloads: "not included; event type and byte length are retained",
  });
  // Summaries of every track precede detail so truncation preserves track boundaries.
  for (const track of midi.tracks) {
    throwIfAborted(input.signal);
    append({
      type: "track",
      trackIndex: track.index + 1,
      channels: track.channels,
      durationBeats: track.durationBeats,
      noteCount: track.notes.length,
      eventCount: track.eventCount,
      unmatchedNoteOffCount: track.unmatchedNoteOffCount,
      unfinishedNoteCount: track.unfinishedNoteCount,
    });
  }
  // Visit one event from each track per pass to retain parts from multiple tracks.
  const longestTrack = Math.max(...midi.tracks.map((track) => track.events.length));
  detail: for (let eventIndex = 0; eventIndex < longestTrack; eventIndex++) {
    for (const track of midi.tracks) {
      const event = track.events[eventIndex];
      if (!event) continue;
      if (!append({ trackIndex: track.index + 1, ...event })) break detail;
      if (++emittedEvents % CHECKPOINT_INTERVAL === 0) await yieldToHost(input.signal);
    }
  }
  throwIfAborted(input.signal);
  builder.appendLine(JSON.stringify(summary(detailTruncated || midi.metadataTruncated, emittedEvents)));
  const extracted = builder.finish();
  return {
    text: extracted.text,
    truncated: extracted.truncated || detailTruncated || midi.metadataTruncated,
  };
}

interface ParseState {
  eventCount: number;
  noteCount: number;
  retainedTextBytes: number;
  metadataTruncated: boolean;
  noteLimit: number;
  signal?: AbortSignal;
}

function* parseFile(
  bytes: Uint8Array,
  options: StandardMidiParseOptions,
): Generator<void, ParsedStandardMidi> {
  throwIfAborted(options.signal);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22 || bytes.byteLength > MAX_MIDI_ATTACHMENT_BYTES) {
    throw invalidMidi("MIDI attachments must be valid Standard MIDI Files of at most 8 MiB.");
  }
  const artifact = options.purpose === "artifact";
  const cursor = new MidiCursor(bytes);
  if (cursor.ascii(4) !== "MThd") throw invalidMidi();
  const headerLength = cursor.uint32();
  if (headerLength < 6 || artifact && headerLength !== 6) throw invalidMidi();
  const header = new MidiCursor(cursor.slice(headerLength));
  const format = header.uint16();
  const trackCount = header.uint16();
  const division = header.uint16();
  const trackLimit = artifact ? 32 : MAX_MIDI_ATTACHMENT_TRACKS;
  if ((format !== 0 && format !== 1 && (artifact || format !== 2)) ||
      trackCount < 1 || trackCount > trackLimit || format === 0 && trackCount !== 1) {
    throw invalidMidi();
  }
  if (division === 0 || (division & 0x8000) !== 0) {
    throw invalidMidi("MIDI attachments require PPQN timing; SMPTE time division is not supported.");
  }
  const state: ParseState = {
    eventCount: 0,
    noteCount: 0,
    retainedTextBytes: 0,
    metadataTruncated: false,
    noteLimit: artifact ? 4096 : MAX_MIDI_ATTACHMENT_NOTES,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const tracks: StandardMidiTrack[] = [];
  for (let index = 0; index < trackCount; index++) {
    if (cursor.ascii(4) !== "MTrk") throw invalidMidi();
    const track = yield* parseTrack(cursor.slice(cursor.uint32()), index, division, state);
    tracks.push(track);
  }
  if (!cursor.done()) throw invalidMidi();
  throwIfAborted(options.signal);
  return {
    format: format as 0 | 1 | 2,
    trackCount,
    ticksPerQuarterNote: division,
    durationBeats: Math.max(...tracks.map((track) => track.durationBeats)),
    eventCount: state.eventCount,
    noteCount: state.noteCount,
    metadataTruncated: state.metadataTruncated,
    tracks,
  };
}

function* parseTrack(
  bytes: Uint8Array,
  index: number,
  division: number,
  state: ParseState,
): Generator<void, StandardMidiTrack> {
  const cursor = new MidiCursor(bytes);
  const active = new Map<number, { entries: StandardMidiNote[]; head: number }>();
  const channels = new Set<number>();
  const track: StandardMidiTrack = {
    index, channels: [], durationTicks: 0, durationBeats: 0,
    eventCount: 0, unmatchedNoteOffCount: 0, unfinishedNoteCount: 0, notes: [], events: [],
  };
  let tick = 0;
  let activeCount = 0;
  let runningStatus: number | undefined;
  let ended = false;
  while (!cursor.done()) {
    if (++state.eventCount > MAX_STANDARD_MIDI_EVENTS) {
      throw invalidMidi("MIDI files may contain at most 200,000 events.");
    }
    track.eventCount++;
    if (state.eventCount % CHECKPOINT_INTERVAL === 0) {
      throwIfAborted(state.signal);
      yield;
    }
    tick += cursor.variableLength();
    if (!Number.isSafeInteger(tick)) throw invalidMidi();
    let status: number;
    if (cursor.peek() < 0x80) {
      if (runningStatus === undefined) throw invalidMidi();
      status = runningStatus;
    } else {
      status = cursor.uint8();
      runningStatus = status <= 0xef ? status : undefined;
    }
    const position = { tick, beat: tick / division };
    if (status >= 0x80 && status <= 0xef) {
      const type = status & 0xf0;
      const channel = (status & 0x0f) + 1;
      const first = cursor.dataByte();
      const second = type === 0xc0 || type === 0xd0 ? 0 : cursor.dataByte();
      channels.add(channel);
      if (type === 0x80 || type === 0x90) {
        const key = (channel - 1) * 128 + first;
        if (type === 0x90 && second > 0) {
          if (++state.noteCount > state.noteLimit || ++activeCount > state.noteLimit) throw invalidMidi();
          const note: StandardMidiNote = {
            type: "note", channel, pitch: first, startTick: tick, startBeat: position.beat,
            durationTicks: null, durationBeats: null, velocity: second,
          };
          const queue = active.get(key) ?? { entries: [], head: 0 };
          queue.entries.push(note);
          active.set(key, queue);
          track.events.push(note);
        } else {
          const releaseVelocity = type === 0x90 ? 64 : second;
          const queue = active.get(key);
          const note = queue?.entries[queue.head++];
          if (note) {
            activeCount--;
            note.durationTicks = tick - note.startTick;
            note.durationBeats = note.durationTicks / division;
            note.releaseVelocity = releaseVelocity;
            track.notes.push(note);
            if (queue!.head === queue!.entries.length) active.delete(key);
          } else {
            track.unmatchedNoteOffCount++;
            track.events.push({ type: "unmatched_note_off", ...position, channel, pitch: first, velocity: releaseVelocity });
          }
        }
      } else if (type === 0xc0) {
        track.events.push({ type: "program_change", ...position, channel, program: first });
      } else if (type === 0xb0) {
        track.events.push({ type: "control_change", ...position, channel, controller: first, value: second });
      } else if (type === 0xe0) {
        const value14Bit = first + second * 128;
        track.events.push({ type: "pitch_bend", ...position, channel, value14Bit, signedValue: value14Bit - 8192 });
      } else if (type === 0xa0) {
        track.events.push({ type: "poly_pressure", ...position, channel, pitch: first, pressure: second });
      } else if (type === 0xd0) {
        track.events.push({ type: "channel_pressure", ...position, channel, pressure: first });
      }
    } else if (status === 0xff) {
      const metaType = cursor.dataByte();
      const data = cursor.slice(cursor.variableLength());
      if (metaType === 0x2f) {
        if (data.byteLength !== 0 || !cursor.done()) throw invalidMidi();
        ended = true;
        break;
      }
      const event = parseMeta(metaType, data, position, state);
      if (event.type === "text" && event.textKind === "track_name" && track.name === undefined) {
        track.name = event.text;
      }
      if (event.type === "text" && event.textKind === "instrument_name" && track.instrumentName === undefined) {
        track.instrumentName = event.text;
      }
      track.events.push(event);
    } else if (status === 0xf0 || status === 0xf7) {
      const byteLength = cursor.variableLength();
      cursor.skip(byteLength);
      track.events.push({ type: "sysex", ...position, status, byteLength });
    } else {
      throw invalidMidi();
    }
  }
  if (!ended) throw invalidMidi();
  track.durationTicks = tick;
  track.durationBeats = tick / division;
  track.channels = [...channels].sort((left, right) => left - right);
  track.unfinishedNoteCount = activeCount;
  for (const queue of active.values()) {
    for (let pending = queue.head; pending < queue.entries.length; pending++) {
      track.notes.push(queue.entries[pending]!);
    }
  }
  return track;
}

const textKinds: Readonly<Record<number, string>> = {
  0x01: "text", 0x02: "copyright", 0x03: "track_name", 0x04: "instrument_name",
  0x05: "lyric", 0x06: "marker", 0x07: "cue", 0x08: "program_name", 0x09: "device_name",
};

function parseMeta(
  metaType: number,
  data: Uint8Array,
  position: EventPosition,
  state: ParseState,
): StandardMidiEvent {
  const requireLength = (length: number): void => {
    if (data.byteLength < length) throw invalidMidi();
  };
  const textKind = textKinds[metaType];
  if (textKind) {
    const retained = data.subarray(0, Math.min(MAX_TEXT_EVENT_BYTES, MAX_RETAINED_TEXT_BYTES - state.retainedTextBytes));
    state.retainedTextBytes += retained.byteLength;
    const truncated = retained.byteLength < data.byteLength;
    state.metadataTruncated ||= truncated;
    let text: string;
    let encoding: "utf-8" | "latin1" = "utf-8";
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(retained, { stream: truncated }); }
    catch { text = new TextDecoder("latin1").decode(retained); encoding = "latin1"; }
    return { type: "text", ...position, textKind, text, encoding, truncated };
  }
  if (metaType === 0x51) {
    requireLength(3);
    const microsecondsPerQuarterNote = data[0]! * 65536 + data[1]! * 256 + data[2]!;
    if (microsecondsPerQuarterNote === 0) throw invalidMidi();
    return { type: "tempo", ...position, microsecondsPerQuarterNote, bpm: 60_000_000 / microsecondsPerQuarterNote };
  }
  if (metaType === 0x58) {
    requireLength(4);
    if (data[0] === 0) throw invalidMidi();
    return { type: "time_signature", ...position, numerator: data[0]!, denominator: 2 ** data[1]!,
      denominatorPower: data[1]!, clocksPerMetronomeClick: data[2]!, thirtySecondNotesPerQuarter: data[3]! };
  }
  if (metaType === 0x59) {
    requireLength(2);
    const sharpsOrFlats = data[0]! > 127 ? data[0]! - 256 : data[0]!;
    if (sharpsOrFlats < -7 || sharpsOrFlats > 7 || data[1]! > 1) throw invalidMidi();
    return { type: "key_signature", ...position, sharpsOrFlats, mode: data[1] === 0 ? "major" : "minor" };
  }
  if (metaType === 0x00) {
    requireLength(2);
    return { type: "sequence_number", ...position, sequenceNumber: data[0]! * 256 + data[1]! };
  }
  if (metaType === 0x20 || metaType === 0x21) {
    requireLength(1);
    if (metaType === 0x20 && data[0]! > 15) throw invalidMidi();
    return metaType === 0x20
      ? { type: "channel_prefix", ...position, channel: data[0]! + 1 }
      : { type: "midi_port", ...position, port: data[0]! };
  }
  return { type: "meta", ...position, metaType, byteLength: data.byteLength };
}

class MidiCursor {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  done(): boolean { return this.offset === this.bytes.byteLength; }
  peek(): number { this.require(1); return this.bytes[this.offset]!; }
  uint8(): number { this.require(1); return this.bytes[this.offset++]!; }
  dataByte(): number { const byte = this.uint8(); if (byte >= 0x80) throw invalidMidi(); return byte; }
  uint16(): number { const high = this.uint8(); return high * 256 + this.uint8(); }
  uint32(): number { return this.uint16() * 65536 + this.uint16(); }
  ascii(length: number): string { return String.fromCharCode(...this.slice(length)); }
  slice(length: number): Uint8Array {
    this.require(length);
    const data = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return data;
  }
  skip(length: number): void { this.require(length); this.offset += length; }
  variableLength(): number {
    let value = 0;
    for (let index = 0; index < 4; index++) {
      const byte = this.uint8();
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw invalidMidi();
  }
  private require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.byteLength) throw invalidMidi();
  }
}

function invalidMidi(message = "The attachment is not a supported bounded Standard MIDI File."): AttachmentProcessingError {
  return new AttachmentProcessingError("invalid_midi", message);
}
