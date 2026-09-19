import { formatUiMessage } from "../i18n/ui-message.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { MAX_AUDIO_ASSET_BYTES } from "../audio-services/contracts.js";
import { createAudioJob, listAudioJobs } from "../storage/audio-jobs.js";
import { createSession } from "../storage/sessions.js";
import { integrationConnectionFingerprint, captureIntegrationConnections } from "./integration-connections.js";
import { retrieveMusic } from "./audio-generation.js";
import { downloadAudioOutput, resumeAudioJob } from "./audio-processing.js";
import { clipIds, connection, fixtureToken, manifest, retrievalHarness } from "./audio-retrieval-test-helpers.js";
import { saveIntegrationConnection } from "./integration-connection-test-helpers.js";

test("duplicate retrieval and Resume share exclusion while a manifest is collecting", async (t) => {
  const h = await retrievalHarness(t);
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const inspect = h.adapter.inspect!;
  h.adapter.inspect = async (...args) => {
    entered.resolve();
    await proceed.promise;
    return inspect(...args);
  };
  const pending = retrieveMusic(h.context, connection.id, clipIds);
  try {
    await entered.promise;
    const saved = (await listAudioJobs(h.directory, h.session.id))[0]!;
    await assert.rejects(retrieveMusic(h.context, connection.id, [...clipIds].reverse()), /already running/);
    await assert.rejects(resumeAudioJob(h.context, saved.id), /already running/);
    assert.equal((await listAudioJobs(h.directory, h.session.id)).length, 1);
  } finally { proceed.resolve(); }
  const saved = await pending;
  assert.equal((await retrieveMusic(h.context, connection.id, clipIds)).id, saved.id);
  assert.equal(h.calls.inspect, 1);
});

test("remote failed siblings and invalid audio preserve successful outputs for recovery", async (t) => {
  for (const kind of ["failed", "invalid"] as const) await t.test(kind, async (t) => {
    const h = await retrievalHarness(t);
    h.mode[kind].add(clipIds[0]!);
    const job = await retrieveMusic(h.context, connection.id, clipIds);
    const partial = await downloadAudioOutput(h.context, job.id, clipIds[1]!);
    if (kind === "invalid") await downloadAudioOutput(h.context, job.id, clipIds[0]!);
    assert.equal(partial.status, "partial");
    assert.deepEqual(partial.outputAssets.map((asset) => asset.role), ["music_alternative"]);
    h.mode[kind].clear();
    const resumed = await resumeAudioJob(h.context, partial.id);
    assert.deepEqual(resumed.remoteOutputs, kind === "failed" ? [manifest[1]] : manifest);
    assert.equal(resumed.outputAssets.length, 1);
    if (kind === "failed") await assert.rejects(downloadAudioOutput(h.context, partial.id, clipIds[0]!), /not been observed complete/);
    else assert.equal((await downloadAudioOutput(h.context, partial.id, clipIds[0]!)).status, "completed");
    assert.equal(h.calls.downloads.filter((key) => key === clipIds[1]).length, 1);
    assert.equal(h.calls.prepare + h.calls.submit, 0);
  });
});

test("remote output identities cannot replace the selected retrieval manifest", async (t) => {
  const h = await retrievalHarness(t);
  h.mode.changed = true;
  const result = await retrieveMusic(h.context, connection.id, clipIds);
  assert.equal(result.status, "interrupted");
  assert.deepEqual(result.expectedOutputs, manifest);
  assert.deepEqual(h.calls.downloads, []);
  h.mode.changed = false;
  assert.equal((await retrieveMusic(h.context, connection.id, clipIds)).status, "ready");
});

test("preview retrieval works at full local capacity and selected download checks capacity before remote calls", async (t) => {
  const h = await retrievalHarness(t);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  const directory = `${h.directory}/live-smith-audio/${h.session.id}`;
  for (let index = 0; index < 8; index++) {
    const file = await fs.open(`${directory}/quota-${index}.audio`, "wx");
    try { await file.truncate(MAX_AUDIO_ASSET_BYTES); } finally { await file.close(); }
  }
  assert.equal((await retrieveMusic(h.context, connection.id, clipIds.slice(0, 1))).status, "ready");
  assert.equal((await listAudioJobs(h.directory, h.session.id)).length, 2);
  assert.equal((await retrieveMusic(h.context, connection.id, clipIds)).id, job.id);
  const before = h.calls.inspect;
  const blocked = await downloadAudioOutput(h.context, job.id, clipIds[0]!);
  assert.equal(blocked.status, "ready");
  assert.match(formatUiMessage(blocked.message!), /capacity|storage limit/i);
  assert.equal(h.calls.inspect, before);
  assert.deepEqual(h.calls.downloads, []);
});

test("reuse stays within its exact Session and service even when account and manifest match", async (t) => {
  const h = await retrievalHarness(t);
  const original = await retrieveMusic(h.context, connection.id, clipIds);
  const session = await createSession(h.directory, { title: "Another Session", projectKey: "fixture",
    scope: { kind: "selection", identity: "other", label: "Audio" } });
  const otherSession = await retrieveMusic({ ...h.context, sessionId: session.id }, connection.id, clipIds);
  assert.notEqual(otherSession.id, original.id);
  await saveIntegrationConnection(h.directory, "1", {
    ...connection,
    id: "another",
    name: "Another connection",
  });
  await h.sessions.save("another", { accountId: "user_fixture", clientToken: fixtureToken("another") });
  const otherService = await retrieveMusic(h.context, "another", clipIds);
  assert.notEqual(otherService.id, original.id);
  assert.equal((await listAudioJobs(h.directory, h.session.id)).length, 2);
});

test("repeated retrieval reuses a receipt left by a crash before first inspection at the job limit", async (t) => {
  const h = await retrievalHarness(t);
  const selected = (await captureIntegrationConnections(h.directory))[0]!;
  const config = { provider: "suno" as const, serviceId: connection.id, operation: "retrieve_music" as const,
    connectionFingerprint: integrationConnectionFingerprint(selected), stems: [] };
  const job = await createAudioJob(h.directory, h.session.id, config, { remoteTaskId: clipIds[0]!, expectedOutputs: manifest });
  for (let index = 1; index < 40; index++) {
    await createAudioJob(h.directory, h.session.id, { ...config, operation: "generate_music" });
  }
  const result = await retrieveMusic(h.context, connection.id, clipIds);
  assert.equal(result.id, job.id);
  assert.equal(result.status, "ready");
  assert.equal((await listAudioJobs(h.directory, h.session.id)).length, 40);
  assert.equal(h.calls.prepare + h.calls.submit, 0);
});
