import assert from "node:assert/strict";
import test from "node:test";
import { retrievalHarness, connection, clipIds } from "./support/audio-retrieval-test-helpers.js";
import { createRequestAudioTools } from "../../src/app/request-audio-tools.js";
import { saveSessionAttachment, sessionAttachmentRefFromStored } from "../../src/storage/attachments.js";
import { waveBytes } from "../storage/support/audio-storage-test-helpers.js";
import { listAudioJobs } from "../../src/storage/audio-jobs.js";
import type { SunoUploadAdapter } from "../../src/audio-services/suno-upload.js";
import type { AudioGenerationRequest } from "../../src/audio-services/contracts.js";

test("a request-scoped attachment upload makes its acknowledged clip available to later creation tools", async (t) => {
  const h = await retrievalHarness(t);
  const bytes = waveBytes(6);
  const stored = await saveSessionAttachment(h.directory, h.session.id,
    { fileName: "reference.wav", bytes }, { preSavePendingAttachmentRefs: [] });
  const ref = sessionAttachmentRefFromStored(stored);
  assert.equal(ref.kind, "audio");
  if (ref.kind !== "audio") throw new Error("Expected audio fixture.");
  let uploads = 0;
  const generated: AudioGenerationRequest[] = [];
  const adapter: SunoUploadAdapter = {
    limits: async () => ({ minimumSeconds: 6, maximumSeconds: 60 }),
    create: async () => ({ uploadId: clipIds[0]!, url: "https://suno-data-uploads.s3.amazonaws.com/", fields: {} }),
    upload: async (_spec, actual) => { assert.deepEqual(actual, bytes); uploads++; },
    finish: async () => {}, inspect: async () => ({ status: "complete" }),
    initialize: async () => clipIds[1]!,
  };
  const tools = await createRequestAudioTools({
    context: {} as never, storageDirectory: h.directory, sessionId: h.session.id,
    requestId: "current-request", attachmentRefs: [ref], target: {}, signal: h.controller.signal,
    onProgress() {}, onAssets() {},
    withGenerationAuthorization: async (_signal, run) => run(),
    processing: { sunoUploadAdapter: adapter, wait: async () => {},
      generationAdapter: { provider: "suno", submit: async (request) => {
        generated.push(request); return { kind: "audio", outputs: [{ role: "music", bytes: waveBytes() }] };
      } },
    },
  });
  const execute = (name: string, argumentsValue: Record<string, unknown>) => tools.execute({
    id: "call", name: `builtin_suno_${name}`, arguments: JSON.stringify({ connectionId: connection.id, ...argumentsValue }),
  });
  const request = { rightsConfirmed: true, source: { kind: "request_audio_attachment", requestId: "other-request", audioIndex: 0 } };
  assert.equal((await execute("upload_music", request)).failed, true);
  assert.equal(uploads, 0);
  const uploaded = await execute("upload_music", { ...request, source: { ...request.source, requestId: "current-request" } });
  assert.equal(uploaded.failed, undefined);
  assert.equal(uploads, 1);
  assert.match(uploaded.content, new RegExp(clipIds[1]!));
  const result = await execute("add_vocals", { clipId: clipIds[1], prompt: "A new melody" });
  assert.equal(result.failed, undefined);
  assert.deepEqual(generated, [{ operation: "add_vocals", clipId: clipIds[1], prompt: "A new melody" }]);
  const jobs = await listAudioJobs(h.directory, h.session.id);
  assert.equal(jobs.filter((job) => job.upload?.clipId === clipIds[1]).length, 1);
  assert.equal(jobs.find((job) => job.upload)?.remoteOutputs?.[0]?.role, "uploaded_audio");
});
