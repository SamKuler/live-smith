import { types } from "node:util";

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

export interface AudioInspectionLimits {
  maxBytes: number;
  maxDurationSeconds: number;
}

const defaultAudioInspectionLimits: AudioInspectionLimits = {
  maxBytes: MAX_AUDIO_ATTACHMENT_BYTES,
  maxDurationSeconds: MAX_AUDIO_DURATION_SECONDS,
};

const scanYieldBytes = 256 * 1024;
const minimumWaveSampleRate = 8_000;
const maximumWaveSampleRate = 192_000;
const maximumWaveChannels = 8;
export const MAX_AUDIO_ID3V2_PAYLOAD_BYTES = 1024 * 1024;

export function isAudioAttachmentInspection(
  value: unknown,
  limits: AudioInspectionLimits = defaultAudioInspectionLimits,
): value is AudioAttachmentInspection {
  if (!validInspectionLimits(limits)) return false;
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
    record.durationSeconds <= limits.maxDurationSeconds &&
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
  if (!types.isUint8Array(bytes)) return false;
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
  limits?: AudioInspectionLimits;
}): Promise<AudioAttachmentInspection> {
  throwIfAborted(input.signal);
  const limits = input.limits ?? defaultAudioInspectionLimits;
  if (!validInspectionLimits(limits)) throw new TypeError("Audio inspection limits are invalid.");
  if (!types.isUint8Array(input.bytes) || input.bytes.byteLength === 0) {
    throw invalidAudio();
  }
  if (input.bytes.byteLength > limits.maxBytes) {
    throw new AttachmentProcessingError(
      "archive_limit",
      `Audio attachments may not exceed ${limits.maxBytes / (1024 * 1024)} MiB.`,
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
    if (inspection.durationSeconds > limits.maxDurationSeconds) {
      throw new AttachmentProcessingError(
        "audio_duration_limit",
        `Audio attachments may not exceed ${limits.maxDurationSeconds} seconds.`,
      );
    }
    return inspection;
  } catch (error) {
    throwIfAborted(input.signal);
    if (error instanceof AttachmentProcessingError) throw error;
    throw invalidAudio();
  }
}

/** Inspects a seekable immutable source with reads bounded to 64 KiB. */
export async function inspectAudioAttachmentRange(input: {
  byteLength: number;
  readRange(offset: number, length: number): Promise<Uint8Array>;
  signal?: AbortSignal;
  limits: AudioInspectionLimits;
}): Promise<AudioAttachmentInspection> {
  const { byteLength, limits, signal } = input;
  if (!validInspectionLimits(limits)) throw new TypeError("Audio inspection limits are invalid.");
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) throw invalidAudio();
  if (byteLength > limits.maxBytes) throw new AttachmentProcessingError("archive_limit", `Audio attachments may not exceed ${limits.maxBytes / (1024 * 1024)} MiB.`);
  let cachedOffset = -1;
  let cached: Uint8Array = new Uint8Array();
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    throwIfAborted(signal);
    if (offset < 0 || length < 0 || offset + length > byteLength || length > 64 * 1024) throw invalidAudio();
    if (offset < cachedOffset || offset + length > cachedOffset + cached.length) {
      cachedOffset = offset;
      cached = await input.readRange(offset, Math.min(64 * 1024, byteLength - offset));
      if (cached.length !== Math.min(64 * 1024, byteLength - offset)) throw invalidAudio();
    }
    return cached.subarray(offset - cachedOffset, offset - cachedOffset + length);
  };
  try {
    const prefix = await read(0, Math.min(12, byteLength));
    let inspection: AudioAttachmentInspection;
    if (isWave(prefix)) {
      if (unsigned32LittleEndian(prefix, 4) + 8 !== byteLength) throw invalidAudio();
      let offset = 12, format: ReturnType<typeof waveFormat> | undefined, dataBytes: number | undefined;
      while (offset < byteLength) {
        const header = await read(offset, 8);
        const id = ascii(header, 0, 4), size = unsigned32LittleEndian(header, 4);
        const end = offset + 8 + size + (size & 1);
        if (end > byteLength) throw invalidAudio();
        if (id === "fmt ") {
          if (format || (size !== 16 && size !== 18)) throw invalidAudio();
          format = waveFormat(await read(offset + 8, size), 0, size);
        } else if (id === "data") {
          if (dataBytes !== undefined) throw invalidAudio();
          dataBytes = size;
        }
        offset = end;
      }
      if (!format || !dataBytes || dataBytes % format.blockAlign !== 0) throw invalidAudio();
      inspection = { mediaType: "audio/wav", durationSeconds: dataBytes / format.byteRate, sampleRate: format.sampleRate, channels: format.channels };
    } else {
      let offset = 0, audioEnd = byteLength;
      if (byteLength >= 3 && ascii(prefix, 0, 3) === "ID3") {
        const header = await read(0, 10);
        const payload = (header[6]! << 21) | (header[7]! << 14) | (header[8]! << 7) | header[9]!;
        if (payload > MAX_AUDIO_ID3V2_PAYLOAD_BYTES) throw invalidAudio();
        const hasFooter = header[3] === 4 && (header[5]! & 0x10) !== 0;
        const end = 10 + payload + (hasFooter ? 10 : 0);
        if (end > byteLength) throw invalidAudio();
        // Reuse the strict tag parser on a compact representation, preserving the declared length and footer.
        const tag = new Uint8Array(end);
        tag.set(header);
        if (hasFooter) tag.set(await read(end - 10, 10), end - 10);
        offset = id3v2End(tag);
      }
      if (audioEnd - offset >= 128 && ascii(await read(audioEnd - 128, 3), 0, 3) === "TAG") audioEnd -= 128;
      let count = 0, samples = 0, version: 1 | 2 | undefined, rate: number | undefined, channels: 1 | 2 | undefined;
      let nextYield = 256 * 1024;
      while (offset < audioEnd) {
        const header = await read(offset, Math.min(4, audioEnd - offset));
        const frame = mp3FrameAt(header, 0, audioEnd - offset);
        if (version !== undefined && (version !== frame.version || rate !== frame.sampleRate || channels !== frame.channels)) throw invalidAudio();
        version ??= frame.version; rate ??= frame.sampleRate; channels ??= frame.channels;
        count++; samples += frame.samples; offset += frame.byteLength;
        if (offset >= nextYield) { await yieldToHost(signal); nextYield = offset + 256 * 1024; }
      }
      if (offset !== audioEnd || count < 2 || rate === undefined || channels === undefined) throw invalidAudio();
      inspection = { mediaType: "audio/mpeg", durationSeconds: samples / rate, sampleRate: rate, channels };
    }
    throwIfAborted(signal);
    if (inspection.durationSeconds > limits.maxDurationSeconds) throw new AttachmentProcessingError("audio_duration_limit", `Audio attachments may not exceed ${limits.maxDurationSeconds} seconds.`);
    return inspection;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof AttachmentProcessingError) throw error;
    throw invalidAudio();
  }
}

function validInspectionLimits(limits: AudioInspectionLimits): boolean {
  return Number.isSafeInteger(limits.maxBytes) && limits.maxBytes > 0 &&
    Number.isFinite(limits.maxDurationSeconds) && limits.maxDurationSeconds > 0;
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

/** Cuts validated PCM/float WAV samples without decoding, resampling or copying unrelated chunks. */
export async function sliceWaveAttachment(input: {
  bytes: Uint8Array; startSeconds: number; endSeconds: number; signal?: AbortSignal;
}): Promise<{ bytes: Uint8Array; startSeconds: number; endSeconds: number }> {
  const inspection = await inspectAudioAttachment(input);
  if (inspection.mediaType !== "audio/wav") throw new AttachmentProcessingError("invalid_audio", "MP3 excerpts require explicit WAV conversion.");
  if (!Number.isFinite(input.startSeconds) || !Number.isFinite(input.endSeconds) ||
      input.startSeconds < 0 || input.endSeconds <= input.startSeconds || input.endSeconds > inspection.durationSeconds) {
    throw new AttachmentProcessingError("invalid_audio", "Select a valid start and end within the audio duration.");
  }
  let formatOffset = 0;
  let formatBytes = 0;
  let dataOffset = 0;
  for (let offset = 12; offset < input.bytes.byteLength;) {
    const length = unsigned32LittleEndian(input.bytes, offset + 4);
    const id = ascii(input.bytes, offset, offset + 4);
    if (id === "fmt ") { formatOffset = offset + 8; formatBytes = length; }
    if (id === "data") dataOffset = offset + 8;
    offset += 8 + length + (length & 1);
  }
  const format = waveFormat(input.bytes, formatOffset, formatBytes);
  const startFrame = Math.round(input.startSeconds * format.sampleRate);
  const endFrame = Math.round(input.endSeconds * format.sampleRate);
  if (endFrame <= startFrame) throw new AttachmentProcessingError("invalid_audio", "The selection must contain at least one sample.");
  const dataLength = (endFrame - startFrame) * format.blockAlign;
  const result = new Uint8Array(12 + 8 + formatBytes + 8 + dataLength + (dataLength & 1));
  const view = new DataView(result.buffer);
  const put = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) result[offset + i] = text.charCodeAt(i); };
  put(0, "RIFF"); view.setUint32(4, result.length - 8, true); put(8, "WAVE");
  put(12, "fmt "); view.setUint32(16, formatBytes, true);
  result.set(input.bytes.subarray(formatOffset, formatOffset + formatBytes), 20);
  const outputOffset = 28 + formatBytes;
  put(20 + formatBytes, "data"); view.setUint32(24 + formatBytes, dataLength, true);
  const sourceOffset = dataOffset + startFrame * format.blockAlign;
  for (let copied = 0; copied < dataLength; copied += scanYieldBytes) {
    await yieldToHost(input.signal);
    const end = Math.min(dataLength, copied + scanYieldBytes);
    result.set(input.bytes.subarray(sourceOffset + copied, sourceOffset + end), outputOffset + copied);
  }
  throwIfAborted(input.signal);
  return { bytes: result, startSeconds: startFrame / format.sampleRate, endSeconds: endFrame / format.sampleRate };
}

/** Extract a bounded WAV selection without loading unrelated original samples. */
export async function sliceWaveAttachmentRange(input: {
  byteLength: number;
  readRange(offset: number, length: number): Promise<Uint8Array>;
  startSeconds: number;
  endSeconds: number;
  signal?: AbortSignal;
}): Promise<{ bytes: Uint8Array; startSeconds: number; endSeconds: number }> {
  const inspection = await inspectAudioAttachmentRange({
    byteLength: input.byteLength, readRange: input.readRange,
    limits: { maxBytes: 2 * 1024 * 1024 * 1024, maxDurationSeconds: Number.MAX_SAFE_INTEGER },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (inspection.mediaType !== "audio/wav") throw new AttachmentProcessingError("invalid_audio", "MP3 excerpts require explicit WAV conversion.");
  if (!Number.isFinite(input.startSeconds) || !Number.isFinite(input.endSeconds) ||
      input.startSeconds < 0 || input.endSeconds <= input.startSeconds || input.endSeconds > inspection.durationSeconds) {
    throw new AttachmentProcessingError("invalid_audio", "Select a valid start and end within the audio duration.");
  }
  let formatBytes: Uint8Array | undefined, dataOffset = 0;
  for (let offset = 12; offset < input.byteLength;) {
    const header = await input.readRange(offset, 8);
    const length = unsigned32LittleEndian(header, 4), id = ascii(header, 0, 4);
    if (id === "fmt ") formatBytes = await input.readRange(offset + 8, length);
    if (id === "data") dataOffset = offset + 8;
    offset += 8 + length + (length & 1);
  }
  if (!formatBytes || !dataOffset) throw invalidAudio();
  const format = waveFormat(formatBytes, 0, formatBytes.length);
  const startFrame = Math.round(input.startSeconds * format.sampleRate), endFrame = Math.round(input.endSeconds * format.sampleRate);
  if (endFrame <= startFrame) throw new AttachmentProcessingError("invalid_audio", "The selection must contain at least one sample.");
  const dataLength = (endFrame - startFrame) * format.blockAlign;
  const total = 28 + formatBytes.length + dataLength + (dataLength & 1);
  if (total > MAX_AUDIO_ATTACHMENT_BYTES || (endFrame - startFrame) / format.sampleRate > MAX_AUDIO_DURATION_SECONDS) {
    throw new AttachmentProcessingError("archive_limit", "The selected audio exceeds the processing limit.");
  }
  const result = new Uint8Array(total), view = new DataView(result.buffer);
  const put = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) result[offset + i] = text.charCodeAt(i); };
  put(0, "RIFF"); view.setUint32(4, result.length - 8, true); put(8, "WAVE");
  put(12, "fmt "); view.setUint32(16, formatBytes.length, true); result.set(formatBytes, 20);
  put(20 + formatBytes.length, "data"); view.setUint32(24 + formatBytes.length, dataLength, true);
  for (let copied = 0; copied < dataLength; copied += 64 * 1024) {
    throwIfAborted(input.signal);
    result.set(await input.readRange(dataOffset + startFrame * format.blockAlign + copied, Math.min(64 * 1024, dataLength - copied)), 28 + formatBytes.length + copied);
  }
  return { bytes: result, startSeconds: startFrame / format.sampleRate, endSeconds: endFrame / format.sampleRate };
}

/** Sample each time bucket for a bounded-cost waveform preview. */
export async function previewWaveformRange(input: {
  byteLength: number; readRange(offset: number, length: number): Promise<Uint8Array>;
  buckets?: number; signal?: AbortSignal;
}): Promise<{ peaks: number[]; durationSeconds: number } | undefined> {
  const buckets = input.buckets ?? 480;
  if (!Number.isInteger(buckets) || buckets < 1 || buckets > 512) throw new RangeError("Waveform bucket count must be between 1 and 512.");
  const inspection = await inspectAudioAttachmentRange({ byteLength: input.byteLength, readRange: input.readRange,
    limits: { maxBytes: 2 * 1024 * 1024 * 1024, maxDurationSeconds: Number.MAX_SAFE_INTEGER },
    ...(input.signal === undefined ? {} : { signal: input.signal }) });
  if (inspection.mediaType !== "audio/wav") return undefined;
  let fmt: Uint8Array | undefined, dataOffset = 0, dataLength = 0;
  for (let offset = 12; offset < input.byteLength;) {
    const header = await input.readRange(offset, 8);
    const length = unsigned32LittleEndian(header, 4), id = ascii(header, 0, 4);
    if (id === "fmt ") fmt = await input.readRange(offset + 8, length);
    if (id === "data") { dataOffset = offset + 8; dataLength = length; }
    offset += 8 + length + (length & 1);
  }
  if (!fmt || !dataOffset) throw invalidAudio();
  const format = waveFormat(fmt, 0, fmt.length), sampleBits = unsigned16LittleEndian(fmt, 14);
  const floating = unsigned16LittleEndian(fmt, 0) === 3, sampleBytes = sampleBits / 8;
  const totalFrames = dataLength / format.blockAlign;
  const peaks: number[] = [];
  for (let bucket = 0; bucket < buckets; bucket++) {
    throwIfAborted(input.signal);
    const first = Math.floor(bucket * totalFrames / buckets), end = Math.floor((bucket + 1) * totalFrames / buckets);
    const frames = Math.min(256, end - first);
    if (!frames) { peaks.push(0); continue; }
    const bytes = await input.readRange(dataOffset + first * format.blockAlign, frames * format.blockAlign);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let peak = 0;
    for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < format.channels; channel++) {
      const offset = frame * format.blockAlign + channel * sampleBytes;
      let value: number;
      if (floating) value = sampleBits === 32 ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
      else if (sampleBits === 8) value = (view.getUint8(offset) - 128) / 128;
      else if (sampleBits === 16) value = view.getInt16(offset, true) / 32768;
      else if (sampleBits === 24) { const raw = view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getInt8(offset + 2) << 16; value = raw / 8388608; }
      else value = view.getInt32(offset, true) / 2147483648;
      if (Number.isFinite(value)) peak = Math.max(peak, Math.min(1, Math.abs(value)));
    }
    peaks.push(peak);
  }
  return { peaks, durationSeconds: inspection.durationSeconds };
}
