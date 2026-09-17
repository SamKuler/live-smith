import { formatUiMessage } from "../i18n/ui-message.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import * as processing from "./audio-processing.js";
import { retrieveMusic } from "./audio-generation.js";
import { listAudioAssets, saveAudioAsset } from "../storage/audio-assets.js";
import { loadAudioJob, updateAudioJob } from "../storage/audio-jobs.js";
import { overwriteJson, waveBytes } from "../storage/audio-storage-test-helpers.js";
import { clipIds, connection, fixtureToken, manifest, retrievalHarness } from "./audio-retrieval-test-helpers.js";

test("explicit download saves only the selected output and repeats offline without provider calls", async (t) => {
  const h = await retrievalHarness(t);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  const selected = await processing.downloadAudioOutput(h.context, job.id, clipIds[1]!);
  assert.equal(selected.status, "partial");
  assert.deepEqual(selected.outputAssets.map((asset) => asset.role), ["music_alternative"]);
  assert.deepEqual(selected.remoteOutputs, manifest);
  assert.deepEqual(h.calls.downloads, [clipIds[1]]);
  const before = { ...h.calls, downloads: [...h.calls.downloads] };
  await h.sessions.clear(connection.id);
  assert.equal((await processing.downloadAudioOutput(h.context, job.id, clipIds[1]!)).outputAssets.length, 1);
  assert.deepEqual(h.calls, before);
  assert.equal(h.calls.prepare + h.calls.submit, 0);
});

test("explicit selection restores committed unindexed local audio before resolving credentials", async (t) => {
  const h = await retrievalHarness(t);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  const asset = await saveAudioAsset(h.directory, h.session.id, { jobId: job.id, role: "music", label: "Music",
    bytes: waveBytes(), origin: { kind: "generated" }, signal: h.context.signal });
  await h.sessions.clear(connection.id);
  const recovered = await processing.downloadAudioOutput(h.context, job.id, clipIds[0]!);
  assert.equal(recovered.status, "partial");
  assert.deepEqual(recovered.outputAssets, [asset]);
  assert.deepEqual(h.calls.downloads, []);
});

test("account swap blocks selected output but renewed credentials for the original account work", async (t) => {
  const h = await retrievalHarness(t);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  await h.sessions.save(connection.id, { accountId: "user_other", clientToken: fixtureToken("other") });
  await assert.rejects(processing.downloadAudioOutput(h.context, job.id, clipIds[0]!), /different service connection/);
  assert.deepEqual(h.calls.downloads, []);
  await h.sessions.save(connection.id, { accountId: "user_fixture", clientToken: fixtureToken("renewed") });
  assert.equal((await processing.downloadAudioOutput(h.context, job.id, clipIds[0]!)).outputAssets.length, 1);
});

test("unknown or unsuccessful output cannot authorize a download", async (t) => {
  const h = await retrievalHarness(t);
  h.mode.failed.add(clipIds[0]!);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  for (const key of [clipIds[0]!, "cccccccc-3333-4333-8333-333333333333", clipIds[1]!.toUpperCase(), clipIds[1]! + "\n"]) {
    await assert.rejects(processing.downloadAudioOutput(h.context, job.id, key), /output|complete|identity/i);
  }
  assert.deepEqual(h.calls.downloads, []);
  assert.equal(h.calls.inspect, 1);
});

test("account changes during progress stop selected collection before calling its adapter", async (t) => {
  const h = await retrievalHarness(t);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  const result = await processing.downloadAudioOutput({ ...h.context,
    onProgress: () => h.sessions.save(connection.id, { accountId: "user_other", clientToken: fixtureToken("other") }),
  }, job.id, clipIds[0]!);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.outputAssets, []);
  assert.deepEqual(result.remoteOutputs, manifest);
  assert.deepEqual(h.calls.downloads, []);
  assert.match(formatUiMessage(result.message!), /changed/);
});

test("duplicate download, retrieval and Resume share the job lock and Stop releases it", async (t) => {
  const h = await retrievalHarness(t);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  h.adapter.download = async () => { entered.resolve(); await proceed.promise; return waveBytes(); };
  const pending = processing.downloadAudioOutput(h.context, job.id, clipIds[0]!);
  const stopped = assert.rejects(pending);
  try {
    await entered.promise;
    await assert.rejects(processing.downloadAudioOutput(h.context, job.id, clipIds[0]!), /already running/);
    await assert.rejects(processing.resumeAudioJob(h.context, job.id), /already running/);
    await assert.rejects(retrieveMusic(h.context, connection.id, clipIds), /already running/);
    h.controller.abort();
  } finally { proceed.resolve(); }
  await stopped;
  const saved = await loadAudioJob(h.directory, h.session.id, job.id);
  assert.equal(saved.status, "ready");
  assert.deepEqual(saved.remoteOutputs, manifest);
  assert.deepEqual(await listAudioAssets(h.directory, h.session.id), []);
  const context = { ...h.context, signal: new AbortController().signal };
  assert.equal((await processing.downloadAudioOutput(context, job.id, clipIds[0]!)).outputAssets.length, 1);
});

test("failed and invalid downloads preserve previews and saved siblings without replay", async (t) => {
  const h = await retrievalHarness(t);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  h.mode.locked.add(clipIds[0]!);
  const failed = await processing.downloadAudioOutput(h.context, job.id, clipIds[0]!);
  assert.equal(failed.status, "ready");
  assert.deepEqual(failed.outputAssets, []);
  h.mode.locked.clear();
  await processing.downloadAudioOutput(h.context, job.id, clipIds[1]!);
  h.mode.invalid.add(clipIds[0]!);
  const partial = await processing.downloadAudioOutput(h.context, job.id, clipIds[0]!);
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.outputAssets.map((asset) => asset.role), ["music_alternative"]);
  assert.deepEqual(partial.remoteOutputs, manifest);
  const before = [...h.calls.downloads];
  await processing.resumeAudioJob(h.context, job.id);
  assert.deepEqual(h.calls.downloads, before);
  h.mode.invalid.clear();
  const complete = await processing.downloadAudioOutput(h.context, job.id, clipIds[0]!);
  assert.equal(complete.status, "completed");
  await updateAudioJob(h.directory, h.session.id, job.id, { status: "collecting", outputAssets: [] });
  await h.sessions.clear(connection.id);
  assert.equal((await processing.resumeAudioJob(h.context, job.id)).status, "completed");
});

test("local selected output corruption fails before any provider request even on completed jobs", async (t) => {
  const h = await retrievalHarness(t);
  const job = await retrieveMusic(h.context, connection.id, clipIds.slice(0, 1));
  const saved = await processing.downloadAudioOutput(h.context, job.id, clipIds[0]!);
  const asset = saved.outputAssets[0]!;
  await fs.writeFile(`${h.directory}/live-smith-audio/${h.session.id}/${asset.id}.audio`, waveBytes(2));
  const before = { ...h.calls, downloads: [...h.calls.downloads] };
  await assert.rejects(processing.downloadAudioOutput(h.context, job.id, clipIds[0]!));
  assert.deepEqual(h.calls, before);
});

test("legacy completed local files without remoteOutputs reuse offline before account checks", async (t) => {
  const h = await retrievalHarness(t);
  const job = await retrieveMusic(h.context, connection.id, clipIds.slice(0, 1));
  const saved = await processing.downloadAudioOutput(h.context, job.id, clipIds[0]!);
  const { remoteOutputs: _remote, ...legacy } = saved;
  await overwriteJson(`${h.directory}/live-smith-audio/${h.session.id}/${job.id}.job.json`, legacy);
  await h.sessions.clear(connection.id);
  const before = { ...h.calls, downloads: [...h.calls.downloads] };
  const result = await processing.downloadAudioOutput(h.context, job.id, clipIds[0]!);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.outputAssets, saved.outputAssets);
  assert.equal(result.remoteOutputs, undefined);
  assert.deepEqual(h.calls, before);
});

test("a selected blob committed before a storage failure remains recoverable offline without another download", async (t) => {
  const h = await retrievalHarness(t);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  const probe = await fs.open(h.directory);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  const sync = prototype.sync;
  await probe.close();
  const fault = t.mock.method(prototype, "sync", async function (this: fs.FileHandle) {
    if ((await this.stat()).isDirectory() && (await fs.readdir(`${h.directory}/live-smith-audio/${h.session.id}`))
      .some((name) => name.endsWith(".audio"))) throw new Error("bookkeeping unavailable after blob commit");
    return sync.call(this);
  });
  try { await assert.rejects(processing.downloadAudioOutput(h.context, job.id, clipIds[0]!)); }
  finally { fault.mock.restore(); }
  await h.sessions.clear(connection.id);
  const before = { ...h.calls, downloads: [...h.calls.downloads] };
  const recovered = await processing.downloadAudioOutput(h.context, job.id, clipIds[0]!);
  assert.equal(recovered.status, "partial");
  assert.deepEqual(recovered.outputAssets.map((asset) => asset.role), ["music"]);
  assert.deepEqual(recovered.remoteOutputs, manifest);
  assert.deepEqual(h.calls, before);
  assert.deepEqual(h.calls.downloads, [clipIds[0]]);
});
