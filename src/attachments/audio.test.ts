import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers";
import test from "node:test";

import { createHostAbortController } from "../runtime/host.js";
import {
  AttachmentProcessingError,
  MAX_AUDIO_ATTACHMENT_BYTES,
  MAX_AUDIO_DURATION_SECONDS,
} from "./contracts.js";
import {
  inspectAudioAttachment,
  MAX_AUDIO_ID3V2_PAYLOAD_BYTES,
} from "./audio.js";

interface WaveFormatOptions {
  audioFormat?: 1 | 3;
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  dataBytes?: number;
  extended?: boolean;
}

function waveBytes(options: WaveFormatOptions = {}): Uint8Array {
  const audioFormat = options.audioFormat ?? 1;
  const channels = options.channels ?? 2;
  const sampleRate = options.sampleRate ?? 48_000;
  const bitsPerSample = options.bitsPerSample ?? (audioFormat === 3 ? 32 : 16);
  const blockAlign = channels * bitsPerSample / 8;
  const fmt = Buffer.alloc(options.extended ? 18 : 16);
  fmt.writeUInt16LE(audioFormat, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * blockAlign, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(bitsPerSample, 14);
  if (options.extended) fmt.writeUInt16LE(0, 16);
  return riffWave([
    { id: "fmt ", bytes: fmt },
    { id: "data", bytes: new Uint8Array(options.dataBytes ?? sampleRate * blockAlign) },
  ]);
}

function riffWave(
  chunks: readonly { id: string; bytes: Uint8Array }[],
): Uint8Array {
  const chunkBytes = chunks.reduce(
    (total, chunk) => total + 8 + chunk.bytes.byteLength + (chunk.bytes.byteLength & 1),
    0,
  );
  const output = Buffer.alloc(12 + chunkBytes);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(output.byteLength - 8, 4);
  output.write("WAVE", 8, "ascii");
  let offset = 12;
  for (const chunk of chunks) {
    output.write(chunk.id, offset, "ascii");
    output.writeUInt32LE(chunk.bytes.byteLength, offset + 4);
    Buffer.from(chunk.bytes).copy(output, offset + 8);
    offset += 8 + chunk.bytes.byteLength + (chunk.bytes.byteLength & 1);
  }
  return new Uint8Array(output);
}

interface Mp3FrameOptions {
  version?: 1 | 2;
  bitrateIndex?: number;
  sampleRateIndex?: number;
  mono?: boolean;
  crc?: boolean;
  padding?: boolean;
}

function mp3Frame(options: Mp3FrameOptions = {}): Uint8Array {
  const version = options.version ?? 1;
  const bitrateIndex = options.bitrateIndex ?? (version === 1 ? 9 : 8);
  const sampleRateIndex = options.sampleRateIndex ?? 0;
  const bitrate = (version === 1
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  )[bitrateIndex]! * 1_000;
  const sampleRate = (version === 1
    ? [44_100, 48_000, 32_000]
    : [22_050, 24_000, 16_000]
  )[sampleRateIndex]!;
  const padding = options.padding ? 1 : 0;
  const byteLength = Math.floor((version === 1 ? 144 : 72) * bitrate / sampleRate) +
    padding;
  const frame = new Uint8Array(byteLength);
  frame[0] = 0xff;
  frame[1] = 0xe0 |
    (version === 1 ? 0x18 : 0x10) |
    0x02 |
    (options.crc ? 0 : 1);
  frame[2] = (bitrateIndex << 4) | (sampleRateIndex << 2) | (padding << 1);
  frame[3] = options.mono ? 0xc0 : 0;
  return frame;
}

function bytesTogether(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function id3v2(payloadBytes: number): Uint8Array {
  const tag = new Uint8Array(10 + payloadBytes);
  tag.set(Buffer.from("ID3", "ascii"));
  tag[3] = 4;
  tag[4] = 0;
  tag[5] = 0;
  tag[6] = (payloadBytes >>> 21) & 0x7f;
  tag[7] = (payloadBytes >>> 14) & 0x7f;
  tag[8] = (payloadBytes >>> 7) & 0x7f;
  tag[9] = payloadBytes & 0x7f;
  return tag;
}

function id3v1(): Uint8Array {
  const tag = new Uint8Array(128);
  tag.set(Buffer.from("TAG", "ascii"));
  return tag;
}

function id3v24WithFooter(bodyBytes: number): Uint8Array {
  const tag = id3v2(bodyBytes);
  tag[5] = 0x10;
  const footer = new Uint8Array(10);
  footer.set(Buffer.from("3DI", "ascii"));
  footer[3] = tag[3]!;
  footer[4] = tag[4]!;
  footer[5] = tag[5]!;
  footer.set(tag.subarray(6, 10), 6);
  return bytesTogether(tag, footer);
}

function audioError(
  code: AttachmentProcessingError["code"],
  message?: RegExp,
): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AttachmentProcessingError);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  };
}

test("audio inspection accepts strict PCM and IEEE-float WAVE files", async () => {
  const pcm = await inspectAudioAttachment({ bytes: waveBytes() });
  assert.deepEqual(pcm, {
    mediaType: "audio/wav",
    durationSeconds: 1,
    sampleRate: 48_000,
    channels: 2,
  });

  const float = await inspectAudioAttachment({
    bytes: waveBytes({
      audioFormat: 3,
      channels: 1,
      sampleRate: 96_000,
      bitsPerSample: 32,
      dataBytes: 96_000,
      extended: true,
    }),
  });
  assert.deepEqual(float, {
    mediaType: "audio/wav",
    durationSeconds: 0.25,
    sampleRate: 96_000,
    channels: 1,
  });

  const maximumFormat = await inspectAudioAttachment({
    bytes: waveBytes({
      channels: 8,
      sampleRate: 192_000,
      bitsPerSample: 8,
      dataBytes: 8,
    }),
  });
  assert.equal(maximumFormat.sampleRate, 192_000);
  assert.equal(maximumFormat.channels, 8);
});

test("WAVE inspection rejects malformed structure and inconsistent format math", async () => {
  const valid = waveBytes();
  const wrongRiffSize = new Uint8Array(valid);
  new DataView(wrongRiffSize.buffer).setUint32(4, wrongRiffSize.byteLength - 9, true);
  const unsupportedFormat = waveBytes();
  new DataView(unsupportedFormat.buffer).setUint16(20, 2, true);
  const badByteRate = waveBytes();
  new DataView(badByteRate.buffer).setUint32(28, 1, true);
  const badBlockAlign = waveBytes();
  new DataView(badBlockAlign.buffer).setUint16(32, 1, true);
  const fmt = Buffer.from(valid.subarray(20, 36));
  const duplicateFmt = riffWave([
    { id: "fmt ", bytes: fmt },
    { id: "fmt ", bytes: fmt },
    { id: "data", bytes: new Uint8Array(4) },
  ]);
  const duplicateData = riffWave([
    { id: "fmt ", bytes: fmt },
    { id: "data", bytes: new Uint8Array(4) },
    { id: "data", bytes: new Uint8Array(4) },
  ]);
  const misalignedData = riffWave([
    { id: "fmt ", bytes: fmt },
    { id: "data", bytes: new Uint8Array(3) },
  ]);
  const missingPad = riffWave([{ id: "JUNK", bytes: new Uint8Array([1]) }])
    .subarray(0, 21);
  new DataView(missingPad.buffer, missingPad.byteOffset).setUint32(
    4,
    missingPad.byteLength - 8,
    true,
  );
  const tooManyChannels = waveBytes({ channels: 9, dataBytes: 18 });
  const tooHighSampleRate = waveBytes({
    sampleRate: 192_001,
    dataBytes: 4,
  });

  for (const bytes of [
    wrongRiffSize,
    unsupportedFormat,
    badByteRate,
    badBlockAlign,
    duplicateFmt,
    duplicateData,
    misalignedData,
    missingPad,
    tooManyChannels,
    tooHighSampleRate,
  ]) {
    await assert.rejects(
      inspectAudioAttachment({ bytes }),
      audioError("invalid_audio", /^The attachment is not a valid supported audio file\.$/),
    );
  }
});

test("WAVE duration accepts exactly 120 seconds and rejects one sample more", async () => {
  const sampleRate = 8_000;
  const exact = await inspectAudioAttachment({
    bytes: waveBytes({
      channels: 1,
      sampleRate,
      bitsPerSample: 8,
      dataBytes: sampleRate * MAX_AUDIO_DURATION_SECONDS,
    }),
  });
  assert.equal(exact.durationSeconds, MAX_AUDIO_DURATION_SECONDS);

  await assert.rejects(
    inspectAudioAttachment({
      bytes: waveBytes({
        channels: 1,
        sampleRate,
        bitsPerSample: 8,
        dataBytes: sampleRate * MAX_AUDIO_DURATION_SECONDS + 1,
      }),
    }),
    audioError("audio_duration_limit", /120 seconds/),
  );
});

test("MP3 inspection accepts MPEG-1/2 Layer III sequences and bounded tags", async () => {
  const mpeg1Frame = mp3Frame();
  const tagged = bytesTogether(
    id3v24WithFooter(7),
    mpeg1Frame,
    mpeg1Frame,
    id3v1(),
  );
  const mpeg1 = await inspectAudioAttachment({ bytes: tagged });
  assert.deepEqual(mpeg1, {
    mediaType: "audio/mpeg",
    durationSeconds: 2 * 1_152 / 44_100,
    sampleRate: 44_100,
    channels: 2,
  });
  assert.deepEqual(Object.keys(mpeg1).sort(), [
    "channels",
    "durationSeconds",
    "mediaType",
    "sampleRate",
  ]);

  const mpeg2Frame = mp3Frame({ version: 2, mono: true, crc: true });
  assert.deepEqual(
    await inspectAudioAttachment({
      bytes: bytesTogether(mpeg2Frame, mpeg2Frame),
    }),
    {
      mediaType: "audio/mpeg",
      durationSeconds: 2 * 576 / 22_050,
      sampleRate: 22_050,
      channels: 1,
    },
  );
});

test("MP3 inspection bounds declared ID3v2 payload before frame scanning", async () => {
  const frame = mp3Frame();
  const exact = await inspectAudioAttachment({
    bytes: bytesTogether(
      id3v2(MAX_AUDIO_ID3V2_PAYLOAD_BYTES),
      frame,
      frame,
    ),
  });
  assert.equal(exact.mediaType, "audio/mpeg");

  await assert.rejects(
    inspectAudioAttachment({
      bytes: bytesTogether(
        id3v2(MAX_AUDIO_ID3V2_PAYLOAD_BYTES + 1),
        frame,
        frame,
      ),
    }),
    audioError("invalid_audio"),
  );
});

test("MP3 inspection requires a complete compatible sequence of at least two frames", async () => {
  const stereo = mp3Frame();
  const mono = mp3Frame({ mono: true });
  const badLayer = new Uint8Array(stereo);
  badLayer[1] = (badLayer[1]! & ~0x06) | 0x04;
  const badId3Size = id3v2(0);
  badId3Size[6] = 0x80;
  const badId3Flags = id3v2(0);
  badId3Flags[5] = 0x01;
  const badFooter = id3v24WithFooter(0);
  badFooter[badFooter.byteLength - 10] = 0;
  const truncatedFooter = id3v24WithFooter(7).subarray(0, 26);
  const embeddedFooter = id3v2(10);
  embeddedFooter[5] = 0x10;
  embeddedFooter.set(Buffer.from("3DI\x04\x00\x10\x00\x00\x00\x0a", "binary"), 10);
  const crcFrame = mp3Frame({ crc: true });

  for (const bytes of [
    stereo,
    bytesTogether(stereo, mono),
    stereo.subarray(0, stereo.byteLength - 1),
    bytesTogether(stereo, stereo, new Uint8Array([0])),
    bytesTogether(badLayer, stereo),
    bytesTogether(badId3Size, stereo, stereo),
    bytesTogether(badId3Flags, stereo, stereo),
    bytesTogether(badFooter, stereo, stereo),
    bytesTogether(truncatedFooter, stereo, stereo),
    bytesTogether(embeddedFooter, stereo, stereo),
    bytesTogether(crcFrame, crcFrame.subarray(0, 5)),
  ]) {
    await assert.rejects(
      inspectAudioAttachment({ bytes }),
      audioError("invalid_audio"),
    );
  }
});

test("audio inspection enforces the byte boundary before copying caller input", async () => {
  const exactDataBytes = MAX_AUDIO_ATTACHMENT_BYTES - 44;
  const exact = await inspectAudioAttachment({
    bytes: waveBytes({ dataBytes: exactDataBytes }),
  });
  assert.equal(exact.mediaType, "audio/wav");

  const backing = new Uint8Array(MAX_AUDIO_ATTACHMENT_BYTES + 1);
  let copyPathTouched = false;
  const oversized = new Proxy(backing, {
    get(target, property) {
      if (property === "byteLength") return target.byteLength;
      copyPathTouched = true;
      throw new Error(`Copy path read ${String(property)}.`);
    },
  });
  await assert.rejects(
    inspectAudioAttachment({ bytes: oversized }),
    audioError("archive_limit", /20 MiB/),
  );
  assert.equal(copyPathTouched, false);
});

test("audio inspection owns bytes before yielding and preserves cancellation", async () => {
  const mutable = waveBytes();
  const expected = await inspectAudioAttachment({ bytes: mutable });
  const task = inspectAudioAttachment({ bytes: mutable });
  mutable.fill(0);
  assert.deepEqual(await task, expected);

  const frame = mp3Frame();
  const longMp3 = bytesTogether(...Array.from({ length: 4_000 }, () => frame));
  const controller = createHostAbortController();
  const cancelled = new Error("cancelled audio inspection");
  const inspection = inspectAudioAttachment({
    bytes: longMp3,
    signal: controller.signal,
  });
  setImmediate(() => controller.abort(cancelled));
  await assert.rejects(inspection, (error: unknown) => error === cancelled);
});

test("RIFF WebP bytes are never accepted as audio", async () => {
  const webp = Buffer.from("RIFF\u0016\0\0\0WEBPVP8X", "latin1");
  await assert.rejects(
    inspectAudioAttachment({ bytes: webp }),
    audioError("invalid_audio"),
  );
});
