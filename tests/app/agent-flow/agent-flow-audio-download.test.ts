import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import type { AudioJob } from "../../../src/audio-services/contracts.js";
import type { LiveInteractionContext } from "../../../src/live/context.js";
import { createSession } from "../../../src/storage/sessions.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import { saveSavedProfile } from "../../../src/storage/settings.js";
import { SunoSessions } from "../../../src/storage/suno-sessions.js";
import { createAudioJob, updateAudioJob } from "../../../src/storage/audio-jobs.js";
import { saveAudioAsset } from "../../../src/storage/audio-assets.js";
import { waveBytes } from "../../storage/support/audio-storage-test-helpers.js";
import type { ChatDialogState } from "../../../src/ui/chat-state.js";
import { runAgentFlow, type AgentFlowDependencies } from "../../../src/app/agent-flow.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";
import { saveIntegrationConnection } from "../plugins/support/integration-connection-test-helpers.js";

const clipIds = ["11111111-1111-4111-8111-111111111111"];
const connection = { id: "suno-one", name: "My Suno", provider: "suno" as const, enabled: true, apiKey: "" };
const clientToken = "eyJhbGciOiJSUzI1NiJ9.eyJjbGllbnQiOiJmaXh0dXJlIn0.c2lnbmF0dXJl";
const accountId = "user_fixture";

function result(sessionId: string): AudioJob {
  return { id: "audiojob-retrieval", sessionId, provider: "suno", serviceId: connection.id,
    connectionFingerprint: "a".repeat(64), operation: "retrieve_music", stems: [], status: "interrupted",
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z", outputAssets: [],
    message: "Download is locked. Authorize it on Suno, then resume this job." };
}

function endpoint(url: string, route: string): URL {
  const target = new URL(url); target.pathname = route; return target;
}

async function post(url: string, body: unknown, commandId = "audio-command", route = "/command") {
  return fetch(endpoint(url, route), { method: "POST", headers: {
    "Content-Type": "application/json", "X-Live-Smith-Command-Id": commandId,
  }, body: JSON.stringify(body) });
}

async function harness(
  t: { after(fn: () => Promise<void>): void },
  dialog: (url: string, state: ChatDialogState, storage: string) => Promise<void>,
  downloadAudioOutput?: AgentFlowDependencies["downloadAudioOutput"],
  openAudioDownload?: AgentFlowDependencies["openAudioDownload"],
  dependencies: AgentFlowDependencies = {},
) {
  const storage = await fs.mkdtemp("/private/tmp/live-smith-retrieval-flow-");
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  await saveIntegrationConnection(storage, "0", connection);
  await new SunoSessions(storage).save(connection.id, { accountId, clientToken });
  const interaction: LiveInteractionContext = { presentation: liveContextPresentationFixture("Audio"), summary: "Track: Audio",
    target: {}, scope: { kind: "track", identity: "track-retrieval", label: "Audio" } };
  interaction.selectionContext = { refresh: () => interaction };
  await runAgentFlow({ application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: storage },
    ui: { showModalDialog: async (url: string) => {
      const response = await fetch(endpoint(url, "/state")); assert.equal(response.status, 200);
      await dialog(url, await response.json() as ChatDialogState, storage);
    } },
  } as never, interaction, { renderHtml: () => "<html></html>",
    ...dependencies,
    ...(downloadAudioOutput ? { downloadAudioOutput } : {}),
    ...(openAudioDownload ? { openAudioDownload } : {}),
    verifySunoSession: async () => { throw new Error("Audio-result commands must not verify through a provider"); } });
}

test("explicit download stays in its original Session and selects only one output", async (t) => {
  let calls = 0;
  await harness(t, async (url, state, storage) => {
    const selected = { kind: "download_audio_output", sessionId: state.activeSessionId,
      jobId: "audiojob-retrieval", outputKey: clipIds[0] };
    const foreign = await createSession(storage, { projectKey: "foreign-set", title: "Foreign",
      scope: { kind: "track", identity: "foreign-track", label: "Foreign" } });
    const denied = await post(url, { ...selected, sessionId: foreign.id }, "foreign-download");
    assert.equal(denied.status, 404); await denied.text();
    assert.equal(calls, 0);
    const response = await post(url, selected, "explicit-download");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.activeSessionId, state.activeSessionId);
    assert.equal(body.status, "Selected audio is saved.");
  }, async (context, jobId, outputKey) => {
    calls++;
    assert.equal(jobId, "audiojob-retrieval"); assert.equal(outputKey, clipIds[0]);
    assert.equal(typeof context.withDownloadAuthorization, "function");
    assert.equal(await context.withDownloadAuthorization!(context.signal, async () => "authorized"), "authorized");
    await context.onProgress?.("Downloading selected song");
    return { ...result(context.sessionId), message: "Selected audio is saved." };
  });
  assert.equal(calls, 1);
});

test("local export opens only a verified same-Session file using an asset-only browser ticket", async (t) => {
  let opened = 0;
  let controlToken = "";
  await harness(t, async (url, state, storage) => {
    controlToken = new URL(url).searchParams.get("token")!;
    const job = await createAudioJob(storage, state.activeSessionId, { provider: "elevenlabs", serviceId: "local-fixture",
      connectionFingerprint: "a".repeat(64), operation: "generate_music", stems: [] });
    const asset = await saveAudioAsset(storage, state.activeSessionId, { jobId: job.id, role: "music", label: "Music",
      origin: { kind: "generated" }, bytes: waveBytes(), signal: new AbortController().signal });
    await updateAudioJob(storage, state.activeSessionId, job.id, { status: "completed", outputAssets: [asset] });
    const foreign = await createSession(storage, { projectKey: "foreign-set", title: "Foreign",
      scope: { kind: "track", identity: "foreign-track", label: "Foreign" } });
    const rejected = await post(url, { kind: "open_audio_download", sessionId: foreign.id, assetId: asset.id }, "foreign-export");
    assert.equal(rejected.status, 404); await rejected.text(); assert.equal(opened, 0);
    const otherSession = await createSession(storage, { projectKey: state.sessions[0]!.projectKey, title: "Other",
      scope: { kind: "track", identity: "other-track", label: "Other" } });
    const wrongOwner = await post(url, { kind: "open_audio_download", sessionId: otherSession.id, assetId: asset.id }, "wrong-owner-export");
    assert.equal(wrongOwner.status, 404); await wrongOwner.text(); assert.equal(opened, 0);
    const response = await post(url, { kind: "open_audio_download", sessionId: state.activeSessionId, assetId: asset.id }, "export");
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.doesNotMatch(body, /eyJhbGci|audio-download\?token=/);
  }, undefined, async (target) => {
    opened++;
    const url = new URL(target);
    assert.equal(url.pathname, "/audio-download");
    assert.notEqual(url.searchParams.get("token"), controlToken);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition")!, /^attachment;/);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), waveBytes());
  });
  assert.equal(opened, 1);
});

test("local export completes while the same Session model request remains active", async (t) => {
  let admitModel!: () => void;
  const modelAdmitted = new Promise<void>((resolve) => { admitModel = resolve; });
  let finishModel!: () => void;
  const modelResult = new Promise<void>((resolve) => { finishModel = resolve; });
  let modelFinished = false;
  let opened = 0;
  await harness(t, async (url, state, storage) => {
    await saveSavedProfile(storage, { id: "export-model", name: "Export model", defaultModel: "fixture-model",
      connection: { kind: "direct-api", apiFamily: "openai", apiMode: "responses", baseUrl: "https://example.test/v1", apiKey: "test-key" },
      models: [{ model: "fixture-model", parameters: { maxOutputTokens: 8192, reasoning: { mode: "default" } }, advanced: {} }] });
    const job = await createAudioJob(storage, state.activeSessionId, { provider: "elevenlabs", serviceId: "local-fixture",
      connectionFingerprint: "a".repeat(64), operation: "generate_music", stems: [] });
    const asset = await saveAudioAsset(storage, state.activeSessionId, { jobId: job.id, role: "music", label: "Music",
      origin: { kind: "generated" }, bytes: waveBytes(), signal: new AbortController().signal });
    await updateAudioJob(storage, state.activeSessionId, job.id, { status: "completed", outputAssets: [asset] });
    const send = fetch(endpoint(url, "/send"), { method: "POST", headers: {
      "Content-Type": "application/json", "X-Live-Smith-Send-Id": "export-active-send",
    }, body: JSON.stringify({ prompt: "Describe this track.", sessionId: state.activeSessionId }) });
    try {
      await modelAdmitted;
      const eventsBefore = await loadSessionEvents(storage, state.activeSessionId);
      const response = await fetch(endpoint(url, "/command"), { method: "POST", headers: {
        "Content-Type": "application/json", "X-Live-Smith-Command-Id": "export-during-send",
      }, body: JSON.stringify({ kind: "open_audio_download", sessionId: state.activeSessionId, assetId: asset.id }),
        signal: AbortSignal.timeout(2_000) });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.equal(opened, 1);
      assert.equal(modelFinished, false);
      assert.deepEqual(await loadSessionEvents(storage, state.activeSessionId), eventsBefore);
      const remoteDownload = await post(url, { kind: "download_audio_output", sessionId: state.activeSessionId,
        jobId: "audiojob-retrieval", outputKey: clipIds[0] }, "download-during-send");
      assert.equal(remoteDownload.status, 409); await remoteDownload.text();
    } finally {
      finishModel();
      const response = await send;
      assert.equal(response.status, 200, await response.text());
    }
  }, undefined, async (target) => {
    assert.equal(modelFinished, false);
    const response = await fetch(target);
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), waveBytes());
    opened++;
  }, {
    modelBackendManager: {
      async forProfile() {
        return { kind: "direct-api" as const, async listModels() { return []; },
          async createToolTurn() { return { content: "unused", toolCalls: [] }; }, async close() {} };
      },
      async oauth() { throw new Error("unexpected OAuth backend"); },
      async oauthLease() { throw new Error("unexpected OAuth backend"); },
      async invalidateOAuth() {}, async close() {},
    },
    requestModelTurn: async () => {
      admitModel();
      await modelResult;
      modelFinished = true;
      return { content: "The track is ready.", toolCalls: [] };
    },
  });
  assert.equal(modelFinished, true);
  assert.equal(opened, 1);
});

test("explicit download is cancellable and excludes concurrent Session commands", async (t) => {
  let started!: () => void;
  const admitted = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  await harness(t, async (url, state) => {
    const selected = { kind: "download_audio_output", sessionId: state.activeSessionId,
      jobId: "audiojob-retrieval", outputKey: clipIds[0] };
    const running = post(url, selected, "download-command");
    await admitted;
    const duplicate = await post(url, selected, "download-duplicate");
    assert.equal(duplicate.status, 409); await duplicate.text();
    const stop = await post(url, {}, "download-command", "/stop");
    assert.equal(stop.status, 200); await stop.text();
    const response = await running;
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.commandOutcome, "stopped");
    assert.equal(body.state.activeSessionId, state.activeSessionId);
  }, async (context) => {
    calls++; started();
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(new Error("Stopped download")), { once: true });
    });
    return result(context.sessionId);
  });
  assert.equal(calls, 1);
});
