import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { inspectAudioAttachment, isAudioAttachmentCandidate } from "../attachments/audio.js";
import { assertDocumentAttachmentBytesWithinLimit, AttachmentProcessingError, MAX_DOCUMENT_ATTACHMENT_BYTES } from "../attachments/contracts.js";
import { openBoundedOoxmlZip } from "../attachments/ooxml-zip.js";
import { packageBytes } from "../attachments/ooxml-test-helpers.js";
import { createLalalAudioAdapter } from "../audio-services/lalal.js";
import { readAudioAsset } from "../storage/audio-assets.js";
import { AudioStorageError } from "../storage/audio-jobs.js";
import { audioStorageHarness, generationJobCases, waveBytes } from "../storage/audio-storage-test-helpers.js";
import { installSkill, readInstalledSkill, withSkillCatalogTransaction } from "../storage/skills.js";
import { createHostAbortController } from "./host.js";

function foreignBytes(bytes: Uint8Array): Uint8Array {
  const result = runInNewContext("const result = new Uint8Array(source.length + 4); result.set(source, 2); result.subarray(2, result.length - 2)",
    { source: bytes }) as Uint8Array;
  assert.equal(result instanceof Uint8Array, false, "fixture must cross an intrinsic boundary like Node Buffer in the Extension Host");
  return result;
}

test("audio inspection accepts genuine cross-realm bytes without trusting their container metadata", async () => {
  const expected = waveBytes();
  const bytes = foreignBytes(expected);
  assert.equal(isAudioAttachmentCandidate(bytes), true);
  assert.deepEqual(await inspectAudioAttachment({ bytes }), await inspectAudioAttachment({ bytes: expected }));
  assert.deepEqual(new Uint8Array(bytes), expected);
  bytes[0] = 0;
  await assert.rejects(inspectAudioAttachment({ bytes }), { code: "invalid_audio" });
});

test("generated cross-realm audio persists and reads back the exact inspected bytes", async t => {
  const h = await audioStorageHarness(t, generationJobCases[0]!.input);
  const expected = waveBytes();
  const asset = await h.save("music", foreignBytes(expected));
  const saved = await readAudioAsset(h.storage, h.session.id, asset.id);
  assert.equal(asset.mediaType, "audio/wav");
  assert.equal(asset.durationSeconds, 1);
  assert.equal(asset.byteLength, expected.byteLength);
  assert.deepEqual(new Uint8Array(saved.bytes), expected);
});

test("document and OOXML byte boundaries accept foreign Uint8Array views and retain their bounds", async () => {
  const bytes = foreignBytes(packageBytes("docx"));
  assert.doesNotThrow(() => assertDocumentAttachmentBytesWithinLimit(bytes));
  const archive = await openBoundedOoxmlZip(bytes, name => name === "word/document.xml");
  assert.equal(Buffer.from(archive.retainedEntries.get("word/document.xml")!).toString("utf8"), "<root/>");
  const oversized = foreignBytes(new Uint8Array(MAX_DOCUMENT_ATTACHMENT_BYTES + 1));
  assert.throws(() => assertDocumentAttachmentBytesWithinLimit(oversized), { code: "archive_limit" });
});

test("both Skill install entrypoints snapshot valid cross-realm bytes", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-byte-boundaries-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const directTransaction of [false, true]) {
    const id = directTransaction ? "foreign-catalog" : "foreign-upload";
    const source = foreignBytes(Buffer.from(`---\nname: ${id}\ndescription: Cross-realm byte fixture.\n---\n# Byte fixture\n`));
    const installed = directTransaction
      ? await withSkillCatalogTransaction(directory, catalog => catalog.installSkill(source))
      : await installSkill(directory, source);
    assert.equal(installed.id, id);
    source.fill(0);
    assert.equal((await readInstalledSkill(directory, id)).id, id);
  }
});

test("LALAL upload transmits a genuine foreign byte view unchanged", async () => {
  const expected = waveBytes();
  const bytes = foreignBytes(expected);
  const sourceId = "e1fc1d8f-502e-4de0-bf3b-b30543d11c77";
  let captured: Uint8Array | undefined;
  const adapter = createLalalAudioAdapter("fixture-license", { fetchImpl: (async (_input, init) => {
    captured = new Uint8Array(init!.body as Uint8Array);
    return Response.json({ id: sourceId, name: "audio.wav", size: expected.byteLength, duration: 1, expires: 2_000_000_000 });
  }) as typeof fetch });
  assert.equal(await adapter.upload(bytes, "audio/wav", createHostAbortController().signal), sourceId);
  assert.deepEqual(captured, expected);
});

test("byte boundaries still reject other views and forged Uint8Array objects", async t => {
  const h = await audioStorageHarness(t, generationJobCases[0]!.input);
  const invalid = [new Uint16Array([1, 2]), new DataView(new ArrayBuffer(4)),
    Object.create(Uint8Array.prototype), { byteLength: 44, [Symbol.toStringTag]: "Uint8Array" }];
  for (const value of invalid) {
    const bytes = value as Uint8Array;
    assert.equal(isAudioAttachmentCandidate(bytes), false);
    await assert.rejects(inspectAudioAttachment({ bytes }), AttachmentProcessingError);
    assert.throws(() => assertDocumentAttachmentBytesWithinLimit(bytes), AttachmentProcessingError);
    await assert.rejects(openBoundedOoxmlZip(bytes, () => true), AttachmentProcessingError);
    await assert.rejects(h.save("music", bytes), AudioStorageError);
    await assert.rejects(installSkill(undefined, bytes), TypeError);
  }
});
