import assert from "node:assert/strict";
import test from "node:test";
import { retrieveMusic } from "./audio-generation.js";
import { downloadAudioOutput, resumeAudioJob } from "./audio-processing.js";
import { integrationConnectionFingerprint, captureIntegrationConnections } from "./integration-connections.js";
import { createAudioJob, listAudioJobs, loadAudioJob, updateAudioJob } from "../storage/audio-jobs.js";
import { clipIds, connection, fixtureToken, manifest, retrievalHarness } from "./audio-retrieval-test-helpers.js";
import { saveIntegrationConnection } from "./integration-connection-test-helpers.js";

test("retrieval validates one or two unique canonical UUIDs before any job or service call", async (t) => {
  const h = await retrievalHarness(t);
  for (const ids of [[], [...clipIds, "cccccccc-3333-4333-8333-333333333333"], [clipIds[0], clipIds[0]],
    ["../clip"], [`https://suno.com/song/${clipIds[0]}`], [clipIds[0]!.toUpperCase()], [clipIds[0] + "\n"],
    [null], null, "clip"]) {
    await assert.rejects(retrieveMusic(h.context, connection.id, ids as never), /clip|UUID/i);
  }
  assert.deepEqual(await listAudioJobs(h.directory, h.session.id), []);
  assert.deepEqual(h.calls, { prepare: 0, submit: 0, inspect: 0, downloads: [] });
});

test("retrieval saves a sorted manifest and reuses the exact job for reordered IDs", async (t) => {
  const h = await retrievalHarness(t);
  const input = Object.freeze([...clipIds].reverse());
  const job = await retrieveMusic(h.context, connection.id, input);
  assert.equal(job.operation, "retrieve_music");
  assert.equal(job.status, "ready");
  assert.equal(job.modelId, undefined);
  assert.equal(job.remoteTaskId, clipIds[0]);
  assert.deepEqual(job.expectedOutputs, manifest);
  assert.deepEqual(input, [...clipIds].reverse());
  assert.deepEqual(job.outputAssets, []);
  assert.deepEqual(job.remoteOutputs, manifest);
  assert.equal((await retrieveMusic(h.context, connection.id, clipIds)).id, job.id);
  assert.equal((await listAudioJobs(h.directory, h.session.id)).length, 1);
  assert.deepEqual(h.calls, { prepare: 0, submit: 0, inspect: 1, downloads: [] });
});

test("locked songs are previewable and repeated retrieval never downloads missing files", async (t) => {
  const h = await retrievalHarness(t);
  h.mode.locked = new Set(clipIds);
  const locked = await retrieveMusic(h.context, connection.id, clipIds);
  assert.equal(locked.status, "ready");
  assert.deepEqual(locked.expectedOutputs, manifest);
  h.mode.locked.delete(clipIds[0]!);
  await downloadAudioOutput(h.context, locked.id, clipIds[0]!);
  const partial = await retrieveMusic(h.context, connection.id, clipIds);
  assert.equal(partial.id, locked.id);
  assert.equal(partial.status, "partial");
  assert.equal(partial.outputAssets.length, 1);
  h.mode.locked.clear();
  const before = [...h.calls.downloads];
  const ready = await retrieveMusic(h.context, connection.id, [...clipIds].reverse());
  assert.equal(ready.status, "partial");
  assert.deepEqual(h.calls.downloads, before);
  const completed = await downloadAudioOutput(h.context, locked.id, clipIds[1]!);
  assert.equal(completed.id, locked.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(h.calls.downloads.slice(before.length), [clipIds[1]]);
  assert.equal(h.calls.prepare + h.calls.submit, 0);
});

test("recovery allows a renewed Cookie for the same account and denies another account", async (t) => {
  const h = await retrievalHarness(t);
  h.mode.failed.add(clipIds[1]!);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  await h.sessions.save(connection.id, { accountId: "user_other", clientToken: fixtureToken("other") });
  const terminal = await resumeAudioJob(h.context, job.id);
  assert.equal(terminal.id, job.id);
  assert.equal(terminal.status, "ready");
  await assert.rejects(retrieveMusic(h.context, connection.id, clipIds), /different service connection/);
  assert.equal(h.calls.inspect, 1);
  assert.equal((await listAudioJobs(h.directory, h.session.id)).length, 1);
  await h.sessions.save(connection.id, { accountId: "user_fixture", clientToken: fixtureToken("renewed") });
  h.mode.failed.clear();
  const recovered = await retrieveMusic(h.context, connection.id, clipIds);
  assert.equal(recovered.id, job.id);
  assert.equal(recovered.status, "ready");
  assert.deepEqual(h.calls.downloads, []);
  assert.equal(h.calls.submit + h.calls.prepare, 0);
});

test("Stop preserves IDs and the owner lock is released for resume", async (t) => {
  const h = await retrievalHarness(t);
  h.mode.stop = true;
  await assert.rejects(retrieveMusic(h.context, connection.id, clipIds));
  const job = (await listAudioJobs(h.directory, h.session.id))[0]!;
  assert.equal(job.status, "interrupted");
  assert.deepEqual(job.expectedOutputs, manifest);
  h.mode.stop = false;
  assert.equal((await resumeAudioJob({ ...h.context, signal: new AbortController().signal }, job.id)).status, "ready");
  assert.deepEqual(h.calls.downloads, []);
  assert.equal(h.calls.submit + h.calls.prepare, 0);
});

test("complete saved files recover offline even after disconnecting the account", async (t) => {
  const h = await retrievalHarness(t);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  for (const key of clipIds) await downloadAudioOutput(h.context, job.id, key);
  await updateAudioJob(h.directory, h.session.id, job.id, { status: "collecting", outputAssets: [] });
  const inspections = h.calls.inspect;
  await h.sessions.clear(connection.id);
  const restored = await resumeAudioJob(h.context, job.id);
  assert.equal(restored.status, "completed");
  assert.equal(restored.outputAssets.length, 2);
  assert.equal(h.calls.inspect, inspections);
});

test("retrieval cannot retarget an unknown paid job but can reuse an exact confirmed receipt", async (t) => {
  const h = await retrievalHarness(t);
  const settings = (await captureIntegrationConnections(h.directory))[0]!;
  const original = await createAudioJob(h.directory, h.session.id, { provider: "suno", serviceId: connection.id,
    connectionFingerprint: integrationConnectionFingerprint(settings), operation: "generate_music", stems: [] });
  await updateAudioJob(h.directory, h.session.id, original.id, { status: "unknown" });
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  assert.notEqual(job.id, original.id);
  assert.equal((await loadAudioJob(h.directory, h.session.id, original.id)).remoteTaskId, undefined);
  const single = await updateAudioJob(h.directory, h.session.id, original.id, {
    status: "interrupted", remoteTaskId: clipIds[0]!, expectedOutputs: manifest.slice(0, 1),
  });
  assert.equal((await retrieveMusic(h.context, connection.id, clipIds.slice(0, 1))).id, single.id);
  assert.equal(h.calls.prepare + h.calls.submit, 0);
});

test("retrieval requires the exact enabled admitted account before creating a record", async (t) => {
  const h = await retrievalHarness(t);
  const admittedConnections = await captureIntegrationConnections(h.directory);
  await assert.rejects(retrieveMusic({ ...h.context, admittedConnections: [] }, connection.id, clipIds), /not admitted/);
  await h.sessions.save(connection.id, { accountId: "user_other", clientToken: fixtureToken("changed") });
  await assert.rejects(retrieveMusic({ ...h.context, admittedConnections }, connection.id, clipIds), /changed/);
  await saveIntegrationConnection(h.directory, "1", { ...connection, enabled: false });
  await assert.rejects(retrieveMusic(h.context, connection.id, clipIds), /unavailable/);
  assert.equal((await listAudioJobs(h.directory, h.session.id)).length, 0);
  assert.equal(h.calls.inspect + h.calls.prepare + h.calls.submit, 0);
});
