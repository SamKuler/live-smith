import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";

import {
  SEPARATION_STEMS, type AudioGenerationAdapter, type AudioServiceAdapter,
  type AudioServiceConnection,
} from "../audio-services/contracts.js";
import { createHostAbortController } from "../runtime/host.js";
import { listAudioJobs } from "../storage/audio-jobs.js";
import { waveBytes, sessionInput } from "../storage/audio-storage-test-helpers.js";
import { saveSessionAttachment } from "../storage/attachments.js";
import { loadAgentSettings, saveGlobalSettings } from "../storage/settings.js";
import { createSession } from "../storage/sessions.js";
import {
  integrationConnectionFingerprint, availableIntegrationConnections, captureIntegrationConnections, resolveIntegrationConnection,
} from "./integration-connections.js";
import { createRequestAudioTools } from "./request-audio-tools.js";
import { builtInAudioToolName } from "../plugins/builtins/audio-toolsets.js";
import { builtInAudioPlugin } from "../plugins/builtins/index.js";
import {
  runtimeIntegrationConnectionFixture,
  saveIntegrationConnection,
} from "./integration-connection-test-helpers.js";

const owner: AudioServiceConnection = {
  id: "chosen", name: "Original account", provider: "elevenlabs", enabled: true,
  apiKey: "fixture-admission-owner-a",
};
const suno: AudioServiceConnection = {
  ...owner, provider: "sunoapi", modelId: "V4_5ALL", callbackUrl: "https://hooks.example.com/original",
};
const splitter: AudioServiceConnection = { ...owner, provider: "lalal" };
const toolName = (
  connection: AudioServiceConnection,
  operation: string,
) => builtInAudioToolName(builtInAudioPlugin(connection.provider), operation);
const musicCall = (connection: AudioServiceConnection = owner) => ({
  id: "generate",
  name: toolName(connection, "generate_music"),
  arguments: JSON.stringify({ connectionId: connection.id, prompt: "Piano", instrumental: true }),
});

async function harness(t: TestContext, connection = owner) {
  const storage = await fs.mkdtemp("/private/tmp/live-smith-audio-admission-");
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const session = await createSession(storage, sessionInput);
  const save = async (value: AudioServiceConnection) => {
    const settings = await loadAgentSettings(storage);
    await saveIntegrationConnection(
      storage,
      settings.integrationConnections?.revision ?? "0",
      value,
    );
  };
  const remove = async () => {
    const settings = await loadAgentSettings(storage);
    await saveGlobalSettings(storage, { integrationConnections: {
      action: "remove", expectedRevision: settings.integrationConnections!.revision,
      connectionId: connection.id,
    } });
  };
  await save(connection);
  const calls: string[] = [];
  const generationAdapter: AudioGenerationAdapter = {
    provider: connection.provider === "sunoapi" ? "sunoapi" : "elevenlabs",
    submit: async (request) => {
      calls.push("generate");
      return { kind: "audio", outputs: [{
        role: request.operation === "generate_music" ? "music" : "sound_effect", bytes: waveBytes(),
      }] };
    },
  };
  const adapter: AudioServiceAdapter = {
    provider: "lalal", stems: SEPARATION_STEMS,
    upload: async () => { calls.push("upload"); return "source"; },
    submit: async () => { calls.push("separate"); return "task"; },
    inspect: async () => { calls.push("inspect"); return { status: "failed", message: "Fixture terminal result" }; },
    download: async () => { throw new Error("Unexpected fixture download"); },
  };
  const input = {
    context: {} as never, storageDirectory: storage, sessionId: session.id,
    requestId: "request", attachmentRefs: [], target: {}, signal: createHostAbortController().signal,
    onProgress() {}, onAssets() {}, processing: { generationAdapter, adapter, wait: async () => {} },
  };
  return { storage, session, save, remove, input, generationAdapter, adapter, calls };
}

const driftCases: { name: string; initial?: AudioServiceConnection; replacement?: AudioServiceConnection }[] = [
  { name: "account key", replacement: { ...owner, apiKey: "fixture-admission-owner-b" } },
  { name: "connection label", replacement: { ...owner, name: "Replacement account" } },
  { name: "provider", replacement: { ...suno, apiKey: "fixture-admission-third-party" } },
  { name: "disable", replacement: { ...owner, enabled: false } },
  { name: "remove" },
  { name: "clear key", replacement: { ...owner, enabled: false, apiKey: "" } },
  { name: "model override added", replacement: { ...owner, modelId: "music_v2" } },
  { name: "model override changed", initial: { ...owner, modelId: "music_v1" }, replacement: { ...owner, modelId: "music_v2" } },
  { name: "model override removed", initial: { ...owner, modelId: "music_v1" }, replacement: owner },
  { name: "callback", initial: suno, replacement: { ...suno, callbackUrl: "https://hooks.example.com/replacement" } },
];

for (const scenario of driftCases) {
  test(`send admission blocks ${scenario.name} drift before generation`, async (t) => {
    const h = await harness(t, scenario.initial);
    // Matching the replacement provider makes this detect retargeting itself,
    // rather than succeeding because an injected adapter rejects that provider.
    if (scenario.name === "provider") h.input.processing.generationAdapter = { ...h.generationAdapter, provider: "sunoapi" };
    const tools = await createRequestAudioTools(h.input);
    const admitted = scenario.initial ?? owner;
    const declared = tools.tools.find((tool) =>
      tool.function.name === toolName(admitted, "generate_music"))!;
    assert.ok(declared);
    const properties = declared.function.parameters?.properties as Record<string, unknown>;
    assert.deepEqual(properties.connectionId, { type: "string", enum: [owner.id] });
    assert.match(declared.function.description, new RegExp((scenario.initial ?? owner).provider));
    if (scenario.replacement) await h.save(scenario.replacement);
    else await h.remove();
    const result = await tools.execute(musicCall(admitted));
    assert.equal(h.calls.length, 0, "a drifted admission must not submit or poll");
    assert.equal(result.failed, true);
    assert.equal(result.stop, true);
    assert.deepEqual(await listAudioJobs(h.storage, h.session.id), []);
    assert.doesNotMatch(JSON.stringify({ tools: tools.tools, result }), /fixture-admission-|hooks\.example\.com/);
  });
}

test("connection resolution rejects an ID absent from the admitted snapshot", async (t) => {
  const h = await harness(t);
  await assert.rejects(resolveIntegrationConnection(h.storage, owner.id, "generate_music", []), /admi|changed|unavailable/i);
});

test("capture retains only configured enabled connections and isolates every saved field", async (t) => {
  assert.deepEqual(await captureIntegrationConnections(undefined), []);
  const h = await harness(t, suno);
  await h.save({ ...owner, id: "disabled", name: "Disabled", enabled: false });
  await h.save({ ...owner, id: "empty", name: "Unconfigured", enabled: false, apiKey: "" });
  const admitted = await captureIntegrationConnections(h.storage);
  assert.deepEqual(admitted, [runtimeIntegrationConnectionFixture(suno)]);
  assert.deepEqual(await availableIntegrationConnections(h.storage), [{
    id: suno.id,
    name: suno.name,
    pluginId: builtInAudioPlugin(suno.provider).id,
    provider: suno.provider,
    modelId: suno.modelId,
  }]);
  await h.save({ ...suno, apiKey: "fixture-admission-owner-b", modelId: "V5", callbackUrl: "https://hooks.example.com/replacement" });
  assert.deepEqual(admitted, [runtimeIntegrationConnectionFixture(suno)]);
  assert.throws(() => { admitted[0]!.apiKey = "fixture-unintended-mutation"; }, TypeError);
  assert.equal(admitted[0]!.apiKey, suno.apiKey);
});

test("resolver errors do not expose admitted or replacement connection details", async (t) => {
  const h = await harness(t, suno);
  const admitted = await captureIntegrationConnections(h.storage);
  await h.save({ ...suno, apiKey: "fixture-admission-owner-b" });
  await assert.rejects(resolveIntegrationConnection(h.storage, suno.id, "generate_music", admitted), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /changed after this request was admitted/);
    assert.doesNotMatch(String(error), /fixture-admission-|hooks\.example\.com/);
    return true;
  });
  await assert.rejects(resolveIntegrationConnection(undefined, suno.id, "generate_music", admitted), /private persistent storage/);
});

test("admission preserves capability validation and callers without a send snapshot", async (t) => {
  const h = await harness(t);
  const admitted = await captureIntegrationConnections(h.storage);
  await assert.rejects(resolveIntegrationConnection(h.storage, owner.id, "separate_stems", admitted), /does not expose/);
  const replacement = { ...owner, apiKey: "fixture-admission-owner-b" };
  await h.save(replacement);
  assert.deepEqual(
    await resolveIntegrationConnection(h.storage, owner.id, "generate_music"),
    runtimeIntegrationConnectionFixture(replacement),
  );
});

test("connection resolution returns the original admitted object when another connection changes", async (t) => {
  const h = await harness(t);
  const admitted = await captureIntegrationConnections(h.storage);
  await h.save({ ...suno, id: "other", name: "Other account", apiKey: "fixture-other-account" });
  const resolved = await resolveIntegrationConnection(h.storage, owner.id, "generate_music", admitted);
  assert.equal(resolved, admitted[0]);
  assert.equal(
    integrationConnectionFingerprint(resolved),
    integrationConnectionFingerprint(runtimeIntegrationConnectionFixture(owner)),
  );
});

test("another connection changing does not invalidate advertised generation", async (t) => {
  const h = await harness(t);
  const other = { ...suno, id: "other", name: "Other account" };
  await h.save(other);
  const tools = await createRequestAudioTools(h.input);
  await h.save({ ...other, apiKey: "fixture-other-replacement", modelId: "V5", callbackUrl: "https://hooks.example.com/other" });
  const result = await tools.execute(musicCall());
  assert.equal(result.failed, undefined);
  assert.deepEqual(h.calls, ["generate"]);
  const [job] = await listAudioJobs(h.storage, h.session.id);
  assert.equal(job?.connectionFingerprint,
    integrationConnectionFingerprint(runtimeIntegrationConnectionFixture(owner)));
  assert.equal(job?.status, "completed");
});

test("a later send admits the replacement connection after rejecting an old send", async (t) => {
  const h = await harness(t);
  const oldSend = await createRequestAudioTools(h.input);
  const replacement = { ...owner, apiKey: "fixture-admission-owner-b" };
  await h.save(replacement);
  assert.equal((await oldSend.execute(musicCall())).failed, true);
  assert.deepEqual(h.calls, []);
  const newSend = await createRequestAudioTools(h.input);
  assert.equal((await newSend.execute(musicCall())).failed, undefined);
  assert.deepEqual(h.calls, ["generate"]);
  assert.equal((await listAudioJobs(h.storage, h.session.id))[0]?.connectionFingerprint,
    integrationConnectionFingerprint(runtimeIntegrationConnectionFixture(replacement)));
});

for (const state of ["added", "enabled"] as const) {
  test(`a connection ${state} after admission cannot join the existing send`, async (t) => {
    const h = await harness(t);
    const late = { ...owner, id: "late", name: "Later account" };
    if (state === "enabled") await h.save({ ...late, enabled: false });
    const admitted = await captureIntegrationConnections(h.storage);
    const tools = await createRequestAudioTools(h.input);
    await h.save(late);
    await assert.rejects(resolveIntegrationConnection(h.storage, late.id, "generate_music", admitted), /not admitted/);
    const result = await tools.execute({ ...musicCall(), arguments: JSON.stringify({
      connectionId: late.id, prompt: "Piano", instrumental: true,
    }) });
    assert.equal(result.invalidArguments, true);
    assert.deepEqual(h.calls, []);
  });
}

test("sound effects also retain the admitted credential owner", async (t) => {
  const h = await harness(t);
  const tools = await createRequestAudioTools(h.input);
  await h.save({ ...owner, apiKey: "fixture-admission-owner-b" });
  const result = await tools.execute({ id: "effect", name: toolName(owner, "generate_sound_effect"), arguments: JSON.stringify({
    connectionId: owner.id, prompt: "Wind", durationSeconds: 2, loop: false,
  }) });
  assert.deepEqual(h.calls, []);
  assert.equal(result.failed, true);
});

test("stem separation rejects a replaced connection before reading or uploading its input", async (t) => {
  const h = await harness(t, splitter);
  const ref = await saveSessionAttachment(h.storage, h.session.id,
    { fileName: "input.wav", bytes: waveBytes() }, { preSavePendingAttachmentRefs: [] });
  assert.equal(ref.kind, "audio");
  const tools = await createRequestAudioTools({ ...h.input, attachmentRefs: [ref] });
  await h.save({ ...splitter, apiKey: "fixture-admission-owner-b" });
  const result = await tools.execute({ id: "split", name: toolName(splitter, "separate_stems"), arguments: JSON.stringify({
    connectionId: owner.id, stems: ["vocals"], source: { kind: "request_audio_attachment", requestId: "request", audioIndex: 0 },
  }) });
  assert.deepEqual(h.calls, []);
  assert.equal(result.failed, true);
  assert.deepEqual(await listAudioJobs(h.storage, h.session.id), []);
});

test("generation rechecks admission after local preparation and before submit", async (t) => {
  const h = await harness(t);
  const tools = await createRequestAudioTools({ ...h.input, onProgress: async () => {
    await h.save({ ...owner, apiKey: "fixture-admission-owner-b" });
  } });
  const result = await tools.execute(musicCall());
  assert.deepEqual(h.calls, []);
  assert.equal(result.failed, true);
  assert.doesNotMatch(JSON.stringify(result), /fixture-admission-/);
});

for (const stage of ["before upload", "after upload"] as const) {
  test(`separation rechecks admission ${stage}`, async (t) => {
    const h = await harness(t, splitter);
    const ref = await saveSessionAttachment(h.storage, h.session.id,
      { fileName: "input.wav", bytes: waveBytes() }, { preSavePendingAttachmentRefs: [] });
    assert.equal(ref.kind, "audio");
    const replace = () => h.save({ ...splitter, apiKey: "fixture-admission-owner-b" });
    if (stage === "after upload") h.adapter.upload = async () => {
      h.calls.push("upload"); await replace(); return "source";
    };
    const tools = await createRequestAudioTools({ ...h.input, attachmentRefs: [ref], onProgress: async () => {
      if (stage === "before upload") await replace();
    } });
    const result = await tools.execute({ id: "split", name: toolName(splitter, "separate_stems"), arguments: JSON.stringify({
      connectionId: owner.id, stems: ["vocals"], source: { kind: "request_audio_attachment", requestId: "request", audioIndex: 0 },
    }) });
    assert.deepEqual(h.calls, stage === "before upload" ? [] : ["upload"]);
    assert.equal(result.failed, true);
    assert.doesNotMatch(JSON.stringify(result), /fixture-admission-/);
  });
}
