import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { openVerifiedStoredStream } from "../../src/storage/file-export.js";
import { removeStoredEntry, writeStoredBytes } from "../../src/storage/sqlite.js";

async function fixture(t: test.TestContext) {
  const storageDirectory = await mkdtemp("/private/tmp/live-smith-export-");
  t.after(() => rm(storageDirectory, { recursive: true, force: true }));
  const bytes = new Uint8Array(3 * 1024 * 1024).fill(37);
  const key = "live-smith-audio/session/asset.audio";
  await writeStoredBytes(storageDirectory, key, bytes);
  return { bytes, input: { storageDirectory, key, byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), signal: new AbortController().signal, assertCurrent: async () => {} } };
}

test("database exports stream bounded chunks and verify exact bytes", async t => {
  const { bytes, input } = await fixture(t);
  const stream = await openVerifiedStoredStream(input);
  let size = 0; const hash = createHash("sha256");
  for await (const chunk of stream) { assert(chunk.length <= 128 * 1024); size += chunk.length; hash.update(chunk); }
  assert.equal(size, bytes.length); assert.equal(hash.digest("hex"), input.sha256);
  await assert.rejects(openVerifiedStoredStream({ ...input, sha256: "0".repeat(64) }), /integrity/);
});

for (const mutation of ["replace", "delete"] as const) test(`an open export fails after its stored record is ${mutation}d`, async t => {
  const { bytes, input } = await fixture(t);
  const stream = await openVerifiedStoredStream(input);
  if (mutation === "replace") await writeStoredBytes(input.storageDirectory, input.key, bytes);
  else await removeStoredEntry(input.storageDirectory, input.key);
  await assert.rejects(async () => { for await (const _chunk of stream) { /* Consume until revision rejection. */ } });
});

test("cancelled exports release their reader and preserve subsequent reads", async t => {
  const { input } = await fixture(t);
  const controller = new AbortController();
  const stream = await openVerifiedStoredStream({ ...input, signal: controller.signal });
  const rejection = assert.rejects(async () => { for await (const _chunk of stream) { controller.abort(); } }, { name: "AbortError" });
  await rejection;
  await assert.rejects(openVerifiedStoredStream({ ...input, signal: controller.signal }), { name: "AbortError" });
  const next = await openVerifiedStoredStream(input); next.destroy();
  await new Promise(resolve => next.once("close", resolve));
  await writeStoredBytes(input.storageDirectory, input.key, new Uint8Array(1));
});

test("an export stops when the record is replaced after its first streamed chunk", async t => {
  const { bytes, input } = await fixture(t);
  const stream = await openVerifiedStoredStream(input);
  let received = 0;
  await assert.rejects(async () => {
    for await (const chunk of stream) {
      received += chunk.length;
      if (received === chunk.length) await writeStoredBytes(input.storageDirectory, input.key, bytes);
    }
  });
  assert(received > 0 && received < bytes.length);
});
