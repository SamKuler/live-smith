import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import type { AudioJob, SunoUploadReceipt } from "../../../src/audio-services/contracts.js";
import { AudioSubmissionNotStartedError } from "../../../src/audio-services/contracts.js";
import type { LiveInteractionContext } from "../../../src/live/context.js";
import { A, B, accountStep, replay, session, type Step } from "../../audio-services/suno/support/audio-service-suno-harness.js";
import { loadAudioJob } from "../../../src/storage/audio-jobs.js";
import { waveBytes } from "../../storage/support/audio-storage-test-helpers.js";
import { saveGlobalSettings } from "../../../src/storage/settings.js";
import { SunoSessions } from "../../../src/storage/suno-sessions.js";
import type { ChatDialogState } from "../../../src/ui/chat-state.js";
import { runAgentFlow, type AgentFlowDependencies } from "../../../src/app/agent-flow.js";
import { integrationConnectionUpsert, saveIntegrationConnection } from "../plugins/support/integration-connection-test-helpers.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";
import { uploadSunoMusic } from "../../../src/app/audio/suno-upload.js";

const connection = { id: "suno-resume", name: "Suno", provider: "suno" as const, enabled: true, apiKey: "" };
const destination = "https://suno-data-uploads.s3.amazonaws.com/";
type RecoverableStage = Extract<SunoUploadReceipt["stage"], "prepared" | "uploaded" | "processing" | "processed">;

function endpoint(url: string, route: string): URL {
  const target = new URL(url); target.pathname = route; return target;
}

function post(url: string, body: unknown, commandId: string, route = "/command") {
  return fetch(endpoint(url, route), { method: "POST", headers: {
    "Content-Type": "application/json", "X-Live-Smith-Command-Id": commandId,
  }, body: JSON.stringify(body) });
}

async function storageFixture(t: TestContext): Promise<string> {
  const storage = await fs.mkdtemp("/private/tmp/live-smith-resume-flow-");
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  await saveIntegrationConnection(storage, "0", connection);
  await new SunoSessions(storage).save(connection.id, session);
  return storage;
}

async function flow(storage: string, dialog: (url: string, state: ChatDialogState) => Promise<void>,
  dependencies: AgentFlowDependencies = {}, identity = "track-resume") {
  const interaction: LiveInteractionContext = { presentation: liveContextPresentationFixture("Audio"),
    summary: "Track: Audio", target: {}, scope: { kind: "track", identity, label: "Audio" } };
  interaction.selectionContext = { refresh: () => interaction };
  await runAgentFlow({ application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: storage },
    ui: { showModalDialog: async (url: string) => {
      const response = await fetch(endpoint(url, "/state")); assert.equal(response.status, 200);
      await dialog(url, await response.json() as ChatDialogState);
    } },
  } as never, interaction, { renderHtml: () => "<html></html>",
    verifySunoSession: async () => { throw new Error("Resume must not verify through the dialog manager"); },
    ...dependencies });
}

async function savedUpload(storage: string, sessionId: string, stage: RecoverableStage): Promise<AudioJob> {
  const controller = new AbortController();
  const job = await uploadSunoMusic({ storageDirectory: storage, sessionId, signal: controller.signal,
    withGenerationAuthorization: async (_signal, operation) => operation(), wait: async () => undefined },
  connection.id, true, async () => ({ label: "Reference", bytes: waveBytes(6),
    origin: { kind: "arrangement", startBeat: 0, endBeat: 16 } }), { adapter: {
    limits: async () => ({ minimumSeconds: 6, maximumSeconds: 60 }),
    create: async () => {
      if (stage === "prepared") throw new AudioSubmissionNotStartedError("Fixture stopped before dispatch");
      return { uploadId: A, url: destination, fields: {} };
    },
    upload: async () => { if (stage === "uploaded") controller.abort(); },
    finish: async () => {},
    inspect: async () => {
      if (stage === "processing") throw new Error("Fixture processing interrupted");
      return { status: "complete" };
    },
    initialize: async () => { throw new AudioSubmissionNotStartedError("Fixture stopped before dispatch"); },
  } });
  assert.equal(job.upload!.stage, stage); assert.equal(job.upload!.pendingStage, undefined);
  return job;
}

function remainingSteps(stage: RecoverableStage): Step[] {
  const create: Step = { path: "/api/uploads/audio/", value: { id: A, url: destination,
    fields: { key: "audio-fixture", policy: "synthetic-upload-policy" } } };
  const transfer: Step = { path: destination, response: new Response(null, { status: 204 }) };
  const finish: Step = { path: `/api/uploads/audio/${A}/upload-finish/`, value: {} };
  const inspect: Step = { path: `/api/uploads/audio/${A}/`, value: { status: "complete" } };
  const initialize: Step = { path: `/api/uploads/audio/${A}/initialize-clip/`, value: { clip_id: B } };
  return [accountStep({ audio_upload_limits: { min: 6, max: 60 } }),
    ...(stage === "prepared" ? [create, transfer, finish, inspect] : stage === "uploaded" ? [finish, inspect]
      : stage === "processing" ? [inspect] : []), initialize];
}

async function reaches(boundary: Promise<void>, command: Promise<Response>) {
  assert.equal(await Promise.race([boundary.then(() => "boundary"), command.then(() => "settled")]), "boundary");
}

async function remainsPending(command: Promise<Response>): Promise<boolean> {
  return Promise.race([command.then(() => false), delay(25).then(() => true)]);
}

test("UI upload Resume uses saved receipts and the shared settings lifecycle", { timeout: 15_000 }, async (t) => {
  const hostFetch = globalThis.fetch;
  let providerFetch: typeof fetch = async () => { throw new Error("Unexpected provider request"); };
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = new URL(String(input));
    return target.hostname === "127.0.0.1" ? hostFetch(input, init) : providerFetch(input, init);
  });

  for (const stage of ["prepared", "uploaded", "processing", "processed"] as const) {
    await t.test(`Resume continues an acknowledged ${stage} upload without replaying earlier mutations`, async (t) => {
      const storage = await storageFixture(t);
      const network = replay(remainingSteps(stage)); providerFetch = network.fetchImpl;
      await flow(storage, async (url, state) => {
        const job = await savedUpload(storage, state.activeSessionId!, stage);
        const before = await (await fetch(endpoint(url, "/state"))).json() as ChatDialogState;
        assert.equal(before.audioJobs!.find((entry) => entry.id === job.id)!.resumable, true);
        const response = await post(url, { kind: "resume_audio_job", sessionId: job.sessionId, jobId: job.id }, `resume-${stage}`);
        const body = await response.text(); assert.equal(response.status, 200, body);
        assert.doesNotMatch(body, /eyJ|clientToken|synthetic-upload-policy|s3\.amazonaws/);
        const after = JSON.parse(body) as ChatDialogState;
        assert.equal(after.audioJobs!.find((entry) => entry.id === job.id)!.resumable, false);
        const saved = await loadAudioJob(storage, job.sessionId, job.id);
        assert.equal(saved.status, "ready");
        assert.deepEqual(saved.upload, { sourceSha256: job.upload!.sourceSha256, rightsConfirmed: true,
          stage: "complete", uploadId: A, clipId: B });
        assert.equal(saved.remoteTaskId, B);
        assert.deepEqual(saved.remoteOutputs, [{ key: B, role: "uploaded_audio" }]);
        const requests = network.api();
        assert.deepEqual(requests.map((entry) => entry.path), remainingSteps(stage)
          .map((step) => step.path).filter((path) => path !== destination));
        assert.deepEqual(requests.at(-1)!.body, {});
        if (stage === "prepared") {
          assert.deepEqual(requests[1]!.body, { extension: "wav", is_stem_mix: false, upload_type: "file_upload" });
          assert.deepEqual(requests[2]!.body, { upload_type: "file_upload", upload_filename: "audio.wav" });
        }
        network.done();
      });
    });
  }

  await t.test("a queued Resume rechecks a disabled connection after the settings command finishes", async (t) => {
    const storage = await storageFixture(t);
    const saving = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const billing = Promise.withResolvers<void>();
    const network = replay([{ path: "/api/billing/info/", run: async () => {
      billing.resolve(); return Response.json({ audio_upload_limits: { min: 6, max: 60 } });
    } }]); providerFetch = network.fetchImpl;
    await flow(storage, async (url, state) => {
      const job = await savedUpload(storage, state.activeSessionId!, "processed");
      const changed = flow(storage, async (peerUrl) => {
        const response = await post(peerUrl, { kind: "save_global_settings",
          integrationConnections: integrationConnectionUpsert("1", { ...connection, enabled: false }) }, "disable-connection");
        const body = await response.text(); assert.equal(response.status, 200, body);
      }, { saveGlobalSettings: async (directory, patch) => {
        saving.resolve(); await release.promise; return saveGlobalSettings(directory, patch);
      } }, "track-resume-settings");
      try {
        await saving.promise;
        const running = post(url, { kind: "resume_audio_job", sessionId: job.sessionId, jobId: job.id }, "resume-disabled");
        await reaches(billing.promise, running);
        assert.equal(await remainsPending(running), true);
        assert.deepEqual(network.api().map((entry) => entry.path), ["/api/billing/info/"]);
        release.resolve(); await changed;
        const response = await running; const body = await response.text(); assert.equal(response.status, 200, body);
        const saved = await loadAudioJob(storage, job.sessionId, job.id);
        assert.equal(saved.status, "interrupted"); assert.equal(saved.upload!.stage, "processed");
        assert.equal(saved.upload!.pendingStage, undefined); assert.equal(saved.remoteTaskId, undefined);
        network.done();
      } finally { release.resolve(); await changed; }
    });
  });

  await t.test("Stop removes a queued upload Resume without submitting and a later Resume can finish", async (t) => {
    const storage = await storageFixture(t);
    const saving = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const billing = Promise.withResolvers<void>();
    const network = replay([{ path: "/api/billing/info/", run: async () => {
      billing.resolve(); return Response.json({ audio_upload_limits: { min: 6, max: 60 } });
    } }, ...remainingSteps("processed")]); providerFetch = network.fetchImpl;
    await flow(storage, async (url, state) => {
      const job = await savedUpload(storage, state.activeSessionId!, "processed");
      const settings = flow(storage, async (peerUrl) => {
        const response = await post(peerUrl, { kind: "save_global_settings", showContextUsage: false }, "save-display");
        const body = await response.text(); assert.equal(response.status, 200, body);
      }, { saveGlobalSettings: async (directory, patch) => {
        saving.resolve(); await release.promise; return saveGlobalSettings(directory, patch);
      } }, "track-resume-stop-settings");
      try {
        await saving.promise;
        const running = post(url, { kind: "resume_audio_job", sessionId: job.sessionId, jobId: job.id }, "resume-stopped");
        await reaches(billing.promise, running);
        assert.equal(await remainsPending(running), true);
        const stopped = await post(url, {}, "resume-stopped", "/stop"); assert.equal(stopped.status, 200); await stopped.text();
        await (await running).text();
        const saved = await loadAudioJob(storage, job.sessionId, job.id);
        assert.equal(saved.status, "interrupted"); assert.equal(saved.upload!.stage, "processed");
        assert.equal(saved.upload!.pendingStage, undefined);
        assert.deepEqual(network.api().map((entry) => entry.path), ["/api/billing/info/"]);
        release.resolve(); await settings;
        const resumed = await post(url, { kind: "resume_audio_job", sessionId: job.sessionId, jobId: job.id }, "resume-retry");
        const body = await resumed.text(); assert.equal(resumed.status, 200, body);
        assert.equal((await loadAudioJob(storage, job.sessionId, job.id)).upload!.clipId, B);
        network.done();
      } finally { release.resolve(); await settings; }
    });
  });
});
