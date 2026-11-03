import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { materializeArtifactExport } from "../../src/storage/artifact-exports.js";

test("native export retains exact media bytes and a usable extension independently of source lifetime", async t => {
  const storage = await fs.mkdtemp("/private/tmp/live-smith-native-export-test-");
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  for (const [mediaType, extension] of [["audio/midi", ".mid"], ["audio/wav", ".wav"], ["audio/mpeg", ".mp3"]]) {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const { filePath: file } = await materializeArtifactExport(storage, { fileName: "../../曲目:一.bad", mediaType: mediaType!, byteLength: bytes.length,
      open: async () => Readable.from([bytes]) }, new AbortController().signal);
    assert.equal(path.extname(file), extension);
    assert.equal(path.dirname(path.dirname(file)), path.join(storage, "live-smith-exports"));
    assert.deepEqual(await fs.readFile(file), bytes);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  }
});

test("failed and cancelled exports leave no partial file for a DAW to consume", async t => {
  const storage = await fs.mkdtemp("/private/tmp/live-smith-native-export-test-");
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const source = { fileName: "sample.wav", mediaType: "audio/wav", byteLength: 3,
    open: async () => Readable.from((async function* () { yield Buffer.from([1]); throw new Error("changed source"); })()) };
  await assert.rejects(materializeArtifactExport(storage, source, new AbortController().signal));
  assert.deepEqual(await fs.readdir(path.join(storage, "live-smith-exports")), []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(materializeArtifactExport(storage, source, controller.signal));
  assert.deepEqual(await fs.readdir(path.join(storage, "live-smith-exports")), []);
});

test("native export rejects a redirected export directory", async t => {
  const storage = await fs.mkdtemp("/private/tmp/live-smith-native-export-test-");
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const outside = path.join(storage, "outside"); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(storage, "live-smith-exports"));
  await assert.rejects(materializeArtifactExport(storage, { fileName: "x.mid", mediaType: "audio/midi", byteLength: 1,
    open: async () => Readable.from([Buffer.from([1])]) }, new AbortController().signal));
  assert.deepEqual(await fs.readdir(outside), []);
});
