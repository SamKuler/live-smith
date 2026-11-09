import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { createHostAbortController } from "../../src/runtime/host.js";
import { inspectAudioAttachmentRange } from "../../src/attachments/audio.js";
import { deleteSessionAttachment, openSessionAttachmentRange, readSessionAttachment, readSessionAttachmentWaveform, reuseSessionAttachment, saveSessionAttachmentStream } from "../../src/storage/attachments.js";
import { waveBytes, mp3Bytes } from "./support/audio-storage-test-helpers.js";

const localLimits = { maxBytes: 2 * 1024 ** 3, maxDurationSeconds: Number.MAX_SAFE_INTEGER };

test("range inspection handles a synthetic 2 GiB WAV with bounded reads and rejects truncation", async () => {
  const size = 2 * 1024 ** 3;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(size - 8, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(8000, 28); header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34);
  header.write("data", 36); header.writeUInt32LE(size - 44, 40);
  let readBytes = 0;
  const readRange = async (offset: number, length: number) => {
    assert.ok(length <= 64 * 1024);
    readBytes += length;
    const result = Buffer.alloc(length);
    if (offset < header.length) header.copy(result, 0, offset, Math.min(header.length, offset + length));
    return result;
  };
  const result = await inspectAudioAttachmentRange({ byteLength: size, readRange, limits: localLimits });
  assert.equal(result.durationSeconds, (size - 44) / 8000);
  assert.ok(readBytes < 256 * 1024);
  await assert.rejects(inspectAudioAttachmentRange({ byteLength: size - 1, readRange, limits: localLimits }), /valid supported audio/);
});

test("streamed intake preserves shared contents across reuse and cancellation", async t => {
  const directory = await fs.mkdtemp("/private/tmp/attachment-stream-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const original = waveBytes(2);
  async function* chunks(bytes: Uint8Array) { for (let i = 0; i < bytes.length; i += 4096) yield bytes.subarray(i, i + 4096); }
  const first = await saveSessionAttachmentStream(directory, "stream", { fileName: "wave.wav", chunks: chunks(original), expectedByteLength: original.length }, { preSavePendingAttachmentRefs: [] });
  const second = await reuseSessionAttachment(directory, "stream", first.id, { preSavePendingAttachmentRefs: [first] });
  await deleteSessionAttachment(directory, "stream", first.id);
  const reader = await openSessionAttachmentRange(directory, "stream", second.id);
  assert.deepEqual(await reader.readRange(0, 44), Buffer.from(original.subarray(0, 44)));
  await reader.close();
  assert.deepEqual((await readSessionAttachment(directory, "stream", second.id)).bytes, original);
  const preview = await readSessionAttachmentWaveform(directory, "stream", second.id, { buckets: 8 });
  assert.equal(preview?.peaks.length, 8);
  assert.equal(preview?.durationSeconds, 2);
  await assert.rejects(readSessionAttachment(directory, "stream", second.id, { maxBytes: 1 }), /consumer byte limit/);
  const controller = createHostAbortController(); controller.abort(new Error("cancelled"));
  await assert.rejects(saveSessionAttachmentStream(directory, "stream", { fileName: "cancel.wav", chunks: chunks(original), signal: controller.signal }, { preSavePendingAttachmentRefs: [] }), /cancelled/);
  await assert.rejects(saveSessionAttachmentStream(directory, "stream", { fileName: "bad.wav", chunks: chunks(original.subarray(0, original.length - 1)) }, { preSavePendingAttachmentRefs: [] }), /valid supported audio/);
});

test("range MP3 inspector matches strict byte inspector and catches truncated frames", async () => {
  const bytes = mp3Bytes();
  const readRange = async (offset: number, length: number) => bytes.subarray(offset, offset + length);
  const valid = await inspectAudioAttachmentRange({ byteLength: bytes.length, readRange, limits: localLimits });
  assert.equal(valid.mediaType, "audio/mpeg");
  await assert.rejects(inspectAudioAttachmentRange({ byteLength: bytes.length - 1, readRange, limits: localLimits }), /valid supported audio/);
});

test("waveform preview and range extraction use saved WAV samples", async t => {
  const directory = await fs.mkdtemp("/private/tmp/attachment-waveform-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from(waveBytes(2));
  bytes.fill(128, 44);
  bytes[44] = 255;
  bytes[44 + 8000] = 0;
  async function* chunks() { yield bytes; }
  const source = await saveSessionAttachmentStream(directory, "waveform", { fileName: "wave.wav", chunks: chunks() }, { preSavePendingAttachmentRefs: [] });
  const waveform = await readSessionAttachmentWaveform(directory, "waveform", source.id, { buckets: 2 });
  assert.deepEqual(waveform?.peaks.map(value => Math.round(value * 100)), [99, 100]);
});
