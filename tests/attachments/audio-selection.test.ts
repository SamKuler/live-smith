import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers";
import test from "node:test";
import { inspectAudioAttachment, sliceWaveAttachment } from "../../src/attachments/audio.js";
import { createHostAbortController } from "../../src/runtime/host.js";
import { mp3Bytes, waveBytes } from "../storage/support/audio-storage-test-helpers.js";

for (const [encoding, widths] of [[1, [8, 16, 24, 32]], [3, [32, 64]]] as const) {
  for (const bits of widths) test(`WAV excerpt preserves exact ${encoding === 3 ? "float" : "PCM"} ${bits}-bit interleaved samples`, async () => {
    const channels = 3, rate = 8000, align = channels * bits / 8;
    const source = Buffer.from(waveBytes(1, rate * align));
    source.writeUInt16LE(encoding, 20); source.writeUInt16LE(channels, 22);
    source.writeUInt32LE(rate * align, 28); source.writeUInt16LE(align, 32); source.writeUInt16LE(bits, 34);
    for (let i = 44; i < source.length; i++) source[i] = i * 31 % 256;
    const original = Buffer.from(source);
    const result = await sliceWaveAttachment({ bytes: source, startSeconds: .12504, endSeconds: .37504 });
    assert.equal(result.startSeconds, .125); assert.equal(result.endSeconds, .375);
    assert.deepEqual(Buffer.from(result.bytes.subarray(20, 36)), source.subarray(20, 36));
    assert.deepEqual(Buffer.from(result.bytes.subarray(44)), source.subarray(44 + 1000 * align, 44 + 3000 * align));
    assert.deepEqual(source, original);
    assert.equal((await inspectAudioAttachment({ bytes: result.bytes })).durationSeconds, .25);
  });
}

test("WAV extraction pads an odd data chunk, validates ranges, and rejects MP3 frame slicing", async () => {
  const source = waveBytes(1);
  const result = await sliceWaveAttachment({ bytes: source, startSeconds: 0, endSeconds: 1 / 8000 });
  assert.equal(result.bytes.length, 46);
  assert.equal((await inspectAudioAttachment({ bytes: result.bytes })).durationSeconds, 1 / 8000);
  for (const [startSeconds, endSeconds] of [[-1, 1], [.5, .5], [0, 2], [NaN, 1], [0, Infinity], [0, 0.00001]] as const) {
    await assert.rejects(sliceWaveAttachment({ bytes: source, startSeconds, endSeconds }));
  }
  await assert.rejects(sliceWaveAttachment({ bytes: mp3Bytes(), startSeconds: 0, endSeconds: .01 }), /explicit WAV conversion/);
});

test("audio sample slicing yields to cancellation and never changes original bytes", async () => {
  const source = waveBytes(120);
  const original = new Uint8Array(source);
  const controller = createHostAbortController();
  setImmediate(() => controller.abort(new Error("cancel selection")));
  await assert.rejects(sliceWaveAttachment({ bytes: source, startSeconds: 0, endSeconds: 100, signal: controller.signal }), /cancel selection/);
  assert.deepEqual(source, original);
});


test("WAV selection finds samples across padded metadata chunks and preserves an extended format chunk", async () => {
  const original = Buffer.from(waveBytes(1));
  for (let index = 44; index < original.length; index++) original[index] = index % 256;
  const chunk = (id: string, bytes: Buffer) => {
    const result = Buffer.alloc(8 + bytes.length + (bytes.length & 1));
    result.write(id); result.writeUInt32LE(bytes.length, 4); bytes.copy(result, 8); return result;
  };
  const format = Buffer.concat([original.subarray(20, 36), Buffer.alloc(2)]);
  const source = Buffer.concat([original.subarray(0, 12), chunk("JUNK", Buffer.from([1, 2, 3])), chunk("data", original.subarray(44)), chunk("fmt ", format), chunk("LIST", Buffer.from("untrusted metadata"))]);
  source.writeUInt32LE(source.length - 8, 4);
  const result = await sliceWaveAttachment({ bytes: source, startSeconds: .1, endSeconds: .2 });
  assert.equal((await inspectAudioAttachment({ bytes: result.bytes })).durationSeconds, .1);
  assert.deepEqual(Buffer.from(result.bytes.subarray(20, 38)), format);
  assert.deepEqual(Buffer.from(result.bytes.subarray(46)), original.subarray(44 + 800, 44 + 1600));
  assert.equal(Buffer.from(result.bytes).includes(Buffer.from("untrusted metadata")), false);
});
