import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { createSunoUploadAdapter } from "../../../src/audio-services/suno/suno-upload.js";
import { waveBytes } from "../../storage/support/audio-storage-test-helpers.js";
import { A, B, session, replay, signal, accountStep } from "./support/audio-service-suno-harness.js";

const destination = "https://suno-data-uploads.s3.amazonaws.com/";
const presign = { id: A, url: destination, fields: { key: "audio-fixture", policy: "synthetic-upload-policy", "x-amz-signature": "synthetic-upload-signature" } };

test("Suno upload captures the website protocol and sends only multipart fields to its storage host", async () => {
  const h = replay([
    accountStep({ audio_upload_limits: { min: 6, max: 120 } }),
    { path: "/api/uploads/audio/", value: presign },
    { path: destination, response: new Response(null, { status: 204 }) },
    { path: `/api/uploads/audio/${A}/upload-finish/`, value: {} },
    { path: `/api/uploads/audio/${A}/`, value: { status: "processing" } },
    { path: `/api/uploads/audio/${A}/`, value: { status: "complete", title: "Recorded audio" } },
    { path: `/api/uploads/audio/${A}/initialize-clip/`, value: { clip_id: B } },
  ]);
  const adapter = createSunoUploadAdapter(session, { fetchImpl: h.fetchImpl });
  assert.deepEqual(await adapter.limits(signal()), { minimumSeconds: 6, maximumSeconds: 120 });
  const spec = await adapter.create("audio/wav", signal());
  await adapter.upload(spec, waveBytes(6), "audio/wav", signal());
  await adapter.finish(spec.uploadId, "audio/wav", signal());
  assert.deepEqual(await adapter.inspect(spec.uploadId, signal()), { status: "processing" });
  assert.deepEqual(await adapter.inspect(spec.uploadId, signal()), { status: "complete" });
  assert.equal(await adapter.initialize(spec.uploadId, signal()), B);
  assert.deepEqual(h.api().find((entry) => entry.path === "/api/uploads/audio/")!.body,
    { extension: "wav", is_stem_mix: false, upload_type: "file_upload" });
  assert.deepEqual(h.api().find((entry) => entry.path.endsWith("upload-finish/"))!.body,
    { upload_type: "file_upload", upload_filename: "audio.wav" });
  assert.deepEqual(h.api().find((entry) => entry.path.endsWith("initialize-clip/"))!.body, {});
  const storage = h.requests.find((entry) => entry.url === destination)!;
  assert.equal(storage.headers.has("Authorization"), false);
  assert.equal(storage.headers.has("Cookie"), false);
  assert.equal(storage.headers.has("Device-Id"), false);
  assert.equal(storage.init.redirect, "error");
  assert.equal(storage.init.credentials, "omit");
  assert.match(storage.headers.get("Content-Type")!, /^multipart\/form-data; boundary=/);
  const body = Buffer.from(storage.body as Uint8Array).toString("latin1");
  assert.match(body, /name="policy"\r\n\r\nsynthetic-upload-policy/);
  assert.match(body, /name="file"; filename="audio.wav"/);
  assert.match(body, /RIFF/);
  assert.doesNotMatch(body, new RegExp(h.jwt.replaceAll(".", "\\.")));
  h.done();
});

test("Suno upload refuses untrusted destinations and malformed receipts without following them", async () => {
  for (const value of [
    { ...presign, url: "https://untrusted.example/upload" },
    { ...presign, id: "not-an-upload-id" },
    { ...presign, fields: { 'x"\r\nInjected': "value" } },
  ]) {
    const h = replay([{ path: "/api/uploads/audio/", value }]);
    await assert.rejects(createSunoUploadAdapter(session, { fetchImpl: h.fetchImpl }).create("audio/mpeg", signal()));
    assert.equal(h.api().length, 1);
    h.done();
  }
  const h = replay([{ path: `/api/uploads/audio/${A}/initialize-clip/`, run: async () => { throw new Error("Lost response with synthetic private detail"); } }]);
  await assert.rejects(createSunoUploadAdapter(session, { fetchImpl: h.fetchImpl }).initialize(A, signal()),
    (error: unknown) => error instanceof Error && /unknown|failed/.test(error.message) && !error.message.includes("synthetic private detail"));
  assert.equal(h.api().length, 1);
});

test("Suno upload requires numeric account limits and handles terminal provider rejection", async () => {
  const h = replay([accountStep({}), { path: `/api/uploads/audio/${A}/`, value: { status: "error", error_message: "private provider details" } }]);
  const adapter = createSunoUploadAdapter(session, { fetchImpl: h.fetchImpl });
  await assert.rejects(adapter.limits(signal()));
  assert.deepEqual(await adapter.inspect(A, signal()), { status: "failed" });
  h.done();
});

test("Stop racing an initialization response preserves the acknowledged clip ID", async () => {
  const controller = new AbortController();
  const h = replay([{ path: `/api/uploads/audio/${A}/initialize-clip/`, run: async () => {
    controller.abort(); return Response.json({ clip_id: B });
  } }]);
  assert.equal(await createSunoUploadAdapter(session, { fetchImpl: h.fetchImpl }).initialize(A, controller.signal), B);
  assert.equal(h.api().length, 1);
  h.done();
});
