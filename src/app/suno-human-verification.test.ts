import { formatUiMessage } from "../i18n/ui-message.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { createHostAbortController } from "../runtime/host.js";
import { createSession } from "../storage/sessions.js";
import { loadAgentSettings, saveGlobalSettings } from "../storage/settings.js";
import { SunoSessions } from "../storage/suno-sessions.js";
import { readAudioAsset } from "../storage/audio-assets.js";
import { listAudioJobs } from "../storage/audio-jobs.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { MUSIC, session as sunoSession, replay, accountStep, gateStep, submitStep, pollStep, clip, A, B,
  downloadPath } from "../model/audio-service-suno-harness.js";
import { resolveIntegrationConnection } from "./integration-connections.js";
import { generateAudio, downloadAudioOutput } from "./audio-generation.js";
import { audioJobViews } from "./audio-processing.js";
import { createAppSunoGenerationAdapter } from "./suno-human-verification.js";
import { SessionMutationFence } from "./session-mutation-fence.js";
import { saveIntegrationConnection } from "./integration-connection-test-helpers.js";

const secret = "private-native-proof-fixture";
const connection = { id: "website", name: "Personal Suno", provider: "suno" as const, enabled: true, apiKey: "" };
async function harness(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-verification-flow-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const chat = await createSession(directory, { title: "Verification", projectKey: "project", scope: { kind: "selection", identity: "selection", label: "Audio" } });
  await saveIntegrationConnection(directory, "0", connection);
  const sessions = new SunoSessions(directory);
  await sessions.save(connection.id, sunoSession);
  const settings = await resolveIntegrationConnection(directory, connection.id, "generate_music");
  const controller = createHostAbortController();
  const progress: string[] = [];
  const fence = new SessionMutationFence();
  const context = { storageDirectory: directory, sessionId: chat.id, signal: controller.signal,
    onProgress: (message: string) => { progress.push(message); },
    withGenerationAuthorization: <T>(signal: AbortSignal, operation: () => Promise<T>) => fence.run("settings", signal, operation),
  };
  return { directory, chat, sessions, settings, controller, progress, context, change: (operation: () => Promise<void>) => fence.run("settings", operation) };
}

test("the production Suno factory privately continues one request, persists receipt and downloads the chosen file in-app", async (t) => {
  const h = await harness(t);
  const wire = replay([accountStep(), gateStep({ required: true, captcha_version: 2 }), submitStep(),
    pollStep([clip(A), clip(B)]),
    { path: `/api/feed/?ids=${A}`, value: [clip(A)] },
    { path: downloadPath(A), value: { ok: true, status: "ready", download_url: `https://cdn1.suno.ai/${A}.mp3` } },
    { path: `https://cdn1.suno.ai/${A}.mp3`, response: new Response(new Uint8Array(waveBytes()), { headers: { "content-type": "audio/wav" } }) },
  ]);
  let verifications = 0;
  const adapter = createAppSunoGenerationAdapter(h.context, h.settings, false, { fetchImpl: wire.fetchImpl, verify: async options => {
    verifications++;
    assert.equal(options.captchaVersion, 2);
    assert.equal(options.signal, h.controller.signal);
    assert.equal(options.connectionName, connection.name);
    assert.deepEqual(Object.keys(options).sort(), ["captchaVersion", "connectionName", "interfaceLanguage", "networkProxy", "signal"]);
    assert.ok(!JSON.stringify(options).includes(sunoSession.clientToken));
    assert.equal(wire.api().length, 2);
    return { captchaVersion: 2, token: secret, issuedAtMs: Date.now() };
  } });
  const context = { ...h.context, generationAdapter: adapter };
  const job = await generateAudio(context, connection.id, { ...MUSIC });
  assert.equal(job.status, "ready");
  assert.equal(verifications, 1);
  assert.equal(wire.api().filter(entry => entry.path.startsWith("/api/generate/")).length, 1);
  assert.deepEqual(job.expectedOutputs?.map(entry => entry.key), [A, B]);
  assert.ok(!JSON.stringify(job).includes(secret));
  assert.ok(!JSON.stringify(h.progress).includes(secret));
  const saved = await downloadAudioOutput(context, job.id, A);
  assert.equal(saved.outputAssets.length, 1, formatUiMessage(saved.message ?? ""));
  assert.deepEqual((await readAudioAsset(h.directory, h.chat.id, saved.outputAssets[0]!.id)).bytes, waveBytes());
  assert.equal(verifications, 1, "retrieval and downloads must not open verification");
  wire.done();
});

test("account or model changes during a native challenge cannot dispatch generation", async (t) => {
  const h = await harness(t);
  const wire = replay([accountStep(), gateStep({ required: true, captcha_version: 2 })]);
  const adapter = createAppSunoGenerationAdapter(h.context, h.settings, false, { fetchImpl: wire.fetchImpl, verify: async () => {
    await saveIntegrationConnection(h.directory, "1", {
      ...connection,
      modelId: "changed-model",
    });
    return { captchaVersion: 2, token: secret, issuedAtMs: Date.now() };
  } });
  const job = await generateAudio({ ...h.context, generationAdapter: adapter }, connection.id, { ...MUSIC });
  assert.equal(job.status, "failed");
  assert.equal(wire.api().length, 2);
  assert.equal(job.remoteTaskId, undefined);
  assert.ok(!JSON.stringify(job).includes(secret));
});

test("a proxy revision change after native verification rejects before a paid fetch and is not unknown", async (t) => {
  const h = await harness(t);
  const wire = replay([accountStep(), gateStep({ required: true, captcha_version: 2 })]);
  const adapter = createAppSunoGenerationAdapter(h.context, h.settings, false, { fetchImpl: wire.fetchImpl,
    verify: async () => ({ captchaVersion: 2, token: secret, issuedAtMs: Date.now() }),
  });
  const request = { ...MUSIC };
  await adapter.prepare!(request, h.controller.signal);
  const saved = await loadAgentSettings(h.directory);
  await saveGlobalSettings(h.directory, { networkProxy: { mode: "manual", url: "http://127.0.0.1:7897" } });
  assert.notEqual((await loadAgentSettings(h.directory)).networkProxyRevision, saved.networkProxyRevision);
  await assert.rejects(adapter.submit(request, h.controller.signal), error => {
    assert.equal((error as Error).constructor.name, "AudioSubmissionNotStartedError");
    return true;
  });
  assert.equal(wire.api().length, 2);
});

test("no-challenge generation never opens the native verifier", async (t) => {
  const h = await harness(t);
  const wire = replay([accountStep(), gateStep(), submitStep(), pollStep([clip(A), clip(B)])]);
  const fetchImpl = (async (input, init) => {
    if (String(input).includes("/api/generate/")) {
      assert.equal((await listAudioJobs(h.directory, h.chat.id))[0]?.status, "submitting");
    }
    return wire.fetchImpl(input, init);
  }) as typeof fetch;
  const adapter = createAppSunoGenerationAdapter(h.context, h.settings, false, { fetchImpl,
    verify: async () => { assert.fail("No verifier for a no-challenge request"); },
  });
  assert.equal((await generateAudio({ ...h.context, generationAdapter: adapter }, connection.id, { ...MUSIC })).status, "ready");
  wire.done();
});

test("Suno remains pre-submit while its inner settings authorization is queued", async (t) => {
  const h = await harness(t);
  const occupied = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocker = h.change(async () => {
    occupied.resolve();
    await release.promise;
  });
  await occupied.promise;
  const queued = Promise.withResolvers<void>();
  const authorize = h.context.withGenerationAuthorization;
  h.context.withGenerationAuthorization = (signal, operation) => {
    queued.resolve();
    return authorize(signal, operation);
  };
  const wire = replay([accountStep(), gateStep()]);
  const adapter = createAppSunoGenerationAdapter(h.context, h.settings, false, { fetchImpl: wire.fetchImpl });
  const pending = generateAudio({ ...h.context, generationAdapter: adapter }, connection.id, { ...MUSIC });
  await queued.promise;
  const [stored] = await listAudioJobs(h.directory, h.chat.id);
  h.controller.abort(new Error("Stopped before Suno paid submission"));
  release.resolve();
  const [outcome] = await Promise.allSettled([pending, blocker]);
  assert.equal(stored?.status, "preparing", "an abandoned queued job must not recover as an unknown paid request");
  assert.equal(outcome.status, "rejected");
  assert.equal((await audioJobViews(h.directory, h.chat.id))[0]?.status, "interrupted");
  assert.equal(wire.api().filter((entry) => entry.path.startsWith("/api/generate/")).length, 0);
  wire.done();
});

test("the final route read cannot cross a changed admitted connection", async (t) => {
  const h = await harness(t);
  await saveGlobalSettings(h.directory, { networkProxy: { mode: "system", url: "" } });
  const wire = replay([accountStep(), gateStep({ required: true, captcha_version: 2 })]);
  let reads = 0;
  const adapter = createAppSunoGenerationAdapter(h.context, h.settings, false, { fetchImpl: wire.fetchImpl,
    readSystemProxy: async () => {
      if (++reads === 3) await saveIntegrationConnection(h.directory, "1", {
        ...connection,
        enabled: false,
      });
      return { noProxy: [] };
    }, verify: async () => ({ captchaVersion: 2, token: secret, issuedAtMs: Date.now() }),
  });
  const request = { ...MUSIC };
  await adapter.prepare!(request, h.controller.signal);
  await assert.rejects(adapter.submit(request, h.controller.signal));
  assert.equal(wire.api().length, 2);
});

test("generation authorization covers authentication and the paid receipt, without locking manual verification", async (t) => {
  const h = await harness(t);
  const wire = replay([accountStep(), gateStep({ required: true, captcha_version: 2 }), submitStep()]);
  let queued: Promise<void> | undefined;
  let changed = false;
  let submitting = false;
  const fetchImpl = (async (input, init) => {
    if (submitting && String(input).includes("/tokens?") && !queued) {
      queued = h.change(async () => {
        changed = true;
        await saveIntegrationConnection(h.directory, "1", { ...connection, enabled: false });
      });
      await Promise.resolve();
    }
    if (String(input).includes("/api/generate/")) assert.equal(changed, false, "a queued settings edit cannot change paid-request authority");
    return wire.fetchImpl(input, init);
  }) as typeof fetch;
  const adapter = createAppSunoGenerationAdapter(h.context, h.settings, false, { fetchImpl,
    verify: async () => {
      await h.change(async () => { /* Manual verification must not hold the settings lease. */ });
      return { captchaVersion: 2, token: secret, issuedAtMs: Date.now() };
    },
  });
  const request = { ...MUSIC };
  await adapter.prepare!(request, h.controller.signal);
  submitting = true;
  await adapter.submit(request, h.controller.signal);
  await queued;
  assert.equal(changed, true);
  assert.equal(wire.api().filter(entry => entry.path.startsWith("/api/generate/")).length, 1);
});
