import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeWaveFile } from "./wave-analysis.js";

test("analyzeWaveFile reports objective PCM metrics without returning its path", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-wave-"));
  const file = path.join(directory, "render.wav");
  await fs.writeFile(file, pcm16Wave([
    [0, 0],
    [0.5, -0.5],
    [1, -1],
    [0.25, -0.25],
  ], 48_000));

  try {
    const result = await analyzeWaveFile(file);
    assert.equal(result.sampleRate, 48_000);
    assert.equal(result.channels, 2);
    assert.equal(result.frames, 4);
    assert.equal(result.durationSeconds, 4 / 48_000);
    assert.ok(Math.abs(result.samplePeak - 1) < 0.0001);
    assert.ok(Math.abs(result.rms - Math.sqrt(0.328125)) < 0.0001);
    assert.ok(Math.abs(result.dcOffsetByChannel[0]! - 0.4375) < 0.0001);
    assert.ok(Math.abs(result.dcOffsetByChannel[1]! + 0.4375) < 0.0001);
    assert.ok(Math.abs(result.maxAbsoluteDcOffset - 0.4375) < 0.0001);
    assert.equal(result.silenceThreshold, 0.001);
    assert.equal(result.silentFrameRatio, 0.25);
    assert.equal(result.clippedSampleRatio, 0.125);
    assert.doesNotMatch(JSON.stringify(result), /render\.wav|live-smith-wave/);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("analyzeWaveFile supports IEEE float WAV and finite decibel summaries", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-wave-"));
  const file = path.join(directory, "float.wav");
  await fs.writeFile(file, float32Wave([[0.25], [-0.25]], 44_100));

  try {
    const result = await analyzeWaveFile(file);
    assert.equal(result.samplePeak, 0.25);
    assert.equal(result.rms, 0.25);
    assert.ok(Math.abs(result.peakDbfs! + 12.041199826559248) < 1e-9);
    assert.ok(Math.abs(result.rmsDbfs! + 12.041199826559248) < 1e-9);
    assert.equal(result.crestFactorDb, 0);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("analyzeWaveFile maps every advertised PCM width to consistent full scale", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-wave-"));
  const fixtures = [
    ["pcm8.wav", pcmWave([[-1], [1]], 48_000, 8)],
    ["pcm16.wav", pcmWave([[-1], [1]], 48_000, 16)],
    ["pcm24.wav", pcmWave([[-1], [1]], 48_000, 24)],
    ["pcm32.wav", pcmWave([[-1], [1]], 48_000, 32)],
  ] as const;

  try {
    for (const [name, bytes] of fixtures) {
      const file = path.join(directory, name);
      await fs.writeFile(file, bytes);
      const result = await analyzeWaveFile(file);
      assert.equal(result.samplePeak, 1, name);
      assert.equal(result.rms, 1, name);
      assert.equal(result.clippedSampleRatio, 1, name);
      assert.equal(result.peakDbfs, 0, name);
      assert.equal(result.rmsDbfs, 0, name);
    }
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("analyzeWaveFile keeps finite float64 metrics at the numeric limit", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-wave-"));
  const file = path.join(directory, "float64.wav");
  await fs.writeFile(file, float64Wave([[Number.MAX_VALUE]], 48_000));

  try {
    const result = await analyzeWaveFile(file);
    assert.equal(result.samplePeak, Number.MAX_VALUE);
    assert.equal(result.rms, Number.MAX_VALUE);
    assert.equal(result.dcOffsetByChannel[0], Number.MAX_VALUE);
    assert.ok(Number.isFinite(result.peakDbfs!));
    assert.ok(Number.isFinite(result.rmsDbfs!));
    assert.equal(result.crestFactorDb, 0);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("analyzeWaveFile keeps mixed multi-channel float64 extremes finite", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-wave-"));
  const file = path.join(directory, "float64-mixed.wav");
  await fs.writeFile(file, float64Wave([
    [Number.MAX_VALUE, Number.MAX_VALUE],
    [Number.MAX_VALUE, -Number.MAX_VALUE],
    [0, 0],
    [-Number.MAX_VALUE, 0],
  ], 48_000));

  try {
    const result = await analyzeWaveFile(file);
    assert.equal(result.samplePeak, Number.MAX_VALUE);
    assert.ok(Number.isFinite(result.rms));
    assert.ok(result.rms > Number.MAX_VALUE * 0.7);
    assert.ok(Number.isFinite(result.dcOffsetByChannel[0]!));
    assert.ok(Number.isFinite(result.dcOffsetByChannel[1]!));
    assert.ok(result.dcOffsetByChannel[0]! > 0);
    assert.equal(result.dcOffsetByChannel[1], 0);
    assert.ok(Number.isFinite(result.peakDbfs!));
    assert.ok(Number.isFinite(result.rmsDbfs!));
    assert.ok(Number.isFinite(result.crestFactorDb!));
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("analyzeWaveFile supports padded unknown chunks and data before fmt", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-wave-"));
  const padded = path.join(directory, "padded.wav");
  const reordered = path.join(directory, "reordered.wav");
  const base = pcm16Wave([[0.5]], 48_000);
  await fs.writeFile(padded, withOddUnknownChunk(base));
  await fs.writeFile(reordered, withDataBeforeFormat(base));

  try {
    assert.ok(Math.abs((await analyzeWaveFile(padded)).samplePeak - 0.5) < 0.0001);
    assert.ok(Math.abs((await analyzeWaveFile(reordered)).samplePeak - 0.5) < 0.0001);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("analyzeWaveFile rejects non-finite float samples", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-wave-"));
  const file = path.join(directory, "nan.wav");
  await fs.writeFile(file, float64Wave([[Number.NaN]], 48_000));

  try {
    await assert.rejects(analyzeWaveFile(file), /rendered audio.*invalid/i);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("analyzeWaveFile rejects corrupt, unsupported, and replaced files safely", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-wave-"));
  const corrupt = path.join(directory, "corrupt.wav");
  const symlink = path.join(directory, "link.wav");
  const unsupported = path.join(directory, "unsupported.wav");
  await fs.writeFile(corrupt, Buffer.from("not wave"));
  await fs.symlink(corrupt, symlink);
  await fs.writeFile(unsupported, wave([[0]], 48_000, 6, 16, (buffer, offset) => {
    buffer.writeInt16LE(0, offset);
  }));

  try {
    await assert.rejects(analyzeWaveFile(corrupt), /rendered audio.*invalid/i);
    await assert.rejects(analyzeWaveFile(symlink), /rendered audio.*unavailable/i);
    await assert.rejects(analyzeWaveFile(unsupported), /rendered audio.*invalid/i);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("analyzeWaveFile enforces its rendered-file size ceiling before reading", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-wave-"));
  const file = path.join(directory, "oversized.wav");
  await fs.writeFile(file, Buffer.from([0]));
  await fs.truncate(file, 512 * 1024 * 1024 + 1);

  try {
    await assert.rejects(analyzeWaveFile(file), /rendered audio.*unavailable/i);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("analyzeWaveFile detects path replacement during streaming", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-wave-"));
  const file = path.join(directory, "render.wav");
  const original = path.join(directory, "original.wav");
  await writeSparsePcm16Wave(file, 150_000);
  let checks = 0;
  const signal = {
    get aborted() {
      checks += 1;
      if (checks === 4) {
        renameSync(file, original);
        writeFileSync(file, pcm16Wave([[0]], 48_000));
      }
      return false;
    },
  } as AbortSignal;

  try {
    await assert.rejects(analyzeWaveFile(file, signal), /rendered audio.*unavailable/i);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("analyzeWaveFile honors cancellation while streaming", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-wave-"));
  const file = path.join(directory, "render.wav");
  await writeSparsePcm16Wave(file, 150_000);
  const reason = new Error("stop analysis");
  let checks = 0;
  const signal = {
    get aborted() {
      checks += 1;
      return checks >= 4;
    },
    reason,
  } as AbortSignal;

  try {
    await assert.rejects(analyzeWaveFile(file, signal), reason);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

async function writeSparsePcm16Wave(file: string, frames: number): Promise<void> {
  const dataBytes = frames * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48_000, 24);
  header.writeUInt32LE(96_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  await fs.writeFile(file, header);
  await fs.truncate(file, 44 + dataBytes);
}

function pcm16Wave(frames: number[][], sampleRate: number): Buffer {
  return wave(frames, sampleRate, 1, 16, (buffer, offset, sample) => {
    buffer.writeInt16LE(Math.round(sample * 32767), offset);
  });
}

function float32Wave(frames: number[][], sampleRate: number): Buffer {
  return wave(frames, sampleRate, 3, 32, (buffer, offset, sample) => {
    buffer.writeFloatLE(sample, offset);
  });
}

function float64Wave(frames: number[][], sampleRate: number): Buffer {
  return wave(frames, sampleRate, 3, 64, (buffer, offset, sample) => {
    buffer.writeDoubleLE(sample, offset);
  });
}

function pcmWave(
  frames: number[][],
  sampleRate: number,
  bitsPerSample: 8 | 16 | 24 | 32,
): Buffer {
  const negativeScale = 2 ** (bitsPerSample - 1);
  const positiveScale = negativeScale - 1;
  return wave(frames, sampleRate, 1, bitsPerSample, (buffer, offset, sample) => {
    if (bitsPerSample === 8) {
      buffer.writeUInt8(sample <= -1 ? 0 : sample >= 1 ? 255 : Math.round(sample * 127 + 128), offset);
      return;
    }
    const raw = sample <= -1
      ? -negativeScale
      : sample >= 1
        ? positiveScale
        : Math.round(sample * positiveScale);
    if (bitsPerSample === 16) buffer.writeInt16LE(raw, offset);
    else if (bitsPerSample === 24) buffer.writeIntLE(raw, offset, 3);
    else buffer.writeInt32LE(raw, offset);
  });
}

function withOddUnknownChunk(base: Buffer): Buffer {
  const result = Buffer.alloc(base.length + 10);
  base.copy(result, 0, 0, 12);
  result.write("JUNK", 12);
  result.writeUInt32LE(1, 16);
  result.writeUInt8(0x7f, 20);
  result.writeUInt8(0, 21);
  base.copy(result, 22, 12);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

function withDataBeforeFormat(base: Buffer): Buffer {
  const result = Buffer.alloc(base.length);
  base.copy(result, 0, 0, 12);
  base.copy(result, 12, 36);
  base.copy(result, 12 + base.length - 36, 12, 36);
  return result;
}

function wave(
  frames: number[][],
  sampleRate: number,
  format: number,
  bitsPerSample: number,
  writeSample: (buffer: Buffer, offset: number, sample: number) => void,
): Buffer {
  const channels = frames[0]?.length ?? 1;
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes = frames.length * channels * bytesPerSample;
  const dataPadding = dataBytes & 1;
  const buffer = Buffer.alloc(44 + dataBytes + dataPadding);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes + dataPadding, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(format, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (const frame of frames) {
    for (const sample of frame) {
      writeSample(buffer, offset, sample);
      offset += bytesPerSample;
    }
  }
  return buffer;
}
