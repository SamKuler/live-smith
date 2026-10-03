import { saveAudioAsset } from "../../../src/storage/audio-assets.js";
import { createAudioJob, updateAudioJob } from "../../../src/storage/audio-jobs.js";
import { saveMidiArtifact, parseMidiArtifact } from "../../../src/storage/midi-artifacts.js";
import { midiBytes, noteTrack } from "../../attachments/support/midi-test-helpers.js";
import { consumedAttachmentIds } from "../../../src/app/agent-request.js";
import { ModelInputTooLargeError } from "../../../src/model/connection-error.js";
import { readSessionAttachmentBytes } from "../../../src/storage/attachments.js";
import { waveBytes, mp3Bytes } from "../../storage/support/audio-storage-test-helpers.js";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { URL } from "node:url";

import { runAgentFlow, type AgentFlowDependencies } from "../../../src/app/agent-flow.js";
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
  openAttachment?: AgentFlowDependencies["openAttachment"],
  audioInput = false,
  exportOptions: Pick<AgentFlowDependencies, "openMidiDownload"> = {},
) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-followup-attachments-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, {
    id: "followup-profile", name: "Followup model", defaultModel: "fixture-model",
    connection: { kind: "direct-api", apiFamily: "openai", apiMode: audioInput ? "chat-completions" : "responses", baseUrl: "https://example.test/v1", apiKey: "test-key" },
    models: [{ model: "fixture-model", parameters: { maxOutputTokens: 2048, reasoning: { mode: "default" } },
      advanced: { capabilityOverrides: { inputs: { image: true, ...(audioInput ? { audio: true } : {}) } } } }],
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
    ...exportOptions,
    ...(openAttachment === undefined ? {} : { openAttachment }),
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

async function upload(flow: Flow, fileName: string, bytes: Uint8Array = png, expectedFileName = fileName): Promise<SessionAttachmentRef> {
  const target = endpoint(flow.url, "/attachments");
  target.searchParams.set("sessionId", flow.sessionId); target.searchParams.set("fileName", fileName);
  const response = await fetch(target, { method: "POST", headers: { "Content-Type": "application/octet-stream" },
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    signal: AbortSignal.timeout(10_000) });
  const body = await expectStatus(response, 201);
  const state = JSON.parse(body) as ChatDialogState;
  const attachment = state.pendingAttachments.find((entry) => entry.fileName === expectedFileName);
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
    consumedAttachmentIds(events));
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


test("stored attachment preview and native open remain available during generation without changing messages", async (t) => {
  const entered = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const opened: string[] = [];
  await withFlow(t, async (flow) => {
    const image = await upload(flow, "reference.png");
    const running = send(flow, "Inspect the image", [image.id], "preview-send");
    try {
      await entered.promise;
      const before = await loadSessionEvents(flow.directory, flow.sessionId);
      const previewUrl = endpoint(flow.url, `/attachments/${image.id}`);
      previewUrl.searchParams.set("sessionId", flow.sessionId);
      const preview = await fetch(previewUrl, { signal: AbortSignal.timeout(2_000) });
      assert.equal(preview.status, 200, await preview.clone().text());
      assert.equal(preview.headers.get("content-type"), "image/png");
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
      const open = await fetch(endpoint(flow.url, "/command"), {
        method: "POST", headers: { "Content-Type": "application/json", "X-Live-Smith-Command-Id": "open-image" },
        body: JSON.stringify({ kind: "open_attachment", sessionId: flow.sessionId, attachmentId: image.id }),
        signal: AbortSignal.timeout(2_000),
      });
      assert.equal(open.status, 200, await open.text());
      assert.deepEqual(opened, [image.id]);
      assert.deepEqual(await loadSessionEvents(flow.directory, flow.sessionId), before);
      const foreign = new URL(previewUrl);
      foreign.searchParams.set("sessionId", "foreign-session");
      const denied = await fetch(foreign);
      assert.equal(denied.status, 404); await denied.text();
      const invalid = await fetch(endpoint(flow.url, "/command"), {
        method: "POST", headers: { "Content-Type": "application/json", "X-Live-Smith-Command-Id": "open-forged" },
        body: JSON.stringify({ kind: "open_attachment", sessionId: flow.sessionId, attachmentId: image.id, path: "/tmp/other" }),
      });
      assert.equal(invalid.status, 400); await invalid.text();
      assert.deepEqual(opened, [image.id]);
    } finally {
      finished.resolve();
      const response = await running;
      assert.equal(response.status, 200, await response.text());
    }
  }, async () => {
    entered.resolve();
    await finished.promise;
    return { content: "Ready.", toolCalls: [] };
  }, async (file) => {
    opened.push(file.attachment.id);
    assert.equal(file.attachment.fileName, "reference.png");
    assert.deepEqual(Buffer.from(file.bytes), png);
  });
});


test("oversized audio recovery stages and sends an excerpt, then reuses the original without uploading it", async (t) => {
  await withFlow(t, async (flow) => {
    const bytes = waveBytes(2);
    const original = await upload(flow, "Reference.wav", bytes);
    await expectStatus(await send(flow, "Listen to the reference", [original.id]), 500);
    const failed = await loadSessionEvents(flow.directory, flow.sessionId);
    assert.ok(failed.some((event) => event.name === "input_too_large"));
    const select = async (id: string, mode: "copy" | "excerpt", replace: boolean) => {
      const url = endpoint(flow.url, `/attachments/${id}`);
      url.searchParams.set("sessionId", flow.sessionId); url.searchParams.set("mode", mode); url.searchParams.set("replace", String(replace));
      if (mode === "excerpt") { url.searchParams.set("start", ".5"); url.searchParams.set("end", "1"); }
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array() });
      return JSON.parse(await expectStatus(response, 201)) as ChatDialogState;
    };
    const selectedState = await select(original.id, "excerpt", false);
    const excerpt = selectedState.pendingAttachments[0]!;
    assert.notEqual(excerpt.id, original.id);
    assert.equal(excerpt.kind === "audio" && excerpt.durationSeconds, .5);
    await expectStatus(await send(flow, "Listen only to this excerpt", [excerpt.id]), 200);
    const request = flow.requests.at(-1)!;
    const audio = request.currentUserContent.filter((part) => part.type === "audio");
    assert.equal(audio.length, 1);
    assert.deepEqual(audio[0]!.bytes, await readSessionAttachmentBytes(flow.directory, flow.sessionId, excerpt.id));
    assert.doesNotMatch(JSON.stringify(request), new RegExp(original.id));
    assert.deepEqual(await readSessionAttachmentBytes(flow.directory, flow.sessionId, original.id), bytes);
    assert.equal((await pending(flow)).length, 0);
    const reused = (await select(original.id, "copy", false)).pendingAttachments[0]!;
    assert.notEqual(reused.id, original.id); assert.equal(reused.sha256, original.sha256);
    await expectStatus(await remove(flow, reused.id), 200);
    assert.equal((await pending(flow)).length, 0);
    const illegal = endpoint(flow.url, `/attachments/${original.id}`);
    illegal.searchParams.set("sessionId", flow.sessionId); illegal.searchParams.set("mode", "copy"); illegal.searchParams.set("replace", "true");
    await expectStatus(await fetch(illegal, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array() }), 409);
  }, (_, turn) => {
    if (turn === 1) throw new ModelInputTooLargeError("The provider rejected this audio size.");
    return { content: "The short excerpt is available.", toolCalls: [] };
  }, undefined, true);
});


test("saved MIDI versions export portable bytes and attach to the next message during an active send", async (t) => {
  let enter!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; });
  let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
  let expectedBytes: Uint8Array; let exported = false;
  const midiDocuments = (request: TransportRequest) => request.currentUserContent.flatMap((part) => {
    if (part.type !== "text") return [];
    return part.text.split("\n").flatMap((line) => {
      try {
        const document = JSON.parse(line);
        return document?.mediaType === "audio/midi" && typeof document.content === "string"
          ? [document.content.trim().split("\n").map((entry: string) => JSON.parse(entry))] : [];
      } catch { return []; }
    });
  });
  await withFlow(t, async (flow) => {
    const bytes = midiBytes({ tracks: [noteTrack({ pitch: 60 }), noteTrack({ pitch: 48, channel: 2 })] });
    const original = await saveMidiArtifact(flow.directory, flow.sessionId, { connectionId: "midi-generator", serverId: "local",
      toolName: "compose", label: "主歌/钢琴\u200f", bytes, signal: new AbortController().signal });
    expectedBytes = midiBytes({ tracks: [noteTrack({ pitch: 64 }), noteTrack({ pitch: 48, channel: 2 })] });
    const version = await saveMidiArtifact(flow.directory, flow.sessionId, { connectionId: "midi-generator", serverId: "local",
      toolName: "compose", label: "主歌/钢琴\u200f", bytes: expectedBytes, revisionOf: original.id, signal: new AbortController().signal });
    const running = send(flow, "Keep this request open.", [], "midi-export-open-send");
    try {
      await entered;
      const command = async (kind: string, commandId: string, artifactRef = version.id) => {
        const response = await fetch(endpoint(flow.url, "/command"), { method: "POST", headers: {
          "Content-Type": "application/json", "X-Live-Smith-Command-Id": commandId,
        }, body: JSON.stringify({ kind, sessionId: flow.sessionId, artifact: { kind: "midi", id: artifactRef } }), signal: AbortSignal.timeout(5000) });
        const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text) as ChatDialogState;
      };
      const attached = await command("attach_artifact", "attach-midi-version");
      const attachment = attached.pendingAttachments.find((item) => item.mediaType === "audio/midi")!;
      assert.ok(attachment); assert.match(attachment.fileName, /-v2-.*\.mid$/u); assert.doesNotMatch(attachment.fileName, /[\/]/u);
      assert.deepEqual(await readSessionAttachmentBytes(flow.directory, flow.sessionId, attachment.id), expectedBytes);
      const repeated = await command("attach_artifact", "reattach-midi-version");
      assert.deepEqual(repeated.pendingAttachments.map((item) => item.id), [attachment.id]);
      const sameBytesVersion = await saveMidiArtifact(flow.directory, flow.sessionId, { connectionId: "midi-generator", serverId: "local",
        toolName: "compose", label: "主歌/钢琴\u200f", bytes: expectedBytes, revisionOf: version.id, signal: new AbortController().signal });
      await command("attach_artifact", "attach-midi-original", original.id);
      const different = await command("attach_artifact", "attach-midi-next-version", sameBytesVersion.id);
      assert.equal(different.pendingAttachments.length, 3, "different versions remain distinct even when bytes match");
      await upload(flow, "reference.png");
      const full = await command("attach_artifact", "reattach-midi-at-capacity");
      assert.equal(full.pendingAttachments.length, 4);
      assert.equal(full.pendingAttachments.filter((item) => item.id === attachment.id).length, 1);
      await command("export_artifact", "export-midi-version"); assert.equal(exported, true);
      assert.equal(flow.requests.length, 1);
      assert.deepEqual(midiDocuments(flow.requests[0]!), []);
      release(); const result = await running; assert.equal(result.status, 200, await result.text());
      const next = await send(flow, "Read both MIDI parts.", [attachment.id], "send-midi-version");
      assert.equal(next.status, 200, await next.text());
      const documents = midiDocuments(flow.requests[1]!);
      assert.equal(documents.length, 1);
      assert.equal(documents[0]![0].trackCount, 2);
      const reused = await command("attach_artifact", "attach-midi-after-send");
      assert.ok(reused.pendingAttachments.some((item) => item.fileName === attachment.fileName && item.id !== attachment.id),
        "a sent version can be attached to a later request");
      assert.deepEqual(documents[0]!.filter((entry: { type: string }) => entry.type === "note")
        .map((entry: { pitch: number }) => entry.pitch), [64, 48]);
    } finally { release(); const response = await running; if (!response.bodyUsed) await response.text(); }
  }, async (_request, turn) => {
    if (turn === 1) { enter(); await pending; }
    return { content: "Done.", toolCalls: [] };
  }, undefined, false, { openMidiDownload: async (target) => {
    assert.equal(new URL(target).pathname, "/midi-download");
    const response = await fetch(target); assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/midi");
    assert.match(response.headers.get("content-disposition")!, /filename\*=UTF-8''.*-v2-.*\.mid/u);
    const bytes = new Uint8Array(await response.arrayBuffer()); assert.deepEqual(bytes, expectedBytes!);
    assert.equal(parseMidiArtifact(bytes).parts.length, 2); exported = true;
  } });
});


for (const { label, fileName, storedName } of [
  { label: "unchanged names", fileName: "notes.txt", storedName: "notes.txt" },
  { label: "direction controls", fileName: "notes\u200f.txt", storedName: "notes.txt" },
  { label: "decomposed Unicode", fileName: "Cafe\u0301.txt", storedName: "Café.txt" },
  { label: "empty sanitized basenames", fileName: "../\u200f", storedName: "document.txt" },
]) {
  test(`draft uploads reuse identical files with ${label} but retain changed content`, async (t) => {
    await withFlow(t, async (flow) => {
      const original = Buffer.from("take A");
      const changed = Buffer.from("take B");
      const first = await upload(flow, fileName, original, storedName);
      const repeated = await upload(flow, fileName, original, storedName);
      assert.equal(first.id, repeated.id);
      assert.deepEqual((await pending(flow)).map((entry) => entry.id), [first.id]);
      const canonical = await upload(flow, storedName, original);
      assert.equal(canonical.id, first.id);
      await upload(flow, fileName, changed, storedName);
      const files = await pending(flow);
      assert.deepEqual(files.map((file) => file.fileName), [storedName, storedName]);
      assert.deepEqual(await Promise.all(files.map((file) => readSessionAttachmentBytes(flow.directory, flow.sessionId, file.id))),
        [new Uint8Array(original), new Uint8Array(changed)]);
      assert.equal(flow.requests.length, 0);
    }, async () => ({ content: "Done.", toolCalls: [] }));
  });
}

async function saveLocalAudioOutput(flow: Flow, bytes: Uint8Array) {
  const job = await createAudioJob(flow.directory, flow.sessionId, { provider: "elevenlabs", serviceId: "local-fixture",
    connectionFingerprint: "a".repeat(64), operation: "generate_music", stems: [] });
  const asset = await saveAudioAsset(flow.directory, flow.sessionId, { jobId: job.id, role: "music",
    label: "主歌/钢琴 🎵", origin: { kind: "generated" }, bytes, signal: new AbortController().signal });
  await updateAudioJob(flow.directory, flow.sessionId, job.id, { status: "completed", outputAssets: [asset] });
  return asset;
}

async function attachAudioOutput(flow: Flow, id: string, commandId: string) {
  return fetch(endpoint(flow.url, "/command"), { method: "POST", headers: {
    "Content-Type": "application/json", "X-Live-Smith-Command-Id": commandId,
  }, body: JSON.stringify({ kind: "attach_artifact", sessionId: flow.sessionId, artifact: { kind: "audio", id } }),
    signal: AbortSignal.timeout(5_000) });
}

for (const [format, bytes] of [["WAV", waveBytes()], ["MP3", mp3Bytes()]] as const) {
  test(`saved ${format} outputs attach original files during generation and retain normal audio admission`, async (t) => {
    const entered = deferred(); const release = deferred();
    await withFlow(t, async (flow) => {
      const asset = await saveLocalAudioOutput(flow, bytes);
      const second = await saveLocalAudioOutput(flow, bytes);
      const third = await saveLocalAudioOutput(flow, bytes);
      const running = send(flow, "Keep this request open.", [], "audio-attach-open-send");
      try {
        await entered.promise;
        const attached = JSON.parse(await expectStatus(await attachAudioOutput(flow, asset.id, "attach-audio"), 200)) as ChatDialogState;
        const attachment = attached.pendingAttachments[0]!;
        assert.equal(attachment.kind, "audio");
        assert.equal(attachment.mediaType, asset.mediaType);
        assert.equal(attachment.fileName, `主歌 钢琴 🎵-${asset.id}.${format.toLowerCase()}`);
        assert.deepEqual(await readSessionAttachmentBytes(flow.directory, flow.sessionId, attachment.id), bytes);
        const repeated = JSON.parse(await expectStatus(await attachAudioOutput(flow, asset.id, "reattach-audio"), 200)) as ChatDialogState;
        assert.deepEqual(repeated.pendingAttachments.map((entry) => entry.id), [attachment.id]);
        const distinct = JSON.parse(await expectStatus(await attachAudioOutput(flow, second.id, "attach-second-audio"), 200)) as ChatDialogState;
        assert.equal(distinct.pendingAttachments.length, 2, "same bytes and label from different outputs remain distinct");
        assert.notEqual(distinct.pendingAttachments[0]!.fileName, distinct.pendingAttachments[1]!.fileName);
        await expectStatus(await attachAudioOutput(flow, third.id, "attach-third-audio"), 413);
        const full = JSON.parse(await expectStatus(await attachAudioOutput(flow, asset.id, "reattach-at-audio-capacity"), 200)) as ChatDialogState;
        assert.deepEqual(full.pendingAttachments.map((entry) => entry.id), distinct.pendingAttachments.map((entry) => entry.id));
        assert.equal(flow.requests.length, 1);
        assert.deepEqual(flow.requests[0]!.currentUserContent.filter((part) => part.type === "audio"), []);
        release.resolve(); await expectStatus(await running, 200);
        await expectStatus(await send(flow, "Listen to this original output.", [attachment.id], "send-audio-output"), 200);
        const audio = flow.requests[1]!.currentUserContent.filter((part) => part.type === "audio");
        assert.equal(audio.length, 1); assert.deepEqual(audio[0]!.bytes, bytes);
        const reused = JSON.parse(await expectStatus(await attachAudioOutput(flow, asset.id, "attach-audio-after-send"), 200)) as ChatDialogState;
        assert.ok(reused.pendingAttachments.some((entry) => entry.fileName === attachment.fileName && entry.id !== attachment.id));
      } finally {
        release.resolve(); const response = await running; if (!response.bodyUsed) await response.text();
      }
    }, async (_request, turn) => {
      if (turn === 1) { entered.resolve(); await release.promise; }
      return { content: "Done.", toolCalls: [] };
    }, undefined, true);
  });
}

test("attaching saved audio does not bypass the active Profile's audio input policy", async (t) => {
  await withFlow(t, async (flow) => {
    const asset = await saveLocalAudioOutput(flow, waveBytes());
    const attached = JSON.parse(await expectStatus(await attachAudioOutput(flow, asset.id, "attach-for-incompatible-model"), 200)) as ChatDialogState;
    const attachment = attached.pendingAttachments[0]!;
    assert.equal(attachment.kind, "audio");
    assert.equal(flow.requests.length, 0);
    const sent = await send(flow, "Listen to this output.", [attachment.id], "send-incompatible-audio");
    const error = await sent.text();
    assert.equal(sent.status, 500, error);
    assert.equal(JSON.parse(error).promptPersistence, "not_persisted");
    assert.match(error, /cannot read audio attachments/u);
    assert.equal(flow.requests.length, 0);
    assert.deepEqual((await pending(flow)).map((entry) => entry.id), [attachment.id]);
  });
});
