import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "../agent/loop.js";
import { createRequestAudioTools } from "./request-audio-tools.js";
import { downloadAudioOutput, retrieveMusic } from "./audio-generation.js";
import { saveGlobalSettings } from "../storage/settings.js";
import { listAudioJobs } from "../storage/audio-jobs.js";
import { listAudioAssets } from "../storage/audio-assets.js";
import { clipIds, connection, fixtureToken, manifest, retrievalHarness } from "./audio-retrieval-test-helpers.js";
import { builtInAudioToolName } from "../plugins/builtins/audio-toolsets.js";
import { sunoWebsitePlugin } from "../plugins/builtins/suno-website.js";

async function toolsFor(h: Awaited<ReturnType<typeof retrievalHarness>>, observed = clipIds.slice(0, 1)) {
  const assets: string[] = [];
  const tools = await createRequestAudioTools({ context: {} as never, storageDirectory: h.directory,
    sessionId: h.session.id, requestId: "request", attachmentRefs: [], target: {}, signal: h.controller.signal,
    onProgress() {}, onAssets(values) { assets.push(...values.map((asset) => asset.id)); },
    processing: { generationAdapter: h.adapter,
      musicServiceReader: async () => ({ query: "library", hasMore: false,
        clips: observed.map((id) => ({ id, title: "Fixture song", status: "complete", modelId: "fixture-model", styles: "piano" })) }),
    } });
  const execute = (name: string, args: unknown) => tools.execute({
    id: "call",
    name: ["list_audio_jobs", "resume_audio_job", "listen_to_audio_asset"].includes(name)
      ? name
      : builtInAudioToolName(sunoWebsitePlugin, name),
    arguments: JSON.stringify(args),
  });
  const retrieve = (serviceId = connection.id, ids = clipIds) => execute("retrieve_music", { serviceId, clipIds: ids });
  return { tools, assets, execute, retrieve };
}

test("tool retrieval requires every ID observed on the selected connection and dispatches without generation", async (t) => {
  const h = await retrievalHarness(t);
  await saveGlobalSettings(h.directory, { audioServices: { action: "upsert", expectedRevision: "1", connection: { ...connection, id: "work", name: "Work" } } });
  await h.sessions.save("work", { accountId: "user_work", clientToken: fixtureToken("work") });
  const observed = clipIds.slice(0, 1);
  const tools = await toolsFor(h, observed);
  assert.equal((await tools.retrieve()).invalidArguments, true);
  await tools.execute("inspect_music_service", { serviceId: connection.id, query: "library" });
  assert.equal((await tools.retrieve()).invalidArguments, true, "one observed ID cannot authorize a second ID");
  assert.equal((await tools.retrieve("work", observed)).invalidArguments, true);
  assert.equal((await listAudioJobs(h.directory, h.session.id)).length, 0);
  observed.push(clipIds[1]!);
  await tools.execute("inspect_music_service", { serviceId: connection.id, query: "library" });
  const result = await tools.retrieve();
  assert.equal(result.failed, undefined);
  assert.equal(result.stop, undefined);
  const job = JSON.parse(result.content);
  assert.equal(job.operation, "retrieve_music");
  assert.equal(job.status, "ready");
  assert.deepEqual(job.remoteOutputs, manifest);
  assert.deepEqual(job.outputs, []);
  assert.deepEqual(tools.assets, []);
  assert.deepEqual(await listAudioAssets(h.directory, h.session.id), []);
  assert.deepEqual(job.musicClips.map((entry: { clipId: string }) => entry.clipId), clipIds);
  assert.doesNotMatch(result.content, /clientToken|connectionFingerprint|https?:|\/api\/download|fixture-signature/);
  assert.deepEqual(h.calls, { prepare: 0, submit: 0, inspect: 1, downloads: [] });
});

test("same-account saved jobs reuse ready previews across requests regardless of download lock", async (t) => {
  const h = await retrievalHarness(t);
  h.mode.locked.add(clipIds[1]!);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  await h.sessions.save(connection.id, { accountId: "user_fixture", clientToken: fixtureToken("renewed") });
  const tools = await toolsFor(h, []);
  const ready = await tools.retrieve();
  assert.equal(ready.failed, undefined);
  assert.equal(ready.stop, undefined);
  assert.equal(JSON.parse(ready.content).id, job.id);
  assert.equal(JSON.parse(ready.content).status, "ready");
  assert.deepEqual(JSON.parse(ready.content).remoteOutputs, manifest);
  assert.deepEqual(JSON.parse(ready.content).outputs, []);
  h.mode.locked.clear();
  const recovered = await tools.retrieve();
  assert.equal(recovered.failed, undefined);
  assert.equal(recovered.stop, undefined);
  assert.equal(JSON.parse(recovered.content).id, job.id);
  assert.equal(JSON.parse(recovered.content).status, "ready");
  assert.deepEqual(JSON.parse(recovered.content).remoteOutputs, manifest);
  assert.deepEqual(JSON.parse(recovered.content).outputs, []);
  assert.deepEqual(tools.assets, []);
  assert.deepEqual(await listAudioAssets(h.directory, h.session.id), []);
  assert.deepEqual(h.calls, { prepare: 0, submit: 0, inspect: 1, downloads: [] });
  assert.equal((await listAudioJobs(h.directory, h.session.id)).length, 1);
});

test("saved jobs from another account do not authorize retrieval, even after listing", async (t) => {
  const h = await retrievalHarness(t);
  await retrieveMusic(h.context, connection.id, clipIds);
  await h.sessions.save(connection.id, { accountId: "user_other", clientToken: fixtureToken("other") });
  const tools = await toolsFor(h);
  await tools.execute("list_audio_jobs", {});
  assert.equal((await tools.retrieve()).invalidArguments, true);
  assert.equal(h.calls.inspect, 1);
});

test("a saved job created after admission becomes observable through list_audio_jobs", async (t) => {
  const h = await retrievalHarness(t);
  const tools = await toolsFor(h);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  assert.equal((await tools.retrieve()).invalidArguments, true);
  await tools.execute("list_audio_jobs", {});
  assert.equal(JSON.parse((await tools.retrieve()).content).id, job.id);
  assert.equal(h.calls.inspect, 1);
});

test("retrieval and Resume allow the model to continue with one explicitly saved variant", async (t) => {
  const h = await retrievalHarness(t);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  const selected = await downloadAudioOutput(h.context, job.id, clipIds[0]!);
  const tools = await toolsFor(h, []);
  for (const result of [await tools.retrieve(), await tools.execute("resume_audio_job", { jobId: job.id })]) {
    assert.equal(result.failed, undefined);
    assert.equal(result.stop, undefined);
    const view = JSON.parse(result.content);
    assert.equal(view.status, "partial");
    assert.deepEqual(view.outputs, selected.outputAssets);
    assert.deepEqual(view.remoteOutputs, manifest);
    assert.ok(tools.assets.includes(selected.outputAssets[0]!.id), "the saved asset remains available for follow-up Live actions");
  }
  let turns = 0;
  const continued = await runAgentLoop({
    maxConsecutiveFailures: 2,
    externalTools: { names: ["resume_audio_job"], execute: tools.tools.execute },
    askModel: async ({ messages }) => {
      if (++turns === 1) return { content: null, toolCalls: [{ id: "resume", name: "resume_audio_job", arguments: JSON.stringify({ jobId: job.id }) }] };
      const result = JSON.parse(messages.at(-1)!.content!);
      assert.equal(result.outputs[0].id, selected.outputAssets[0]!.id);
      assert.ok(tools.assets.includes(result.outputs[0].id));
      return { content: "The selected saved audio is available for the requested Live import.", toolCalls: [] };
    },
    observe: async () => { throw new Error("Retrieval must not observe Live."); },
    confirmActions: async () => { throw new Error("Retrieval must not request Live approval."); },
    executeActions: async () => { throw new Error("Retrieval must not mutate Live."); },
  });
  assert.equal(turns, 2, "normal partial collection must reach the model's next turn");
  assert.equal(continued.message, "The selected saved audio is available for the requested Live import.");
  assert.deepEqual(h.calls.downloads, [clipIds[0]]);
});

test("a genuinely failed remote sibling still reports partial processing failure", async (t) => {
  const h = await retrievalHarness(t);
  h.mode.failed.add(clipIds[1]!);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  await downloadAudioOutput(h.context, job.id, clipIds[0]!);
  const tools = await toolsFor(h, []);
  const inspections = h.calls.inspect;
  const result = await tools.execute("resume_audio_job", { jobId: job.id });
  assert.equal(result.failed, true);
  assert.equal(result.stop, true);
  const content = JSON.parse(result.content);
  assert.deepEqual(content.remoteOutputs, [manifest[0]]);
  assert.deepEqual(content.musicClips, [{ clipId: manifest[0]!.key, role: manifest[0]!.role }]);
  assert.equal(h.calls.inspect, inspections);
  assert.equal((await tools.retrieve(connection.id, [clipIds[1]!])).invalidArguments, true);
});
