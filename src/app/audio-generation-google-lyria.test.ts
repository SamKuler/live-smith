import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";

import type { AudioGenerationAdapter } from "../audio-services/contracts.js";
import {
  builtInAudioLocalToolName,
  createBuiltInAudioToolsets,
} from "../plugins/builtins/audio-toolsets.js";
import { readAudioAsset } from "../storage/audio-assets.js";
import { listAudioJobs, updateAudioJob } from "../storage/audio-jobs.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { createSession } from "../storage/sessions.js";
import { saveGlobalSettings } from "../storage/settings.js";
import { generateAudio } from "./audio-generation.js";
import { audioJobViews, resumeAudioJob } from "./audio-processing.js";
import { saveIntegrationConnection } from "./integration-connection-test-helpers.js";
import { googleLyriaPlugin } from "../plugins/builtins/google-lyria.js";

const pluginTools = (services: Parameters<typeof createBuiltInAudioToolsets>[0]["services"]) =>
  createBuiltInAudioToolsets({
    services,
    includeModelAudioInput: false,
    execute: async () => ({ content: "unused" }),
  }).flatMap((toolset) => toolset.tools());
const musicTool = (services: Parameters<typeof pluginTools>[0]) =>
  pluginTools(services).find((entry) =>
    builtInAudioLocalToolName(entry.function.name) === "generate_music");

async function harness(
  t: { after(fn: () => Promise<void>): void },
  modelId: "lyria-3.5" | "lyria-3-clip-preview" | "lyria-realtime-exp",
) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-google-lyria-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Google Lyria", projectKey: "project",
    scope: { kind: "selection", identity: "selection", label: "Audio" } });
  const connection = {
    id: `google-${modelId.replaceAll(".", "-")}`, name: `Google ${modelId}`,
    provider: "google-lyria" as const, enabled: true,
    apiKey: "fixture-google-lyria-app-key", modelId,
  };
  await saveIntegrationConnection(directory, "0", connection);
  let submissions = 0;
  const adapter: AudioGenerationAdapter = {
    provider: "google-lyria",
    async submit() {
      submissions += 1;
      return { kind: "audio", outputs: [{ role: "music", bytes: waveBytes(3) }] };
    },
  };
  const context = { storageDirectory: directory, sessionId: session.id,
    signal: new AbortController().signal, generationAdapter: adapter };
  return { directory, session, connection, context, submissions: () => submissions };
}

test("Google Lyria uses the provider-neutral inline audio job and tool lifecycle", async (t) => {
  const h = await harness(t, "lyria-3.5");
  const services = [{ id: h.connection.id, name: h.connection.name,
    pluginId: googleLyriaPlugin.id, provider: h.connection.provider,
    modelId: h.connection.modelId }];
  const tool = musicTool(services);
  assert.ok(tool);
  assert.ok((tool.function.parameters?.oneOf as Array<{ properties: { connectionId: { const: string } } }>).some(
    (schema) => schema.properties.connectionId.const === h.connection.id,
  ));

  const job = await generateAudio(h.context, h.connection.id, {
    operation: "generate_music", prompt: "Cinematic piano", durationSeconds: 120, instrumental: false,
  });
  assert.equal(job.provider, "google-lyria");
  assert.equal(job.modelId, "lyria-3.5");
  assert.equal(job.status, "completed");
  assert.deepEqual(job.outputAssets.map((asset) => asset.role), ["music"]);
  assert.deepEqual((await readAudioAsset(h.directory, h.session.id, job.outputAssets[0]!.id)).bytes, waveBytes(3));
  assert.equal(h.submissions(), 1);
  const views = JSON.stringify(await audioJobViews(h.directory, h.session.id));
  assert.doesNotMatch(views, /fixture-google-lyria-app-key|generativelanguage\.googleapis\.com/);

  await updateAudioJob(h.directory, h.session.id, job.id, {
    status: "collecting", outputAssets: [],
  });
  await saveGlobalSettings(h.directory, { integrationConnections: {
    action: "remove", expectedRevision: "1", connectionId: h.connection.id,
  } });
  const recovered = await resumeAudioJob(h.context, job.id);
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.outputAssets[0]?.id, job.outputAssets[0]?.id);
  assert.equal(h.submissions(), 1, "local receipt recovery must not generate again");
});

test("model-specific Lyria limits reject before a job or paid submission exists", async (t) => {
  const realtime = await harness(t, "lyria-realtime-exp");
  const realtimeTool = musicTool([{
    ...realtime.connection,
    pluginId: googleLyriaPlugin.id,
  }])!;
  const realtimeSchema = (realtimeTool.function.parameters?.oneOf as Array<{
    properties: { instrumental: { const?: boolean } };
  }>)[0]!;
  assert.equal(realtimeSchema.properties.instrumental.const, true);
  await assert.rejects(generateAudio(realtime.context, realtime.connection.id, {
    operation: "generate_music", prompt: "Vocal ballad", instrumental: false, durationSeconds: 30,
  }), /instrumental generation only/);
  assert.equal(realtime.submissions(), 0);
  assert.deepEqual(await listAudioJobs(realtime.directory, realtime.session.id), []);

  const clip = await harness(t, "lyria-3-clip-preview");
  const clipTool = musicTool([{ ...clip.connection, pluginId: googleLyriaPlugin.id }])!;
  const clipSchema = (clipTool.function.parameters?.oneOf as Array<{
    properties: { durationSeconds: { const?: number } };
  }>)[0]!;
  assert.equal(clipSchema.properties.durationSeconds.const, 30);
  await assert.rejects(generateAudio(clip.context, clip.connection.id, {
    operation: "generate_music", prompt: "Short preview", instrumental: true, durationSeconds: 29,
  }), /fixed 30-second/);
  assert.equal(clip.submissions(), 0);
  assert.deepEqual(await listAudioJobs(clip.directory, clip.session.id), []);
});
