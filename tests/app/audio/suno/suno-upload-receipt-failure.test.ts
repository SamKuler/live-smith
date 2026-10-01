import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { retrievalHarness, connection, clipIds } from "../support/audio-retrieval-test-helpers.js";
import { captureIntegrationConnections, integrationConnectionFingerprint } from "../../../../src/app/plugins/integration-connections.js";
import { createAudioJob, updateAudioJob, bindAudioDirectory, listAudioJobs } from "../../../../src/storage/audio-jobs.js";
import { saveAudioAsset } from "../../../../src/storage/audio-assets.js";
import { loadSessionEvents } from "../../../../src/storage/events.js";
import { waveBytes } from "../../../storage/support/audio-storage-test-helpers.js";
import { loadAudioParameterGroups, runAudioParameterTool } from "../../../../src/app/audio/audio-parameter-tool.js";
import type { SunoUploadAdapter } from "../../../../src/audio-services/suno/suno-upload.js";
import { ChatBridgeCommandOutcomeUnknownError } from "../../../../src/app/chat/chat-bridge.js";
import { audioJobViews, resumeAudioJob } from "../../../../src/app/audio/audio-processing.js";

for (const phase of ["before-dispatch", "after-initialize"] as const) test(`manual upload preserves dispatch certainty when receipt storage fails ${phase}`, async (t) => {
  const h = await retrievalHarness(t);
  const settings = (await captureIntegrationConnections(h.directory))[0]!;
  const seed = await createAudioJob(h.directory, h.session.id, { provider: "suno", serviceId: connection.id,
    operation: "generate_music", stems: [], connectionFingerprint: integrationConnectionFingerprint(settings) });
  const asset = await saveAudioAsset(h.directory, h.session.id, { jobId: seed.id, role: "music", label: "Reference",
    bytes: waveBytes(6), origin: { kind: "generated" }, signal: h.controller.signal });
  await updateAudioJob(h.directory, h.session.id, seed.id, { status: "completed", outputAssets: [asset] });
  const directory = (await bindAudioDirectory(h.directory, h.session.id))!.directory;
  let blockedPath: string | undefined;
  let savedStage: string | undefined;
  const blockJobWrite = async () => {
    const job = (await listAudioJobs(h.directory, h.session.id)).find((job) => job.operation === "upload_music")!;
    savedStage = job.upload?.pendingStage;
    blockedPath = path.join(directory, `${job.id}.job.json`);
    await fs.rename(blockedPath, `${blockedPath}.backup`);
    await fs.mkdir(blockedPath);
  };
  const calls: string[] = [];
  const adapter: SunoUploadAdapter = {
    limits: async () => ({ minimumSeconds: 6, maximumSeconds: 60 }),
    create: async () => { calls.push("create"); return { uploadId: clipIds[0]!, url: "https://suno-data-uploads.s3.amazonaws.com/", fields: {} }; },
    upload: async () => { calls.push("upload"); },
    finish: async () => { calls.push("finish"); },
    inspect: async () => ({ status: "complete" }),
    initialize: async () => { calls.push("initialize"); await blockJobWrite(); return clipIds[1]!; },
  };
  const panel = (await loadAudioParameterGroups(h.directory, h.session.id)).groups.flatMap((group) => group.tools)
    .find((tool) => tool.name.endsWith("upload_music"))!.audioPanel!;
  let markerWriteFailed = false;
  if (phase === "before-dispatch") {
    const probe = await fs.open(path.join(h.directory, "write-probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
    const original = prototype.writeFile;
    await probe.close();
    t.mock.method(prototype, "writeFile", async function (this: fs.FileHandle, ...args: Parameters<fs.FileHandle["writeFile"]>) {
      if (typeof args[0] === "string" && args[0].includes('"pendingStage": "creating"')) {
        markerWriteFailed = true;
        throw new Error("Synthetic mutation marker write failure");
      }
      return original.apply(this, args);
    });
  }
  const run = () => runAudioParameterTool({ context: {} as never, storageDirectory: h.directory, sessionId: h.session.id,
    target: {}, signal: h.controller.signal, onProgress() {}, onAssets() {},
    withAdmissionAuthorization: async (_signal, operation) => operation(),
    withGenerationAuthorization: async (_signal, operation) => operation(),
    processing: { pluginOverrides: { uploadAdapter: adapter } }, toolName: panel.toolName, signature: panel.signature,
    arguments: { connectionId: connection.id, rightsConfirmed: true, source: { kind: "audio_asset", assetRef: asset.id } },
  });
  try {
    if (phase === "before-dispatch") assert.deepEqual(await run(), { failed: true });
    else await assert.rejects(run(), ChatBridgeCommandOutcomeUnknownError);
  } finally {
    if (blockedPath) { await fs.rmdir(blockedPath); await fs.rename(`${blockedPath}.backup`, blockedPath); }
  }
  const events = await loadSessionEvents(h.directory, h.session.id);
  assert.deepEqual(events.map((event) => event.kind), ["tool_call", "tool_result"]);
  const saved = (await listAudioJobs(h.directory, h.session.id)).find((job) => job.operation === "upload_music")!;
  if (phase === "before-dispatch") {
    assert.equal(markerWriteFailed, true);
    assert.equal(saved.upload?.stage, "prepared");
    assert.deepEqual(calls, []);
    assert.doesNotMatch(events[1]!.content, /"status":"unknown"/);
  } else {
    assert.equal(savedStage, "initializing");
    assert.equal(saved.upload?.stage, "processed");
    assert.equal(saved.upload?.pendingStage, "initializing");
    assert.equal(saved.upload?.clipId, undefined);
    assert.deepEqual(calls, ["create", "upload", "finish", "initialize"]);
    assert.equal(JSON.parse(events[1]!.content).status, "unknown");
    assert.equal((await audioJobViews(h.directory, h.session.id)).find((job) => job.id === saved.id)!.resumable, false);
    await assert.rejects(resumeAudioJob({ ...h.context, pluginOverrides: { uploadAdapter: adapter },
      withGenerationAuthorization: async (_signal, operation) => operation() }, saved.id), /cannot be sent again/);
    assert.deepEqual(calls, ["create", "upload", "finish", "initialize"]);
  }
});
