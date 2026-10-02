import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
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
  const audio = waveBytes(6);
  const prefix = Buffer.from("unrelated-prefix");
  const backing = Buffer.concat([prefix, audio, Buffer.from("unrelated-suffix")]);
  await adapter.upload(spec, backing.subarray(prefix.byteLength, prefix.byteLength + audio.byteLength), "audio/wav", signal());
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
  const request = new Request(storage.url, storage.init);
  assert.match(request.headers.get("Content-Type")!, /^multipart\/form-data; boundary=/);
  const body = await request.formData();
  assert.deepEqual([...body.keys()], [...Object.keys(presign.fields), "file"]);
  for (const [name, value] of Object.entries(presign.fields)) assert.equal(body.get(name), value);
  const file = body.get("file") as File;
  assert.equal(file.name, "audio.wav");
  assert.equal(file.type, "audio/wav");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(waveBytes(6)));
  h.done();
});

test("an older host rejects the upload workflow before requesting remote authorization", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "FormData")!;
  Object.defineProperty(globalThis, "FormData", { configurable: true, value: undefined });
  t.after(() => Object.defineProperty(globalThis, "FormData", descriptor));
  let requests = 0;
  const fetchImpl = (async () => { requests += 1; return new Response(null, { status: 204 }); }) as typeof fetch;
  assert.throws(() => createSunoUploadAdapter(session, { fetchImpl }), /12\.4\.15b5/);
  assert.equal(requests, 0);
});

for (const stop of ["cancel", "timeout"] as const) {
  test(`Suno upload ${stop} stops waiting and disposes a late storage response`, async (t) => {
    if (stop === "timeout") {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      syncBuiltinESMExports();
      t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
    }
    const response = Promise.withResolvers<Response>();
    let uploadSignal: AbortSignal | undefined;
    let calls = 0;
    const adapter = createSunoUploadAdapter(session, { fetchImpl: (async (_url, init) => {
      calls += 1;
      uploadSignal = init?.signal ?? undefined;
      return response.promise;
    }) as typeof fetch });
    const controller = new AbortController();
    const pending = adapter.upload({ uploadId: A, url: destination, fields: presign.fields }, waveBytes(), "audio/wav", controller.signal);
    const rejected = assert.rejects(pending, /storage upload did not return a confirmed result/);
    if (stop === "cancel") controller.abort();
    else t.mock.timers.tick(10 * 60_000);
    await rejected;
    assert.equal(uploadSignal?.aborted, true);
    let disposed = false;
    response.resolve(new Response(new ReadableStream({ cancel() { disposed = true; } })));
    await nextTurn();
    assert.equal(disposed, true);
    assert.equal(calls, 1);
  });
}

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
