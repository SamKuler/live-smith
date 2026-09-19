import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test, { type TestContext } from "node:test";
import { createSunoAudioAdapter } from "../audio-services/suno.js";
import { createHostAbortController } from "../runtime/host.js";
import { loadAudioJob } from "../storage/audio-jobs.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { downloadAudioOutput, retrieveMusic } from "./audio-generation.js";
import { SessionMutationFence, sessionMutationFenceKey } from "./session-mutation-fence.js";
import { clipIds, connection, fixtureToken, manifest, retrievalHarness } from "./audio-retrieval-test-helpers.js";
import { saveIntegrationConnection } from "./integration-connection-test-helpers.js";

async function authorizationHarness(t: TestContext) {
  const h = await retrievalHarness(t);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  const fence = new SessionMutationFence();
  const fenceKey = sessionMutationFenceKey(h.directory, "global-settings");
  const calls = { permission: 0, authorizations: 0, mint: 0, fullManifest: 0, media: 0 };
  const mode = { missingSibling: false, unlocked: false };
  const hooks: { permission?: () => Promise<void>; mint?: () => Promise<void>; authorize?: () => Promise<void> } = {};
  const token = (payload: object) => [JSON.stringify({ alg: "RS256" }), JSON.stringify(payload), "fixture-signature"]
    .map((part) => Buffer.from(part).toString("base64url")).join(".");
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://auth.suno.com/v1/client?")) return Response.json({ response: {
      object: "client", last_active_session_id: "sess_fixture", sessions: [{ object: "session", id: "sess_fixture",
        status: "active", expire_at: Date.now() + 600_000, user: { object: "user", id: "user_fixture" } }],
    } });
    if (url.startsWith("https://auth.suno.com/v1/client/sessions/sess_fixture/tokens?")) {
      calls.mint++;
      await hooks.mint?.();
      return Response.json({ jwt: token({ sub: "user_fixture", sid: "sess_fixture", exp: Math.floor(Date.now() / 1000) + 20 }) });
    }
    if (url === `https://studio-api-prod.suno.com/api/feed/?ids=${clipIds.join(",")}`) {
      calls.fullManifest++;
      return Response.json((mode.missingSibling ? clipIds.slice(0, 1) : clipIds).map((id) => ({ id, status: "complete" })));
    }
    if (url === `https://studio-api-prod.suno.com/api/feed/?ids=${clipIds[0]}`) {
      calls.permission++;
      await hooks.permission?.();
      return Response.json([{ id: clipIds[0], status: "complete", is_download_unlocked: mode.unlocked }]);
    }
    if (url === "https://studio-api-prod.suno.com/api/download/authorize") {
      calls.authorizations++;
      await hooks.authorize?.();
      mode.unlocked = true;
      return Response.json({ ok: true });
    }
    if (url === `https://studio-api-prod.suno.com/api/download/clip/${clipIds[0]}?format=mp3`) {
      return Response.json({ ok: true, status: "ready", download_url: "https://cdn1.suno.ai/fixture.wav" });
    }
    assert.equal(url, "https://cdn1.suno.ai/fixture.wav");
    calls.media++;
    return new Response(waveBytes().slice().buffer, { headers: { "content-type": "audio/wav" } });
  };
  const adapter = createSunoAudioAdapter({ clientToken: fixtureToken("first"), accountId: "user_fixture" }, {
    fetchImpl, authorizeDownloads: true,
  });
  const context = { ...h.context, generationAdapter: adapter,
    withDownloadAuthorization: <T>(signal: AbortSignal, operation: () => Promise<T>) => fence.run(fenceKey, signal, operation) };
  const change = (operation: () => Promise<unknown>) => fence.run(fenceKey, operation);
  return { ...h, job, calls, mode, hooks, context, change };
}

test("connection edits during a pending selected permission read prevent the authorization POST", async (t) => {
  for (const change of ["logout", "disable", "account", "credential"] as const) await t.test(change, async (t) => {
    const h = await authorizationHarness(t);
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    h.hooks.permission = async () => { entered.resolve(); await proceed.promise; };
    const pending = downloadAudioOutput(h.context, h.job.id, clipIds[0]!);
    try {
      await entered.promise;
      await h.change(async () => {
        if (change === "logout") await h.sessions.clear(connection.id);
        else if (change === "disable") {
          await saveIntegrationConnection(h.directory, "1", { ...connection, enabled: false });
        }
        else await h.sessions.save(connection.id, { accountId: change === "account" ? "user_other" : "user_fixture",
          clientToken: fixtureToken("changed") });
      });
    } finally { proceed.resolve(); }
    const result = await pending;
    assert.equal(h.calls.authorizations, change === "credential" ? 1 : 0);
    assert.equal(h.calls.media, change === "credential" ? 1 : 0);
    assert.equal(result.status, change === "credential" ? "partial" : "ready");
    assert.deepEqual(result.remoteOutputs, manifest);
    assert.equal(result.outputAssets.length, change === "credential" ? 1 : 0);
  });
});

test("the authorization lease covers token renewal and POST until its receipt completes", async (t) => {
  const h = await authorizationHarness(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const minting = Promise.withResolvers<void>();
  const finishMint = Promise.withResolvers<void>();
  const posting = Promise.withResolvers<void>();
  const finishPost = Promise.withResolvers<void>();
  h.hooks.permission = async () => { if (h.calls.permission === 1) now += 20_000; };
  h.hooks.mint = async () => { if (h.calls.mint === 2) { minting.resolve(); await finishMint.promise; } };
  h.hooks.authorize = async () => { posting.resolve(); await finishPost.promise; };
  const pending = downloadAudioOutput(h.context, h.job.id, clipIds[0]!);
  let changed = false;
  let change: Promise<unknown> | undefined;
  try {
    await minting.promise;
    change = h.change(async () => { changed = true; await h.sessions.clear(connection.id); });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(changed, false, "the old account cannot be removed while its authorization token is minting");
    finishMint.resolve();
    await posting.promise;
    assert.equal(changed, false, "the lease remains held through the paid request receipt");
  } finally {
    finishMint.resolve(); finishPost.resolve();
    await Promise.allSettled([pending, ...(change ? [change] : [])]);
  }
  const result = await pending;
  await change;
  assert.equal(changed, true);
  assert.equal(h.calls.authorizations, 1);
  assert.equal(result.outputAssets.length, 1);
});

test("selected download does not depend on a later missing sibling or alter the original manifest", async (t) => {
  const h = await authorizationHarness(t);
  h.mode.missingSibling = true;
  h.mode.unlocked = true;
  const result = await downloadAudioOutput(h.context, h.job.id, clipIds[0]!);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.outputAssets.map((asset) => asset.role), ["music"]);
  assert.equal(h.calls.fullManifest, 0);
  assert.equal(h.calls.permission, 1);
  assert.equal(h.calls.authorizations, 0);
  assert.deepEqual((await loadAudioJob(h.directory, h.session.id, h.job.id)).expectedOutputs, manifest);
});

test("app download fails closed on a locked clip without a lifecycle authorization lease", async (t) => {
  const h = await authorizationHarness(t);
  const { withDownloadAuthorization: _lease, ...context } = h.context;
  const result = await downloadAudioOutput(context, h.job.id, clipIds[0]!);
  assert.equal(h.calls.authorizations, 0);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.outputAssets, []);
  h.mode.unlocked = true;
  const unlocked = await downloadAudioOutput(context, h.job.id, clipIds[0]!);
  assert.equal(unlocked.outputAssets.length, 1, "an already unlocked song requires no paid authorization lease");
  assert.equal(h.calls.authorizations, 0);
});

test("Stop while waiting for the authorization lease prevents later paid effects", async (t) => {
  const h = await authorizationHarness(t);
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const awaitingLease = Promise.withResolvers<void>();
  const held = h.change(async () => { entered.resolve(); await proceed.promise; });
  await entered.promise;
  const controller = createHostAbortController();
  const pending = downloadAudioOutput({ ...h.context, signal: controller.signal,
    withDownloadAuthorization: (signal, operation) => {
      const queued = h.context.withDownloadAuthorization(signal, operation);
      awaitingLease.resolve();
      return queued;
    },
  }, h.job.id, clipIds[0]!);
  const stopped = assert.rejects(pending);
  try { await awaitingLease.promise; controller.abort(); await stopped; }
  finally { proceed.resolve(); await held; }
  assert.equal(h.calls.authorizations, 0);
  assert.equal(h.calls.media, 0);
});
