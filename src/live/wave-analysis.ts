import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { Buffer } from "node:buffer";

import { throwIfAborted, yieldToHost } from "../runtime/host.js";

export interface WaveAnalysis {
  readonly sampleRate: number;
  readonly channels: number;
  readonly frames: number;
  readonly durationSeconds: number;
  readonly samplePeak: number;
  readonly peakDbfs: number | null;
  readonly rms: number;
  readonly rmsDbfs: number | null;
  readonly crestFactorDb: number | null;
  readonly dcOffsetByChannel: readonly number[];
  readonly maxAbsoluteDcOffset: number;
  readonly silenceThreshold: number;
  readonly silentFrameRatio: number;
  readonly clippedSampleRatio: number;
}

const maximumRenderedWaveBytes = 512 * 1024 * 1024;
const readChunkBytes = 256 * 1024;
const silenceAmplitude = 0.001;

export async function analyzeWaveFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<WaveAnalysis> {
  throwIfAborted(signal);
  if (
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_NONBLOCK !== "number"
  ) {
    throw unavailableWave();
  }

  let handle: FileHandle | undefined;
  try {
    const pathSnapshot = await lstat(filePath, { bigint: true });
    assertSafeFile(pathSnapshot);
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    assertSameFile(pathSnapshot, before);
    assertSafeFile(before);
    const analysis = await analyzeOpenWave(handle, Number(before.size), signal);
    const after = await handle.stat({ bigint: true });
    assertSameFile(before, after);
    const afterPath = await lstat(filePath, { bigint: true });
    assertSameFile(after, afterPath);
    throwIfAborted(signal);
    return analysis;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof RenderedWaveError) throw error;
    throw unavailableWave();
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the primary safe result or error.
      }
    }
  }
}

async function analyzeOpenWave(
  handle: FileHandle,
  fileBytes: number,
  signal?: AbortSignal,
): Promise<WaveAnalysis> {
  const header = await readExactly(handle, 0, 12);
  if (
    ascii(header, 0, 4) !== "RIFF" ||
    ascii(header, 8, 12) !== "WAVE" ||
    header.readUInt32LE(4) + 8 !== fileBytes
  ) throw invalidWave();

  let format: WaveFormat | undefined;
  let data: { offset: number; bytes: number } | undefined;
  let offset = 12;
  let chunks = 0;
  while (offset < fileBytes) {
    if (++chunks > 128 || offset + 8 > fileBytes) throw invalidWave();
    const chunk = await readExactly(handle, offset, 8);
    const id = ascii(chunk, 0, 4);
    const bytes = chunk.readUInt32LE(4);
    const payloadOffset = offset + 8;
    const payloadEnd = payloadOffset + bytes;
    const paddedEnd = payloadEnd + (bytes & 1);
    if (!Number.isSafeInteger(paddedEnd) || paddedEnd > fileBytes) {
      throw invalidWave();
    }
    if (id === "fmt ") {
      if (format || bytes < 16 || bytes > 64) throw invalidWave();
      format = parseFormat(await readExactly(handle, payloadOffset, bytes));
    } else if (id === "data") {
      if (data || bytes <= 0) throw invalidWave();
      data = { offset: payloadOffset, bytes };
    }
    offset = paddedEnd;
  }
  if (offset !== fileBytes || !format || !data) throw invalidWave();
  if (data.bytes % format.blockAlign !== 0) throw invalidWave();

  const frames = data.bytes / format.blockAlign;
  let samplePeak = 0;
  const channelMeans = Array.from({ length: format.channels }, () => 0);
  let squareScale = 0;
  let scaledSquareSum = 0;
  let clippedSamples = 0;
  let silentFrames = 0;
  let processedFrames = 0;
  const chunkBytes = Math.max(
    format.blockAlign,
    Math.floor(readChunkBytes / format.blockAlign) * format.blockAlign,
  );
  for (let dataOffset = 0; dataOffset < data.bytes; dataOffset += chunkBytes) {
    throwIfAborted(signal);
    const length = Math.min(chunkBytes, data.bytes - dataOffset);
    const bytes = await readExactly(handle, data.offset + dataOffset, length);
    for (let frameOffset = 0; frameOffset < bytes.length; frameOffset += format.blockAlign) {
      let framePeak = 0;
      for (let channel = 0; channel < format.channels; channel += 1) {
        const sampleOffset = frameOffset + channel * format.bytesPerSample;
        const decoded = decodeSample(bytes, sampleOffset, format);
        const absolute = Math.abs(decoded.value);
        samplePeak = Math.max(samplePeak, absolute);
        framePeak = Math.max(framePeak, absolute);
        channelMeans[channel] = updateMean(
          channelMeans[channel]!,
          decoded.value,
          processedFrames + 1,
        );
        if (absolute > 0) {
          if (squareScale < absolute) {
            const ratio = squareScale / absolute;
            scaledSquareSum = 1 + scaledSquareSum * ratio * ratio;
            squareScale = absolute;
          } else {
            const ratio = absolute / squareScale;
            scaledSquareSum += ratio * ratio;
          }
        }
        if (decoded.clipped) clippedSamples += 1;
      }
      if (framePeak < silenceAmplitude) silentFrames += 1;
      processedFrames += 1;
    }
    await yieldToHost(signal);
  }
  if (processedFrames !== frames) throw invalidWave();
  const samples = frames * format.channels;
  const rms = squareScale === 0
    ? 0
    : squareScale * Math.sqrt(scaledSquareSum / samples);
  const analysis: WaveAnalysis = {
    sampleRate: format.sampleRate,
    channels: format.channels,
    frames,
    durationSeconds: frames / format.sampleRate,
    samplePeak,
    peakDbfs: amplitudeDbfs(samplePeak),
    rms,
    rmsDbfs: amplitudeDbfs(rms),
    crestFactorDb: samplePeak > 0 && rms > 0
      ? 20 * Math.log10(samplePeak / rms)
      : null,
    dcOffsetByChannel: channelMeans,
    maxAbsoluteDcOffset: Math.max(...channelMeans.map(Math.abs)),
    silenceThreshold: silenceAmplitude,
    silentFrameRatio: silentFrames / frames,
    clippedSampleRatio: clippedSamples / samples,
  };
  assertFiniteAnalysis(analysis);
  return analysis;
}

function updateMean(current: number, value: number, count: number): number {
  if (current === 0 || Math.sign(current) === Math.sign(value)) {
    return current + (value - current) / count;
  }
  return current * ((count - 1) / count) + value / count;
}

function assertFiniteAnalysis(analysis: WaveAnalysis): void {
  const values = [
    analysis.durationSeconds,
    analysis.samplePeak,
    analysis.rms,
    analysis.maxAbsoluteDcOffset,
    analysis.silenceThreshold,
    analysis.silentFrameRatio,
    analysis.clippedSampleRatio,
    ...analysis.dcOffsetByChannel,
    ...(analysis.peakDbfs === null ? [] : [analysis.peakDbfs]),
    ...(analysis.rmsDbfs === null ? [] : [analysis.rmsDbfs]),
    ...(analysis.crestFactorDb === null ? [] : [analysis.crestFactorDb]),
  ];
  if (values.some((value) => !Number.isFinite(value))) throw invalidWave();
}

interface WaveFormat {
  format: 1 | 3;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bitsPerSample: number;
  bytesPerSample: number;
}

function parseFormat(bytes: Buffer): WaveFormat {
  const format = bytes.readUInt16LE(0);
  const channels = bytes.readUInt16LE(2);
  const sampleRate = bytes.readUInt32LE(4);
  const byteRate = bytes.readUInt32LE(8);
  const blockAlign = bytes.readUInt16LE(12);
  const bitsPerSample = bytes.readUInt16LE(14);
  const supportedBits = format === 1
    ? [8, 16, 24, 32].includes(bitsPerSample)
    : format === 3 && [32, 64].includes(bitsPerSample);
  const bytesPerSample = bitsPerSample / 8;
  if (
    (format !== 1 && format !== 3) ||
    !supportedBits ||
    channels < 1 ||
    channels > 8 ||
    sampleRate < 8_000 ||
    sampleRate > 192_000 ||
    blockAlign !== channels * bytesPerSample ||
    byteRate !== sampleRate * blockAlign
  ) throw invalidWave();
  return {
    format,
    channels,
    sampleRate,
    blockAlign,
    bitsPerSample,
    bytesPerSample,
  };
}

function decodeSample(
  bytes: Buffer,
  offset: number,
  format: WaveFormat,
): { value: number; clipped: boolean } {
  if (format.format === 3) {
    const value = format.bitsPerSample === 32
      ? bytes.readFloatLE(offset)
      : bytes.readDoubleLE(offset);
    if (!Number.isFinite(value)) throw invalidWave();
    return { value, clipped: Math.abs(value) >= 1 };
  }
  if (format.bitsPerSample === 8) {
    const raw = bytes.readUInt8(offset);
    const centered = raw - 128;
    return {
      value: centered < 0 ? centered / 128 : centered / 127,
      clipped: raw === 0 || raw === 255,
    };
  }
  const raw = format.bitsPerSample === 16
    ? bytes.readInt16LE(offset)
    : format.bitsPerSample === 24
      ? bytes.readIntLE(offset, 3)
      : bytes.readInt32LE(offset);
  const negativeScale = 2 ** (format.bitsPerSample - 1);
  const positiveScale = negativeScale - 1;
  return {
    value: raw < 0 ? raw / negativeScale : raw / positiveScale,
    clipped: raw === -negativeScale || raw === positiveScale,
  };
}

async function readExactly(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, position + offset);
    if (result.bytesRead <= 0) throw invalidWave();
    offset += result.bytesRead;
  }
  return bytes;
}

function amplitudeDbfs(value: number): number | null {
  return value > 0 ? 20 * Math.log10(value) : null;
}

function ascii(bytes: Buffer, start: number, end: number): string {
  return bytes.toString("ascii", start, end);
}

interface FileSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function assertSafeFile(snapshot: FileSnapshot): void {
  if (
    snapshot.isSymbolicLink() ||
    !snapshot.isFile() ||
    snapshot.size <= 0n ||
    snapshot.size > BigInt(maximumRenderedWaveBytes)
  ) throw unavailableWave();
}

function assertSameFile(expected: FileSnapshot, actual: FileSnapshot): void {
  if (
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.size !== actual.size ||
    expected.mtimeNs !== actual.mtimeNs ||
    expected.ctimeNs !== actual.ctimeNs
  ) throw unavailableWave();
}

class RenderedWaveError extends Error {}

function invalidWave(): RenderedWaveError {
  return new RenderedWaveError("Rendered audio is invalid or unsupported.");
}

function unavailableWave(): RenderedWaveError {
  return new RenderedWaveError("Rendered audio is unavailable or changed during analysis.");
}
