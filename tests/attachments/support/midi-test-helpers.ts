import { Buffer } from "node:buffer";

export function midiBytes(input: {
  tracks: readonly (readonly number[] | Uint8Array)[];
  format?: number;
  division?: number;
  headerExtra?: readonly number[];
  trailing?: readonly number[];
}): Uint8Array {
  const extra = input.headerExtra ?? [];
  const division = input.division ?? 480;
  const pieces: Uint8Array[] = [Uint8Array.from([
    ...ascii("MThd"), ...uint32(6 + extra.length),
    0, input.format ?? (input.tracks.length === 1 ? 0 : 1),
    input.tracks.length >> 8, input.tracks.length & 255,
    division >> 8, division & 255, ...extra,
  ])];
  for (const track of input.tracks) {
    pieces.push(Uint8Array.from([...ascii("MTrk"), ...uint32(track.length)]), Uint8Array.from(track));
  }
  pieces.push(Uint8Array.from(input.trailing ?? []));
  const bytes = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
  let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
  return bytes;
}

export function event(delta: number, ...bytes: number[]): number[] {
  return [...variableLength(delta), ...bytes];
}

export function meta(delta: number, type: number, bytes: readonly number[]): number[] {
  return [...event(delta, 0xff, type), ...variableLength(bytes.length), ...bytes];
}

export function midiText(delta: number, type: number, value: string): number[] {
  return meta(delta, type, [...Buffer.from(value)]);
}

export function endTrack(delta = 0): number[] { return event(delta, 0xff, 0x2f, 0); }

export function noteTrack(input: {
  pitch?: number;
  channel?: number;
  velocity?: number;
  startTicks?: number;
  durationTicks?: number;
} = {}): number[] {
  const pitch = input.pitch ?? 60;
  const channel = (input.channel ?? 1) - 1;
  return [
    ...event(input.startTicks ?? 0, 0x90 + channel, pitch, input.velocity ?? 96),
    ...event(input.durationTicks ?? 480, 0x80 + channel, pitch, 64),
    ...endTrack(),
  ];
}

export function sequentialNotes(count: number, pitch = 60): number[] {
  const track: number[] = [];
  for (let index = 0; index < count; index++) {
    track.push(...event(0, 0x90, pitch, 100), ...event(1, 0x80, pitch, 0));
  }
  track.push(...endTrack());
  return track;
}

export function variableLength(value: number): number[] {
  const bytes = [value & 0x7f];
  for (let remaining = value >>> 7; remaining; remaining >>>= 7) bytes.unshift((remaining & 0x7f) | 0x80);
  return bytes;
}

export function uint32(value: number): number[] {
  return [value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255];
}

function ascii(value: string): number[] { return [...value].map((character) => character.charCodeAt(0)); }
