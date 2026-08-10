import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import {
  AttachmentProcessingError,
  MAX_AUDIO_ATTACHMENT_BYTES,
  MAX_AUDIO_DURATION_SECONDS,
} from "./contracts.js";

export type AudioAttachmentMediaType = "audio/wav" | "audio/mpeg";

export interface AudioAttachmentInspection {
  mediaType: AudioAttachmentMediaType;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
}

const scanYieldBytes = 256 * 1024;
const minimumWaveSampleRate = 8_000;
const maximumWaveSampleRate = 192_000;
const maximumWaveChannels = 8;
export const MAX_AUDIO_ID3V2_PAYLOAD_BYTES = 1024 * 1024;

export function isAudioAttachmentInspection(
  value: unknown,
): value is AudioAttachmentInspection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.mediaType === "audio/wav" || record.mediaType === "audio/mpeg"
  ) &&
    typeof record.durationSeconds === "number" &&
    Number.isFinite(record.durationSeconds) &&
    record.durationSeconds > 0 &&
    record.durationSeconds <= MAX_AUDIO_DURATION_SECONDS &&
    Number.isInteger(record.sampleRate) &&
    (
      record.mediaType === "audio/mpeg"
        ? supportedMp3SampleRates.has(record.sampleRate as number)
        : (record.sampleRate as number) >= minimumWaveSampleRate &&
          (record.sampleRate as number) <= maximumWaveSampleRate
    ) &&
    Number.isInteger(record.channels) &&
    (record.channels as number) >= 1 &&
    (record.channels as number) <= (
      record.mediaType === "audio/mpeg" ? 2 : maximumWaveChannels
    );
}

/**
 * Returns only whether bytes have an audio container/frame prefix worth strict
 * inspection. It never trusts a filename or claimed media type.
 */
export function isAudioAttachmentCandidate(bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array)) return false;
  return (
    bytes.byteLength >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WAVE"
  ) || (
    bytes.byteLength >= 3 && ascii(bytes, 0, 3) === "ID3"
  ) || (
    bytes.byteLength >= 2 &&
    bytes[0] === 0xff &&
    (bytes[1]! & 0xe0) === 0xe0
  );
}

/**
 * Strictly inspects owned WAV/MP3 bytes and returns bounded technical facts.
 * Embedded metadata is neither parsed nor returned; the original bytes remain
 * unchanged and must continue to be treated as untrusted attachment content.
 */
export async function inspectAudioAttachment(input: {
  bytes: Uint8Array;
  signal?: AbortSignal;
}): Promise<AudioAttachmentInspection> {
  throwIfAborted(input.signal);
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw invalidAudio();
  }
  if (input.bytes.byteLength > MAX_AUDIO_ATTACHMENT_BYTES) {
    throw new AttachmentProcessingError(
      "archive_limit",
      "Audio attachments may not exceed 20 MiB.",
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(input.bytes);
  } catch {
    throw invalidAudio();
  }
  await yieldToHost(input.signal);

  try {
    const inspection = isWave(bytes)
      ? await inspectWave(bytes, input.signal)
      : await inspectMp3(bytes, input.signal);
    throwIfAborted(input.signal);
    if (inspection.durationSeconds > MAX_AUDIO_DURATION_SECONDS) {
      throw new AttachmentProcessingError(
        "audio_duration_limit",
        "Audio attachments may not exceed 120 seconds.",
      );
    }
    return inspection;
  } catch (error) {
    throwIfAborted(input.signal);
    if (error instanceof AttachmentProcessingError) throw error;
    throw invalidAudio();
  }
}

function isWave(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WAVE";
}

async function inspectWave(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<AudioAttachmentInspection> {
  if (!isWave(bytes) || unsigned32LittleEndian(bytes, 4) + 8 !== bytes.byteLength) {
    throw invalidAudio();
  }

  let formatOffset: number | undefined;
  let formatBytes: number | undefined;
  let dataBytes: number | undefined;
  let offset = 12;
  let nextYieldOffset = scanYieldBytes;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw invalidAudio();
    const id = ascii(bytes, offset, offset + 4);
    const chunkBytes = unsigned32LittleEndian(bytes, offset + 4);
    const payloadOffset = offset + 8;
    const payloadEnd = payloadOffset + chunkBytes;
    const paddedEnd = payloadEnd + (chunkBytes & 1);
    if (
      !Number.isSafeInteger(payloadEnd) ||
      paddedEnd > bytes.byteLength
    ) throw invalidAudio();

    if (id === "fmt ") {
      if (formatOffset !== undefined) throw invalidAudio();
      formatOffset = payloadOffset;
      formatBytes = chunkBytes;
    } else if (id === "data") {
      if (dataBytes !== undefined) throw invalidAudio();
      dataBytes = chunkBytes;
    }
    offset = paddedEnd;
    if (offset >= nextYieldOffset) {
      await yieldToHost(signal);
      nextYieldOffset = offset + scanYieldBytes;
    }
  }
  if (
    offset !== bytes.byteLength ||
    formatOffset === undefined ||
    formatBytes === undefined ||
    dataBytes === undefined ||
    dataBytes === 0
  ) throw invalidAudio();

  const format = waveFormat(bytes, formatOffset, formatBytes);
  if (dataBytes % format.blockAlign !== 0) throw invalidAudio();
  const durationSeconds = dataBytes / format.byteRate;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw invalidAudio();
  }
  await yieldToHost(signal);
  return {
    mediaType: "audio/wav",
    durationSeconds,
    sampleRate: format.sampleRate,
    channels: format.channels,
  };
}

function waveFormat(
  bytes: Uint8Array,
  offset: number,
  byteLength: number,
): {
  sampleRate: number;
  channels: number;
  byteRate: number;
  blockAlign: number;
} {
  if (byteLength !== 16 && byteLength !== 18) throw invalidAudio();
  const audioFormat = unsigned16LittleEndian(bytes, offset);
  const channels = unsigned16LittleEndian(bytes, offset + 2);
  const sampleRate = unsigned32LittleEndian(bytes, offset + 4);
  const byteRate = unsigned32LittleEndian(bytes, offset + 8);
  const blockAlign = unsigned16LittleEndian(bytes, offset + 12);
  const bitsPerSample = unsigned16LittleEndian(bytes, offset + 14);
  if (
    (audioFormat !== 1 && audioFormat !== 3) ||
    channels < 1 ||
    channels > maximumWaveChannels ||
    sampleRate < minimumWaveSampleRate ||
    sampleRate > maximumWaveSampleRate ||
    !waveBitsAreSupported(audioFormat, bitsPerSample) ||
    byteLength === 18 && unsigned16LittleEndian(bytes, offset + 16) !== 0
  ) throw invalidAudio();
  const expectedBlockAlign = channels * bitsPerSample / 8;
  const expectedByteRate = sampleRate * expectedBlockAlign;
  if (
    !Number.isSafeInteger(expectedBlockAlign) ||
    !Number.isSafeInteger(expectedByteRate) ||
    blockAlign !== expectedBlockAlign ||
    byteRate !== expectedByteRate
  ) throw invalidAudio();
  return { sampleRate, channels, byteRate, blockAlign };
}

function waveBitsAreSupported(audioFormat: number, bitsPerSample: number): boolean {
  return audioFormat === 1
    ? bitsPerSample === 8 ||
      bitsPerSample === 16 ||
      bitsPerSample === 24 ||
      bitsPerSample === 32
    : bitsPerSample === 32 || bitsPerSample === 64;
}

async function inspectMp3(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<AudioAttachmentInspection> {
  let offset = id3v2End(bytes);
  let audioEnd = bytes.byteLength;
  if (
    audioEnd - offset >= 128 &&
    ascii(bytes, audioEnd - 128, audioEnd - 125) === "TAG"
  ) {
    audioEnd -= 128;
  }
  if (offset >= audioEnd) throw invalidAudio();

  let frameCount = 0;
  let totalSamples = 0;
  let expectedVersion: 1 | 2 | undefined;
  let expectedSampleRate: number | undefined;
  let expectedChannels: 1 | 2 | undefined;
  let nextYieldOffset = scanYieldBytes;
  while (offset < audioEnd) {
    const frame = mp3FrameAt(bytes, offset, audioEnd);
    if (
      expectedVersion !== undefined &&
      (
        frame.version !== expectedVersion ||
        frame.sampleRate !== expectedSampleRate ||
        frame.channels !== expectedChannels
      )
    ) throw invalidAudio();
    expectedVersion ??= frame.version;
    expectedSampleRate ??= frame.sampleRate;
    expectedChannels ??= frame.channels;
    frameCount += 1;
    totalSamples += frame.samples;
    offset += frame.byteLength;
    if (offset >= nextYieldOffset) {
      await yieldToHost(signal);
      nextYieldOffset = offset + scanYieldBytes;
    }
  }
  if (
    offset !== audioEnd ||
    frameCount < 2 ||
    expectedSampleRate === undefined ||
    expectedChannels === undefined
  ) throw invalidAudio();
  const durationSeconds = totalSamples / expectedSampleRate;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw invalidAudio();
  }
  return {
    mediaType: "audio/mpeg",
    durationSeconds,
    sampleRate: expectedSampleRate,
    channels: expectedChannels,
  };
}

function id3v2End(bytes: Uint8Array): number {
  if (bytes.byteLength < 3 || ascii(bytes, 0, 3) !== "ID3") return 0;
  if (bytes.byteLength < 10) throw invalidAudio();
  const version = bytes[3]!;
  const revision = bytes[4]!;
  const flags = bytes[5]!;
  const allowedFlags = version === 2
    ? 0xc0
    : version === 3
      ? 0xe0
      : version === 4
        ? 0xf0
        : -1;
  if (
    allowedFlags < 0 ||
    revision === 0xff ||
    (flags & ~allowedFlags) !== 0 ||
    [bytes[6], bytes[7], bytes[8], bytes[9]].some((value) => (value! & 0x80) !== 0)
  ) throw invalidAudio();
  const payloadBytes = (bytes[6]! << 21) |
    (bytes[7]! << 14) |
    (bytes[8]! << 7) |
    bytes[9]!;
  if (payloadBytes > MAX_AUDIO_ID3V2_PAYLOAD_BYTES) throw invalidAudio();
  const hasFooter = version === 4 && (flags & 0x10) !== 0;
  const bodyEnd = 10 + payloadBytes;
  const end = bodyEnd + (hasFooter ? 10 : 0);
  if (end > bytes.byteLength) throw invalidAudio();
  if (hasFooter) {
    const footerOffset = bodyEnd;
    if (
      ascii(bytes, footerOffset, footerOffset + 3) !== "3DI" ||
      bytes[footerOffset + 3] !== version ||
      bytes[footerOffset + 4] !== revision ||
      bytes[footerOffset + 5] !== flags ||
      !equalBytes(bytes, 6, footerOffset + 6, 4)
    ) throw invalidAudio();
  }
  return end;
}

function mp3FrameAt(
  bytes: Uint8Array,
  offset: number,
  audioEnd: number,
): {
  version: 1 | 2;
  sampleRate: number;
  channels: 1 | 2;
  byteLength: number;
  samples: number;
} {
  if (offset + 4 > audioEnd) throw invalidAudio();
  const second = bytes[offset + 1]!;
  const third = bytes[offset + 2]!;
  const fourth = bytes[offset + 3]!;
  if (bytes[offset] !== 0xff || (second & 0xe0) !== 0xe0) throw invalidAudio();
  const versionBits = (second >>> 3) & 0x03;
  const layerBits = (second >>> 1) & 0x03;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : undefined;
  if (version === undefined || layerBits !== 1) throw invalidAudio();
  const bitrateIndex = third >>> 4;
  const sampleRateIndex = (third >>> 2) & 0x03;
  if (
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleRateIndex === 3 ||
    (fourth & 0x03) === 0x02
  ) throw invalidAudio();
  const bitrate = (version === 1 ? mpeg1Layer3Bitrates : mpeg2Layer3Bitrates)[
    bitrateIndex
  ];
  const sampleRate = (version === 1 ? mpeg1SampleRates : mpeg2SampleRates)[
    sampleRateIndex
  ];
  if (bitrate === undefined || sampleRate === undefined) throw invalidAudio();
  const padding = (third >>> 1) & 1;
  const byteLength = Math.floor(
    (version === 1 ? 144 : 72) * bitrate * 1_000 / sampleRate,
  ) + padding;
  const crcBytes = (second & 1) === 0 ? 2 : 0;
  if (
    byteLength < 4 + crcBytes ||
    offset + byteLength > audioEnd ||
    (crcBytes > 0 && offset + 6 > audioEnd)
  ) throw invalidAudio();
  return {
    version,
    sampleRate,
    channels: (fourth >>> 6) === 3 ? 1 : 2,
    byteLength,
    samples: version === 1 ? 1_152 : 576,
  };
}

const mpeg1Layer3Bitrates = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
] as const;
const mpeg2Layer3Bitrates = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
] as const;
const mpeg1SampleRates = [44_100, 48_000, 32_000] as const;
const mpeg2SampleRates = [22_050, 24_000, 16_000] as const;
const supportedMp3SampleRates = new Set<number>([
  ...mpeg1SampleRates,
  ...mpeg2SampleRates,
]);

function equalBytes(
  bytes: Uint8Array,
  leftOffset: number,
  rightOffset: number,
  byteLength: number,
): boolean {
  for (let index = 0; index < byteLength; index += 1) {
    if (bytes[leftOffset + index] !== bytes[rightOffset + index]) return false;
  }
  return true;
}

function unsigned16LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function unsigned32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function invalidAudio(): AttachmentProcessingError {
  return new AttachmentProcessingError(
    "invalid_audio",
    "The attachment is not a valid supported audio file.",
  );
}
