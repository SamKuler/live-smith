import { agentRequestContext } from "./support/agent-context.js";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import test, { type TestContext } from "node:test";

import { SEPARATION_STEMS, type AudioServiceAdapter } from "../../../src/audio-services/contracts.js";
import {
  consumedAttachmentIds, handleAgentRequest, steeringReceiptFor,
  type AgentModelTurnRequester,
} from "../../../src/app/agent-request.js";
import { SteeringChannel } from "../../../src/app/chat/steering.js";
import { AttachmentInputCapabilityError } from "../../../src/app/context/attachment-context.js";
import { runtimeProfileForSavedProfile } from "../../../src/app/model/model-request.js";
import type { RuntimeProfile } from "../../../src/model/provider.js";
import { builtInAudioToolName } from "../../../src/plugins/builtins/audio-toolsets.js";
import { lalalPlugin } from "../../../src/plugins/builtins/lalal.js";
import {
  listPendingSessionAttachments, saveSessionAttachment, sessionAttachmentRefFromStored,
} from "../../../src/storage/attachments.js";
import { appendSessionEvent, loadSessionEvents } from "../../../src/storage/events.js";
import { StorageCommitOutcomeUnknownError } from "../../../src/storage/persistence.js";
import { createSession } from "../../../src/storage/sessions.js";
import { modelMessageText } from "../../model/support/model-message-test-helpers.js";
import { waveBytes } from "../../storage/support/audio-storage-test-helpers.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";
import { saveIntegrationConnection } from "../plugins/support/integration-connection-test-helpers.js";

test("steering sends and consumes exactly the selected files inside the attachment fence", async (t) => {
  const harness = await requestHarness(t, { image: true, pdf: true });
  const image = await harness.save("reference.png", pngBytes());
  const pdfBytes = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
  const pdf = await harness.save("score.pdf", pdfBytes);
  const queued = await harness.save("queued.txt", Buffer.from("Leave this file pending"));
  let fenced = false;
  let fenceCount = 0;
  let appendCount = 0;
  let submitted: Promise<void> | undefined;
  let turns = 0;
  const result = await harness.run(async (input) => {
    if (++turns === 1) {
      assert.deepEqual(input.attachmentParts, []);
      submitted = harness.steering.submit("selected-files", "Use these references", [pdf.id, image.id]);
      return { content: "Discard this interrupted output", toolCalls: [] };
    }
    assert.deepEqual(input.agentMessages, [{
      role: "user", content: [
        { type: "text", text: "Use these references" },
        { type: "document", fileName: "score.pdf", mediaType: "application/pdf", base64: pdfBytes.toString("base64") },
        { type: "image", fileName: "reference.png", mediaType: "image/png", base64: Buffer.from(pngBytes()).toString("base64") },
      ],
    }]);
    return { content: "References received", toolCalls: [] };
  }, {
    withAttachmentMutation: async (operation) => {
      assert.equal(fenced, false);
      fenced = true;
      fenceCount++;
      try { return await operation(); } finally { fenced = false; }
    },
  }, async (...args) => {
    assert.equal(fenced, true);
    const event = await appendSessionEvent(...args);
    if (++appendCount === 2) {
      throw new StorageCommitOutcomeUnknownError(new Error("Injected steering sync uncertainty"));
    }
    return event;
  });
  await submitted;
  assert.equal(result, "References received");
  assert.equal(fenceCount, 2);
  const users = (await harness.events()).filter((event) => event.kind === "user");
  assert.equal(users[0]?.attachments, undefined);
  assert.deepEqual(users[1]?.attachments?.map((ref) => ref.id), [pdf.id, image.id]);
  assert.deepEqual(users[1]?.steeringReceipt,
    steeringReceiptFor("send-attachments", "selected-files", "Use these references", [pdf.id, image.id]));
  assert.deepEqual((await harness.pending()).map((ref) => ref.id), [queued.id]);
});

test("text steering leaves newly uploaded files pending", async (t) => {
  const harness = await requestHarness(t);
  const waiting = await harness.save("pending.txt", Buffer.from("Pending context"));
  let submitted: Promise<void> | undefined;
  let turns = 0;
  await harness.run(async (input) => {
    if (++turns === 1) {
      submitted = harness.steering.submit("text-only", "Inspect the Lead");
      return { content: null, toolCalls: [] };
    }
    assert.deepEqual(input.agentMessages, [{ role: "user", content: "Inspect the Lead" }]);
    return { content: "Done", toolCalls: [] };
  });
  await submitted;
  assert.deepEqual((await harness.pending()).map((ref) => ref.id), [waiting.id]);
});

test("an incompatible steering attachment is rejected while the request continues", async (t) => {
  const harness = await requestHarness(t);
  const image = await harness.save("reference.png", pngBytes());
  let rejection: Promise<unknown> | undefined;
  let turns = 0;
  let draft = "";
  let resets = 0;
  const result = await harness.run(async (input) => {
    if (++turns === 1) {
      await input.onDelta("Interrupted draft");
      rejection = harness.steering.submit("incompatible-image", "Read this image", [image.id])
        .catch((error: unknown) => error);
      return { content: "Interrupted", toolCalls: [] };
    }
    assert.deepEqual(input.agentMessages, []);
    assert.equal(draft, "");
    return { content: "Completed the original request", toolCalls: [] };
  }, {
    onDelta: (delta) => { draft += delta; },
    onModelRequestRetry: () => { draft = ""; resets++; },
  });
  assert.ok(await rejection instanceof AttachmentInputCapabilityError);
  assert.equal(result, "Completed the original request");
  assert.equal(resets, 1);
  assert.equal((await harness.events()).filter((event) => event.kind === "user").length, 1);
  assert.deepEqual((await harness.pending()).map((ref) => ref.id), [image.id]);
});

for (const source of ["consumed", "another-session"] as const) {
  test(`steering cannot use an attachment ${source === "consumed" ? "already consumed" : "from another Session"}`, async (t) => {
    const harness = await requestHarness(t);
    const owner = source === "consumed" ? harness.session : await createSession(harness.directory, {
      title: "Other Session", projectKey: "project", scope: harness.session.scope,
    });
    const attachment = await harness.save("reference.txt", Buffer.from("Source context"), owner.id);
    let rejection: Promise<unknown> | undefined;
    let turns = 0;
    await harness.run(async (input) => {
      if (++turns === 1) {
        rejection = harness.steering.submit("unavailable-file", "Read this file", [attachment.id])
          .catch((error: unknown) => error);
        return { content: null, toolCalls: [] };
      }
      assert.deepEqual(input.agentMessages, []);
      return { content: "Done", toolCalls: [] };
    }, { attachmentIds: source === "consumed" ? [attachment.id] : [] });
    assert.match(String(await rejection), /no longer pending in this Session/);
    assert.equal((await harness.events()).filter((event) => event.kind === "user").length, 1);
  });
}

test("steering shares the original request attachment count budget", async (t) => {
  const harness = await requestHarness(t);
  const initial = [];
  for (let index = 0; index < 4; index++) {
    initial.push(await harness.save(`part-${index}.txt`, Buffer.from(`Part ${index}`)));
  }
  let rejection: Promise<unknown> | undefined;
  let followupId = "";
  let turns = 0;
  await harness.run(async () => {
    if (++turns === 1) {
      followupId = (await harness.save("followup.txt", Buffer.from("More context"))).id;
      rejection = harness.steering.submit("too-many-files", "Add this file", [followupId])
        .catch((error: unknown) => error);
      return { content: null, toolCalls: [] };
    }
    return { content: "Done", toolCalls: [] };
  }, { attachmentIds: initial.map((ref) => ref.id) });
  assert.match(String(await rejection), /Attachments exceed the model request limit/);
  assert.deepEqual((await harness.pending()).map((ref) => ref.id), [followupId]);
});

for (const previous of ["history", "steering"] as const) {
  test(`steering document text shares the request budget with ${previous}`, async (t) => {
    const harness = await requestHarness(t);
    const first = await harness.save("first.txt", Buffer.from("A".repeat(100_000)));
    const second = await harness.save("second.txt", Buffer.from("B".repeat(100_000)));
    const excess = await harness.save("excess.txt", Buffer.from("C"));
    if (previous === "history") {
      await appendSessionEvent(harness.directory, harness.session.id, {
        kind: "user", content: "Earlier document", attachments: [sessionAttachmentRefFromStored(first)],
      });
    }
    let accepted: Promise<void> | undefined;
    let rejection: Promise<unknown> | undefined;
    let turns = 0;
    await harness.run(async (input) => {
      turns++;
      if (previous === "steering" && turns === 1) {
        accepted = harness.steering.submit("second-document", "Read the second document", [second.id]);
        return { content: null, toolCalls: [] };
      }
      if (turns === (previous === "steering" ? 2 : 1)) {
        rejection = harness.steering.submit("excess-document", "Read the excess document", [excess.id])
          .catch((error: unknown) => error);
        return { content: null, toolCalls: [] };
      }
      assert.equal(input.agentMessages.filter((message) => message.role === "user").length,
        previous === "steering" ? 1 : 0);
      return { content: "Done", toolCalls: [] };
    }, { attachmentIds: [previous === "history" ? second.id : first.id] });
    await accepted;
    assert.match(String(await rejection), /Extracted document text exceeds the model request limit/);
    assert.deepEqual((await harness.pending()).map((ref) => ref.id), [excess.id]);
  });
}

test("audio tools can process audio accepted by steering", async (t) => {
  const harness = await requestHarness(t);
  await saveIntegrationConnection(harness.directory, "0", {
    id: "splitter", name: "Stem account", provider: "lalal", enabled: true, apiKey: "fixture-audio-key",
  });
  const original = await harness.save("original.wav", waveBytes());
  const audio = await harness.save("reference.wav", waveBytes(2));
  let uploads = 0;
  const adapter: AudioServiceAdapter = {
    provider: "lalal", stems: SEPARATION_STEMS,
    upload: async (bytes) => { assert.deepEqual(bytes, waveBytes(2)); uploads++; return "source"; },
    submit: async () => "task",
    inspect: async () => ({ status: "completed", outputs: [
      { key: "vocals", role: "vocals", url: "https://d.lalal.ai/vocals" },
      { key: "rest", role: "residual", url: "https://d.lalal.ai/rest" },
    ] }),
    download: async () => waveBytes(),
  };
  let submitted: Promise<void> | undefined;
  let turns = 0;
  await harness.run(async (input) => {
    if (++turns === 1) {
      assert.match(input.requestAudioSampleSourceInstructions ?? "", /Audio input 1:/);
      submitted = harness.steering.submit("audio-reference", "Separate the vocals", [audio.id]);
      return { content: null, toolCalls: [] };
    }
    if (turns === 2) {
      const match = input.requestAudioSampleSourceInstructions?.match(/Audio input 2: (\{[^\n]+\})/);
      assert.ok(match?.[1]);
      assert.equal(JSON.parse(match[1]).audioIndex, 1);
      assert.deepEqual(input.agentMessages, [{ role: "user", content: "Separate the vocals" }]);
      return { content: null, toolCalls: [{
        id: "split", name: builtInAudioToolName(lalalPlugin, "separate_stems"),
        arguments: JSON.stringify({ connectionId: "splitter", source: JSON.parse(match[1]), stems: ["vocals"] }),
      }] };
    }
    assert.equal(JSON.parse(modelMessageText(input.agentMessages.at(-1))).status, "completed");
    return { content: "Stems ready", toolCalls: [] };
  }, { attachmentIds: [original.id], audioProcessing: { adapter, wait: async () => {} } });
  await submitted;
  assert.equal(uploads, 1);
  assert.deepEqual(await harness.pending(), []);
});

async function requestHarness(t: TestContext, inputs: Partial<RuntimeProfile["capabilities"]["inputs"]> = {}) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-steering-attachments-");
  const session = await createSession(directory, {
    title: "Steering attachments", projectKey: "project", scope: { kind: "track", identity: "lead", label: "Lead" },
  });
  const base = runtimeProfileForSavedProfile({
    id: "steering-profile", name: "Provider", defaultModel: "custom-model",
    connection: { kind: "direct-api", apiFamily: "openai", apiMode: "responses", baseUrl: "https://example.test/v1", apiKey: "fixture-key" },
    models: [{ model: "custom-model", parameters: { maxOutputTokens: 1024, reasoning: { mode: "default" } }, advanced: {} }],
  });
  const runtime: RuntimeProfile = {
    ...base, capabilities: { ...base.capabilities, inputs: { image: false, audio: false, pdf: false, ...inputs } },
  };
  const steering = new SteeringChannel();
  t.after(async () => { steering.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const events = () => loadSessionEvents(directory, session.id);
  const pending = async (sessionId = session.id) => listPendingSessionAttachments(directory, sessionId,
    consumedAttachmentIds(await loadSessionEvents(directory, sessionId)));
  const save = async (fileName: string, bytes: Uint8Array, sessionId = session.id) => saveSessionAttachment(
    directory, sessionId, { fileName, bytes }, { preSavePendingAttachmentRefs: await pending(sessionId) },
  );
  const run = (
    requestTurn: AgentModelTurnRequester,
    overrides: Partial<Parameters<typeof handleAgentRequest>[7]> = {},
    appendUserEvent = appendSessionEvent,
  ) => handleAgentRequest(
    agentRequestContext({ application: { song: { tempo: 120 } }, environment: { storageDirectory: directory, tempDirectory: directory } } as never),
    directory, { presentation: liveContextPresentationFixture("Lead"), summary: "Lead", target: {}, scope: session.scope },
    "Inspect the Lead", runtime, "project", session.id,
    { signal: new AbortController().signal, attachmentIds: [], steering, steeringSendId: "send-attachments",
      onDelta() {}, onProgress() {}, onSessionEvent() {}, confirmActions: async () => true, ...overrides },
    requestTurn, appendUserEvent,
  );
  return { directory, session, steering, runtime, run, save, events, pending };
}

function pngBytes(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 0,
  ]);
}
