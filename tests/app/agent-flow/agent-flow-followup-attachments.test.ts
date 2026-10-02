import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { URL } from "node:url";

import { runAgentFlow } from "../../../src/app/agent-flow.js";
import { buildModelRequest } from "../../../src/app/model/model-request.js";
import type { LiveInteractionContext } from "../../../src/live/context.js";
import type { ModelInputPart, ModelTurn } from "../../../src/model/contracts.js";
import type { TransportRequest } from "../../../src/model/provider.js";
import { listPendingSessionAttachments, type SessionAttachmentRef } from "../../../src/storage/attachments.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import { saveSavedProfile } from "../../../src/storage/settings.js";
import type { ChatDialogState } from "../../../src/ui/chat-state.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk2sAAAAASUVORK5CYII=", "base64");
let requestSequence = 0;

interface Flow {
  url: string;
  directory: string;
  sessionId: string;
  requests: TransportRequest[];
}

async function withFlow(
  t: TestContext,
  dialog: (flow: Flow) => Promise<void>,
  model: (request: TransportRequest, turn: number) => ModelTurn | Promise<ModelTurn> = () => ({ content: "Ready.", toolCalls: [] }),
) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-followup-attachments-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, {
    id: "followup-profile", name: "Followup model", defaultModel: "fixture-model",
    connection: { kind: "direct-api", apiFamily: "openai", apiMode: "responses", baseUrl: "https://example.test/v1", apiKey: "test-key" },
    models: [{ model: "fixture-model", parameters: { maxOutputTokens: 2048, reasoning: { mode: "default" } },
      advanced: { capabilityOverrides: { inputs: { image: true } } } }],
  });
  const requests: TransportRequest[] = [];
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"), summary: "Track: Lead", target: {},
    scope: { kind: "track", identity: "followup-track", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  await runAgentFlow({
    application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: directory },
    ui: { showModalDialog: async (url: string) => {
      const response = await fetch(endpoint(url, "/state"));
      assert.equal(response.status, 200);
      const state = await response.json() as ChatDialogState;
      await dialog({ url, directory, sessionId: state.activeSessionId, requests });
    } },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: {
      async forProfile() {
        return { kind: "direct-api" as const, async listModels() { return []; },
          async createToolTurn() { return { content: "unused", toolCalls: [] }; }, async close() {} };
      },
      async oauth() { throw new Error("Unexpected OAuth backend"); },
      async oauthLease() { throw new Error("Unexpected OAuth backend"); },
      async invalidateOAuth() {}, async close() {},
    },
    requestModelTurn: async (input) => {
      const request = buildModelRequest(input);
      requests.push(request);
      return model(request, requests.length);
    },
  });
}

function endpoint(url: string, pathname: string): URL {
  const target = new URL(url); target.pathname = pathname; return target;
}

function send(flow: Flow, prompt: string, ids?: readonly string[], sendId = `followup-send-${++requestSequence}`) {
  return fetch(endpoint(flow.url, "/send"), { method: "POST", headers: {
    "Content-Type": "application/json", "X-Live-Smith-Send-Id": sendId,
    ...(ids === undefined ? {} : { "X-Live-Smith-Attachment-Ids": JSON.stringify(ids) }),
  }, body: JSON.stringify({ prompt, sessionId: flow.sessionId }) });
}

function steer(flow: Flow, sendId: string, steerId: string, prompt: string, ids: readonly string[]) {
  return fetch(endpoint(flow.url, "/steer"), { method: "POST", headers: {
    "Content-Type": "application/json", "X-Live-Smith-Send-Id": sendId,
    "X-Live-Smith-Steer-Id": steerId, "X-Live-Smith-Attachment-Ids": JSON.stringify(ids),
  }, body: JSON.stringify({ prompt, sessionId: flow.sessionId }) });
}

async function upload(flow: Flow, fileName: string, bytes: Uint8Array = png): Promise<SessionAttachmentRef> {
  const target = endpoint(flow.url, "/attachments");
  target.searchParams.set("sessionId", flow.sessionId); target.searchParams.set("fileName", fileName);
  const response = await fetch(target, { method: "POST", headers: { "Content-Type": "application/octet-stream" },
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    signal: AbortSignal.timeout(10_000) });
  const body = await expectStatus(response, 201);
  const state = JSON.parse(body) as ChatDialogState;
  const attachment = state.pendingAttachments.find((entry) => entry.fileName === fileName);
  assert.ok(attachment, "The uploaded attachment must remain pending");
  return attachment;
}

function remove(flow: Flow, id: string) {
  const target = endpoint(flow.url, `/attachments/${id}`); target.searchParams.set("sessionId", flow.sessionId);
  return fetch(target, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
}

async function pending(flow: Flow) {
  const events = await loadSessionEvents(flow.directory, flow.sessionId);
  return listPendingSessionAttachments(flow.directory, flow.sessionId,
    events.flatMap((event) => event.attachments?.map((attachment) => attachment.id) ?? []));
}

async function expectStatus(response: Response, status: number): Promise<string> {
  const body = await response.text(); assert.equal(response.status, status, body); return body;
}

function images(parts: readonly ModelInputPart[]) {
  return parts.filter((part) => part.type === "image");
}

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
}

function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

test("same-Session draft uploads and deletion remain available during a model request, and steering consumes only its selected file", async (t) => {
  const firstStarted = deferred(); const secondStarted = deferred();
  const releaseFirst = deferred(); const releaseSecond = deferred();
  await withFlow(t, async (flow) => {
    const initial = await upload(flow, "initial.txt", Buffer.from("INITIAL_REFERENCE_ONLY"));
    const sendId = "followup-steering-send";
    const running = send(flow, "Inspect the current track.", [initial.id], sendId);
    try {
      await firstStarted.promise;
      const selected = await upload(flow, "steering.png");
      const otherDraft = await upload(flow, "other-draft.txt", Buffer.from("OTHER_DRAFT_MUST_STAY_PENDING"));
      const temporary = await upload(flow, "temporary.txt", Buffer.from("REMOVABLE_DRAFT"));
      await expectStatus(await remove(flow, temporary.id), 200);
      assert.equal(flow.requests.length, 1);
      assert.equal(flow.requests[0]!.signal!.aborted, false);
      assert.deepEqual(images(flow.requests[0]!.currentUserContent), []);
      assert.doesNotMatch(JSON.stringify(flow.requests[0]), /steering\.png|OTHER_DRAFT_MUST_STAY_PENDING|REMOVABLE_DRAFT/);
      assert.deepEqual((await pending(flow)).map((entry) => entry.id), [selected.id, otherDraft.id]);

      const steerId = "followup-steering-selection";
      const guidance = "Use this reference for the next decision.";
      await expectStatus(await steer(flow, sendId, steerId, guidance, [selected.id]), 200);
      await secondStarted.promise;
      assert.equal(flow.requests[0]!.signal!.aborted, true);
      const steeringMessage = flow.requests[1]!.agentMessages.find((message) => message.role === "user");
      assert.ok(steeringMessage && Array.isArray(steeringMessage.content));
      assert.deepEqual(images(steeringMessage.content), [{ type: "image", fileName: "steering.png", mediaType: "image/png", base64: png.toString("base64") }]);
      assert.ok(steeringMessage.content.some((part) => part.type === "text" && part.text === guidance));
      assert.doesNotMatch(JSON.stringify(flow.requests[1]), /OTHER_DRAFT_MUST_STAY_PENDING|REMOVABLE_DRAFT/);
      const users = (await loadSessionEvents(flow.directory, flow.sessionId)).filter((event) => event.kind === "user");
      assert.deepEqual(users.map((event) => ({ content: event.content, attachments: event.attachments?.map((entry) => entry.id) })), [
        { content: "Inspect the current track.", attachments: [initial.id] },
        { content: guidance, attachments: [selected.id] },
      ]);
      assert.equal(users[1]!.steeringReceipt?.id, steerId);
      assert.equal(users[1]!.steeringReceipt?.sendId, sendId);
      await expectStatus(await remove(flow, selected.id), 409);
      assert.deepEqual((await pending(flow)).map((entry) => entry.id), [otherDraft.id]);

      releaseSecond.resolve();
      await expectStatus(await running, 200);
      await expectStatus(await steer(flow, sendId, steerId, guidance, [selected.id]), 200);
      await expectStatus(await steer(flow, sendId, steerId, guidance, [otherDraft.id]), 409);
      assert.equal((await loadSessionEvents(flow.directory, flow.sessionId)).filter((event) => event.kind === "user").length, 2);
    } finally {
      releaseFirst.resolve(); releaseSecond.resolve();
      await running.then((response) => { if (!response.bodyUsed) return response.text(); });
    }
  }, async (request, turn) => {
    if (turn === 1) {
      firstStarted.resolve();
      await Promise.race([releaseFirst.promise, waitForAbort(request.signal!)]);
      return { content: "Discarded original answer.", toolCalls: [] };
    }
    secondStarted.resolve(); await releaseSecond.promise;
    return { content: "The reference was used.", toolCalls: [] };
  });
});

test("a queued followup Send consumes its captured attachment subset and preserves other draft files", async (t) => {
  const firstStarted = deferred(); const releaseFirst = deferred();
  await withFlow(t, async (flow) => {
    const existingDraft = await upload(flow, "existing-draft.png");
    const running = send(flow, "Inspect the track before using a reference.", []);
    try {
      await firstStarted.promise;
      const queued = await upload(flow, "queued-reference.png");
      const otherDraft = await upload(flow, "later-draft.txt", Buffer.from("LATER_DRAFT_EXCLUDED_FROM_QUEUED_SEND"));
      assert.deepEqual(images(flow.requests[0]!.currentUserContent), []);
      releaseFirst.resolve(); await expectStatus(await running, 200);
      await expectStatus(await send(flow, "Use the queued reference.", [queued.id]), 200);
      assert.equal(flow.requests.length, 2);
      assert.deepEqual(images(flow.requests[1]!.currentUserContent), [{ type: "image", fileName: "queued-reference.png", mediaType: "image/png", base64: png.toString("base64") }]);
      assert.doesNotMatch(JSON.stringify(flow.requests[1]), /existing-draft\.png|LATER_DRAFT_EXCLUDED_FROM_QUEUED_SEND/);
      const users = (await loadSessionEvents(flow.directory, flow.sessionId)).filter((event) => event.kind === "user");
      assert.deepEqual(users.map((event) => event.attachments?.map((entry) => entry.id) ?? []), [[], [queued.id]]);
      assert.deepEqual((await pending(flow)).map((entry) => entry.id), [existingDraft.id, otherDraft.id]);
      await expectStatus(await remove(flow, queued.id), 409);
    } finally {
      releaseFirst.resolve();
      await running.then((response) => { if (!response.bodyUsed) return response.text(); });
    }
  }, async (_request, turn) => {
    if (turn === 1) { firstStarted.resolve(); await releaseFirst.promise; }
    return { content: "Ready.", toolCalls: [] };
  });
});

test("a stale selected attachment rejects Send before consuming any selected file", async (t) => {
  await withFlow(t, async (flow) => {
    const valid = await upload(flow, "valid.png");
    const stale = await upload(flow, "stale.png");
    await expectStatus(await remove(flow, stale.id), 200);
    const response = await send(flow, "Use both selected files.", [valid.id, stale.id]);
    const body = await response.json() as { promptPersistence: string };
    assert.notEqual(response.status, 200);
    assert.equal(body.promptPersistence, "not_persisted");
    assert.equal(flow.requests.length, 0);
    assert.equal((await loadSessionEvents(flow.directory, flow.sessionId)).filter((event) => event.kind === "user").length, 0);
    assert.deepEqual((await pending(flow)).map((entry) => entry.id), [valid.id]);
    await expectStatus(await send(flow, "Use the remaining valid file.", [valid.id]), 200);
    assert.equal(flow.requests.length, 1);
    assert.deepEqual(images(flow.requests[0]!.currentUserContent).map((part) => part.fileName), ["valid.png"]);
    assert.deepEqual(await pending(flow), []);
  });
});

test("rejected steering leaves selected files pending and a corrected selection can continue the active request", async (t) => {
  const modelStarted = deferred(); const releaseModel = deferred();
  await withFlow(t, async (flow) => {
    const valid = await upload(flow, "corrected-reference.png");
    const stale = await upload(flow, "removed-reference.png");
    const sendId = "rejected-steering-send";
    const running = send(flow, "Inspect the track.", [], sendId);
    try {
      await modelStarted.promise;
      await expectStatus(await remove(flow, stale.id), 200);
      const rejected = await steer(flow, sendId, "stale-steering-selection", "Use both selected files.", [valid.id, stale.id]);
      const body = await rejected.json() as { steeringOutcome?: string };
      assert.notEqual(rejected.status, 200);
      assert.notEqual(body.steeringOutcome, "unknown");
      assert.equal((await loadSessionEvents(flow.directory, flow.sessionId)).filter((event) => event.kind === "user").length, 1);
      assert.deepEqual((await pending(flow)).map((entry) => entry.id), [valid.id]);
      await expectStatus(await steer(flow, sendId, "corrected-steering-selection", "Use the remaining file.", [valid.id]), 200);
      await expectStatus(await running, 200);
      const users = (await loadSessionEvents(flow.directory, flow.sessionId)).filter((event) => event.kind === "user");
      assert.deepEqual(users.map((event) => ({ content: event.content, ids: event.attachments?.map((entry) => entry.id) ?? [] })), [
        { content: "Inspect the track.", ids: [] }, { content: "Use the remaining file.", ids: [valid.id] },
      ]);
      assert.deepEqual(await pending(flow), []);
    } finally {
      releaseModel.resolve();
      await running.then((response) => { if (!response.bodyUsed) return response.text(); });
    }
  }, async (request) => {
    const corrected = request.agentMessages.find((message) => message.role === "user" &&
      Array.isArray(message.content) && images(message.content).some((part) => part.fileName === "corrected-reference.png"));
    if (corrected) return { content: "The remaining reference was used.", toolCalls: [] };
    modelStarted.resolve();
    await Promise.race([releaseModel.promise, waitForAbort(request.signal!)]);
    return { content: "Interrupted answer.", toolCalls: [] };
  });
});

test("Send and Steer reject malformed, duplicate, unsafe and oversized attachment selections before model admission", async (t) => {
  await withFlow(t, async (flow) => {
    const draft = await upload(flow, "unselected.png");
    const invalidHeaders = [
      "[", JSON.stringify("attachment-id"), JSON.stringify(["duplicate", "duplicate"]),
      JSON.stringify(["one", "two", "three", "four", "five"]), JSON.stringify(["../outside"]), JSON.stringify([1]),
    ];
    for (const pathname of ["/send", "/steer"]) {
      for (const selection of invalidHeaders) {
        const sequence = ++requestSequence;
        const response = await fetch(endpoint(flow.url, pathname), { method: "POST", headers: {
          "Content-Type": "application/json", "X-Live-Smith-Send-Id": `invalid-selection-send-${sequence}`,
          ...(pathname === "/steer" ? { "X-Live-Smith-Steer-Id": `invalid-selection-steer-${sequence}` } : {}),
          "X-Live-Smith-Attachment-Ids": selection,
        }, body: JSON.stringify({ prompt: "Inspect the reference.", sessionId: flow.sessionId }) });
        await expectStatus(response, 400);
      }
    }
    assert.equal(flow.requests.length, 0);
    assert.equal((await loadSessionEvents(flow.directory, flow.sessionId)).filter((event) => event.kind === "user").length, 0);
    assert.deepEqual((await pending(flow)).map((entry) => entry.id), [draft.id]);
  });
});
