import assert from "node:assert/strict";
import { Buffer as NodeBuffer } from "node:buffer";
import { IncomingMessage } from "node:http";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { ChatBridgeState, ChatDialogState } from "../ui/chat-state.js";
import { ProfileValidationError } from "../model/profile.js";
import { StorageCommitOutcomeUnknownError } from "../storage/persistence.js";
import { MAX_DOCUMENT_ATTACHMENT_BYTES } from "../attachments/contracts.js";
import { MAX_SKILL_FILE_BYTES } from "../skills/format.js";
import type { SessionEvent } from "../storage/events.js";
import {
  ChatBridgeAttachmentValidationError,
  ChatBridgeCommandOutcomeUnknownError,
  ChatBridgeConflictError,
  ChatBridgePayloadTooLargeError,
  ChatBridgePromptPersistenceUnknownError,
  ChatBridgeResourceNotFoundError,
  ChatBridgeSendFailureError,
  createChatBridge,
} from "./chat-bridge.js";
import {
  readRawAttachmentBody,
  readRawSkillBody,
  readJsonBody,
} from "./chat-bridge-http.js";

const attachmentPng = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0, 1, 0, 0, 0, 1,
]);

function attachmentRequestBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

let correlationSequence = 0;

function correlatedJsonHeaders(
  kind?: "command" | "send",
): Record<string, string> {
  correlationSequence += 1;
  return {
    "Content-Type": "application/json",
    ...(kind === "command"
      ? { "X-Live-Smith-Command-Id": `test-command-${correlationSequence}` }
      : {}),
    ...(kind === "send"
      ? { "X-Live-Smith-Send-Id": `test-send-${correlationSequence}` }
      : {}),
  };
}

test("chat bridge isolates active sends by Session and keeps Session commands available", async () => {
  let releaseSend!: () => void;
  let markStarted!: () => void;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let commandCalls = 0;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => {
      commandCalls += 1;
      return state;
    },
    handleSend: async (input) => {
      if (input.sessionId === "s1") {
        markStarted();
        await sendGate;
      }
    },
  });

  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const sendBody = JSON.stringify({ prompt: "test", sessionId: "s1" });
  const firstSend = fetch(endpoint("/send"), {
    method: "POST",
    headers: correlatedJsonHeaders("send"),
    body: sendBody,
  });

  try {
    await started;
    const secondSend = await fetch(endpoint("/send"), {
      method: "POST",
      headers: correlatedJsonHeaders("send"),
      body: sendBody,
    });
    const otherSessionSend = await fetch(endpoint("/send"), {
      method: "POST",
      headers: correlatedJsonHeaders("send"),
      body: JSON.stringify({ prompt: "other", sessionId: "s2" }),
    });
    const command = await fetch(endpoint("/command"), {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({ kind: "new_session" }),
    });
    const settingsCommand = await fetch(endpoint("/command"), {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({
        kind: "set_session_approval_mode",
        sessionId: "s1",
        approvalMode: "low-risk",
      }),
    });
    const archiveActiveSession = await fetch(endpoint("/command"), {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({ kind: "archive_session", sessionId: "s1" }),
    });
    const selectModelForActiveSession = await fetch(endpoint("/command"), {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({
        kind: "set_session_model_selection",
        sessionId: "s1",
        profileId: "profile-1",
        model: "model-a",
        reasoningEffort: null,
      }),
    });
    const selectModelForOtherSession = await fetch(endpoint("/command"), {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({
        kind: "set_session_model_selection",
        sessionId: "s2",
        profileId: "profile-1",
        model: "model-b",
        reasoningEffort: "high",
      }),
    });
    const loadCapabilitiesForActiveSession = await fetch(endpoint("/command"), {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({
        kind: "load_session_model_capabilities",
        sessionId: "s1",
        profileId: "profile-1",
      }),
    });
    const loadCapabilitiesForOtherSession = await fetch(endpoint("/command"), {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({
        kind: "load_session_model_capabilities",
        sessionId: "s2",
        profileId: "profile-1",
      }),
    });
    const profileCommand = await fetch(endpoint("/command"), {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({ kind: "activate_profile", profileId: "profile-1" }),
    });

    assert.equal(secondSend.status, 409);
    assert.deepEqual(await secondSend.json(), {
      error: "This Session already has an active agent request.",
      promptPersistence: "not_persisted",
    });
    assert.equal(otherSessionSend.status, 200);
    assert.equal(command.status, 200);
    assert.equal(settingsCommand.status, 200);
    assert.equal(archiveActiveSession.status, 409);
    assert.deepEqual(await archiveActiveSession.json(), {
      error: "Stop this Session's active request before archiving it.",
    });
    assert.equal(selectModelForActiveSession.status, 409);
    assert.deepEqual(await selectModelForActiveSession.json(), {
      error: "Wait for this Session's active request to finish before changing its model.",
    });
    assert.equal(selectModelForOtherSession.status, 200);
    assert.equal(loadCapabilitiesForActiveSession.status, 409);
    assert.deepEqual(await loadCapabilitiesForActiveSession.json(), {
      error: "Wait for this Session's active request to finish before loading model capabilities.",
    });
    assert.equal(loadCapabilitiesForOtherSession.status, 200);
    assert.equal(profileCommand.status, 409);
    assert.deepEqual(await profileCommand.json(), {
      error: "Profile settings cannot change while an agent request is active.",
    });
    assert.equal(commandCalls, 4);
  } finally {
    releaseSend();
    await firstSend;
    await bridge.close();
  }
});

test("chat bridge send errors report whether the prompt was persisted", async () => {
  for (const promptPersistence of ["persisted", "not_persisted"] as const) {
    const sendId = `send-${promptPersistence}`;
    const state = {} as ChatDialogState;
    const bridge = await createChatBridge({
      buildState: async () => state,
      renderHtml: () => "<html></html>",
      handleCommand: async () => state,
      handleSend: async (_input, stream) => {
        if (promptPersistence === "persisted") {
          await stream.sessionEvent({
            id: "user-event",
            createdAt: "2026-08-03T00:00:00.000Z",
            kind: "user",
            content: "test",
          });
        }
        throw new Error("Model request failed.");
      },
    });
    const chatUrl = new URL(bridge.url);
    const token = chatUrl.searchParams.get("token");

    try {
      const events = await fetch(`${chatUrl.origin}/events?token=${token}`);
      const response = await fetch(`${chatUrl.origin}/send?token=${token}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Live-Smith-Send-Id": sendId,
        },
        body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
      });

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        error: "Model request failed.",
        promptPersistence,
      });
      const errorEvent = await readSsePayload(events, "error");
      assert.equal(errorEvent.promptPersistence, promptPersistence);
      assert.equal(errorEvent.sendId, sendId);
    } finally {
      await bridge.close();
    }
  }
});

test("chat bridge treats an early handler failure as not persisted", async () => {
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {
      throw new Error("Unexpected send failure.");
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");

  try {
    const response = await fetch(`${chatUrl.origin}/send?token=${token}`, {
      method: "POST",
      headers: correlatedJsonHeaders("send"),
      body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
    });

    assert.deepEqual(await response.json(), {
      error: "Unexpected send failure.",
      promptPersistence: "not_persisted",
    });
  } finally {
    await bridge.close();
  }
});

test("chat bridge parses set_session_skills as a strict bounded command", async () => {
  const state = {} as ChatDialogState;
  const received: unknown[] = [];
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (input) => {
      received.push(input);
      return state;
    },
    handleSend: async () => undefined,
  });
  const chatUrl = new URL(bridge.url);
  const endpoint = `${chatUrl.origin}/command?token=${chatUrl.searchParams.get("token")}`;

  try {
    const accepted = await fetch(endpoint, {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({
        kind: "set_session_skills",
        sessionId: "session-1",
        skillIds: ["mix-review", "drum-editor"],
      }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(received, [{
      kind: "set_session_skills",
      sessionId: "session-1",
      skillIds: ["mix-review", "drum-editor"],
    }]);

    for (const invalid of [
      { skillIds: ["mix-review", "mix-review"] },
      { skillIds: ["Unsafe"] },
      { skillIds: ["a", "b", "c", "d", "e"] },
      { skillIds: ["mix-review"], unexpected: true },
    ]) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: correlatedJsonHeaders("command"),
        body: JSON.stringify({
          kind: "set_session_skills",
          sessionId: "session-1",
          ...invalid,
        }),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(received.length, 1);
  } finally {
    await bridge.close();
  }
});

test("chat bridge publishes only the send failure state captured inside its Session lease", async () => {
  const authoritative = {
    activeSessionId: "s1",
    sessions: [{ id: "s1" }],
  } as ChatDialogState;
  let builds = 0;
  const bridge = await createChatBridge({
    buildState: async () => {
      builds += 1;
      throw new Error("Post-lease state build must not run.");
    },
    renderHtml: () => "<html></html>",
    handleCommand: async () => authoritative,
    handleSend: async (_input, stream) => {
      await stream.sessionEvent({
        id: "user-event",
        createdAt: "2026-08-03T00:00:00.000Z",
        kind: "user",
        content: "test",
      });
      throw new ChatBridgeSendFailureError(
        new Error("Model request failed."),
        authoritative,
      );
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");

  try {
    const events = await fetch(`${chatUrl.origin}/events?token=${token}`);
    const response = await fetch(`${chatUrl.origin}/send?token=${token}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "captured-send-state",
      },
      body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
    });
    const errorEvent = await readSsePayload(events, "error");
    const errorBody = await response.json() as {
      state?: ChatDialogState;
    };

    assert.equal(response.status, 500);
    assert.equal(errorBody.state?.activeSessionId, "s1");
    assert.equal(errorEvent.message, "Model request failed.");
    assert.equal(errorEvent.promptPersistence, "persisted");
    assert.equal((errorEvent.state as ChatDialogState).activeSessionId, "s1");
    assert.equal(
      (errorEvent.state as ChatBridgeState).bridgeStateRevision,
      (errorBody.state as ChatBridgeState).bridgeStateRevision,
    );
    assert.equal(builds, 0);
  } finally {
    await bridge.close();
  }
});

test("chat bridge rejects an invalid send correlation ID before handling the prompt", async () => {
  let sendCalls = 0;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {
      sendCalls += 1;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");

  try {
    const response = await fetch(`${chatUrl.origin}/send?token=${token}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "contains spaces",
      },
      body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "X-Live-Smith-Send-Id must be a valid correlation ID.",
      promptPersistence: "not_persisted",
    });
    assert.equal(sendCalls, 0);
  } finally {
    await bridge.close();
  }
});

test("chat bridge success SSE uses the caller's send correlation ID", async () => {
  const sendId = "send-success-1";
  const state = {
    activeSessionId: "s2",
    sessions: [{ id: "s1" }],
  } as unknown as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");

  try {
    const events = await fetch(`${chatUrl.origin}/events?token=${token}`);
    const response = await fetch(`${chatUrl.origin}/send?token=${token}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": sendId,
      },
      body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
    });

    assert.equal(response.status, 200);
    const responseBody = await response.json() as {
      state: ChatBridgeState;
    };
    const doneEvent = await readSsePayload(events, "done");
    assert.equal(doneEvent.sendId, sendId);
    assert.equal(doneEvent.sessionId, "s1");
    assert.deepEqual(
      (doneEvent.state as ChatDialogState).sessionActivities,
      [{
        sessionId: "s1",
        sendId,
        status: "completed",
        message: "Completed",
        unread: true,
      }],
    );
    assert.equal(
      (doneEvent.state as ChatBridgeState).bridgeStateRevision,
      responseBody.state.bridgeStateRevision,
    );
    assert.equal(
      (doneEvent.state as ChatBridgeState).bridgeStateCoveredThroughRevision,
      responseBody.state.bridgeStateCoveredThroughRevision,
    );
    const selected = await fetch(`${chatUrl.origin}/command?token=${token}`, {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({ kind: "select_session", sessionId: "s1" }),
    });
    const selectedState = await selected.json() as ChatBridgeState;
    assert.equal(selectedState.sessionActivities?.[0]?.unread, false);
    assert.ok(
      BigInt(selectedState.bridgeStateRevision) >
        BigInt(responseBody.state.bridgeStateRevision),
    );
  } finally {
    await bridge.close();
  }
});

test("chat bridge projects steering storage hashes out of SSE and full state", async () => {
  const steeringEvent: SessionEvent = {
    id: "steering-event",
    createdAt: "2026-08-23T00:00:00.000Z",
    kind: "user",
    content: "Leave more headroom",
    steeringReceipt: {
      sendId: "projection-send",
      id: "projection-steer",
      sha256: "a".repeat(64),
    },
  };
  const state = { events: [steeringEvent] } as unknown as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, stream) => {
      await stream.sessionEvent(steeringEvent);
      return state;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  let events: Response | undefined;

  try {
    events = await fetch(endpoint("/events"));
    const eventPayload = readSsePayload(events, "session_event");
    const send = await fetch(endpoint("/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "projection-send",
      },
      body: JSON.stringify({ prompt: "Start", sessionId: "s1" }),
    });
    const published = await eventPayload;
    const body = await send.json() as { state: ChatBridgeState };

    assert.deepEqual(
      (published.event as { steeringAck?: unknown }).steeringAck,
      { sendId: "projection-send", steerId: "projection-steer" },
    );
    assert.deepEqual(body.state.events[0]?.steeringAck, {
      sendId: "projection-send",
      steerId: "projection-steer",
    });
    assert.doesNotMatch(
      JSON.stringify({ published, state: body.state }),
      /steeringReceipt|sha256/,
    );
  } finally {
    await events?.body?.cancel().catch(() => {});
    await bridge.close();
  }
});

test("bridge projection events precede later full-state revisions", async () => {
  const state = {
    activeSessionId: "s1",
    sessions: [{ id: "s1" }],
  } as unknown as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, stream) => {
      await stream.progress("Working");
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");

  try {
    const events = await fetch(`${chatUrl.origin}/events?token=${token}`);
    const send = fetch(`${chatUrl.origin}/send?token=${token}`, {
      method: "POST",
      headers: correlatedJsonHeaders("send"),
      body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
    });
    const progress = await readSsePayload(events, "progress");
    const body = await (await send).json() as { state: ChatBridgeState };

    assert.ok(
      BigInt(progress.bridgeStateRevision as string) <
        BigInt(body.state.bridgeStateRevision),
    );
  } finally {
    await bridge.close();
  }
});

test("a late full-state publication exposes the patch cut captured before its build", async () => {
  let releaseBuild!: () => void;
  let markBuildStarted!: () => void;
  const buildGate = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });
  const buildStarted = new Promise<void>((resolve) => {
    markBuildStarted = resolve;
  });
  const staleState = {
    activeSessionId: "s1",
    approvalMode: "manual",
    sessions: [{ id: "s1", approvalMode: "manual" }],
  } as unknown as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => {
      markBuildStarted();
      await buildGate;
      return staleState;
    },
    renderHtml: () => "<html></html>",
    handleCommand: async () => staleState,
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");

  try {
    const events = await fetch(`${chatUrl.origin}/events?token=${token}`);
    const stateRequest = fetch(`${chatUrl.origin}/state?token=${token}`);
    await buildStarted;
    const approvalEvent = readSsePayload(events, "approval_mode_changed");
    bridge.publishSessionApprovalMode(
      "s1",
      "everything",
      "2026-08-25T00:00:00.000Z",
    );
    const approval = await approvalEvent;
    releaseBuild();
    const state = await (await stateRequest).json() as ChatBridgeState;

    assert.equal(state.approvalMode, "manual");
    assert.equal(state.bridgeStateCoveredThroughRevision, "0");
    assert.ok(
      BigInt(approval.bridgeStateRevision as string) <
        BigInt(state.bridgeStateRevision),
    );
    assert.ok(
      BigInt(state.bridgeStateCoveredThroughRevision) <
        BigInt(approval.bridgeStateRevision as string),
    );
  } finally {
    releaseBuild();
    await bridge.close();
  }
});

test("event stream reconnect replays the latest approval patch per Session", async () => {
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  let initialEvents: Response | undefined;
  let reconnectedEvents: Response | undefined;

  try {
    initialEvents = await fetch(endpoint("/events"));
    const firstPatch = readSsePayload(initialEvents, "approval_mode_changed");
    bridge.publishSessionApprovalMode(
      "s1",
      "everything",
      "2026-08-25T00:00:00.000Z",
    );
    const first = await firstPatch;
    assert.equal(first.updatedAt, "2026-08-25T00:00:00.000Z");

    bridge.publishSessionApprovalMode(
      "s1",
      "manual",
      "2026-08-25T00:01:00.000Z",
    );
    reconnectedEvents = await fetch(endpoint("/events"));
    const replayed = await readSsePayload(
      reconnectedEvents,
      "approval_mode_changed",
    );

    assert.equal(replayed.sessionId, "s1");
    assert.equal(replayed.approvalMode, "manual");
    assert.equal(replayed.updatedAt, "2026-08-25T00:01:00.000Z");
    assert.ok(
      BigInt(replayed.bridgeStateRevision as string) >
        BigInt(first.bridgeStateRevision as string),
    );
  } finally {
    await initialEvents?.body?.cancel().catch(() => {});
    await reconnectedEvents?.body?.cancel().catch(() => {});
    await bridge.close();
  }
});

test("event stream publishes and replays the latest Session model selection", async () => {
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  let initialEvents: Response | undefined;
  let reconnectedEvents: Response | undefined;

  try {
    initialEvents = await fetch(endpoint("/events"));
    const firstPatch = readSsePayload(
      initialEvents,
      "session_model_selection_changed",
    );
    bridge.publishSessionModelSelection("s1", {
      profileId: "profile-a",
      model: "model-a",
      reasoningEffort: "high",
    }, "2026-08-25T00:00:00.000Z");
    const first = await firstPatch;
    assert.equal(first.updatedAt, "2026-08-25T00:00:00.000Z");
    assert.deepEqual(first.modelSelection, {
      profileId: "profile-a",
      model: "model-a",
      reasoningEffort: "high",
    });

    bridge.publishSessionModelSelection("s1", {
      profileId: "profile-a",
      model: "model-b",
    }, "2026-08-25T00:01:00.000Z");
    reconnectedEvents = await fetch(endpoint("/events"));
    const replayed = await readSsePayload(
      reconnectedEvents,
      "session_model_selection_changed",
    );

    assert.equal(replayed.sessionId, "s1");
    assert.equal(replayed.updatedAt, "2026-08-25T00:01:00.000Z");
    assert.deepEqual(replayed.modelSelection, {
      profileId: "profile-a",
      model: "model-b",
    });
    assert.ok(
      BigInt(replayed.bridgeStateRevision as string) >
        BigInt(first.bridgeStateRevision as string),
    );
  } finally {
    await initialEvents?.body?.cancel().catch(() => {});
    await reconnectedEvents?.body?.cancel().catch(() => {});
    await bridge.close();
  }
});

test("event stream publishes and replays the latest credential-free Profile change", async () => {
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  let initialEvents: Response | undefined;
  let reconnectedEvents: Response | undefined;

  try {
    initialEvents = await fetch(endpoint("/events"));
    const firstPatch = readSsePayload(initialEvents, "profile_settings_changed");
    bridge.publishProfileSettingsChange({ commandId: "profile-command-a" });
    const first = await firstPatch;
    assert.equal(first.commandId, "profile-command-a");
    assert.equal(Object.hasOwn(first, "profile"), false);

    bridge.publishProfileSettingsChange({ commandId: "profile-command-b" });
    reconnectedEvents = await fetch(endpoint("/events"));
    const replayed = await readSsePayload(
      reconnectedEvents,
      "profile_settings_changed",
    );
    assert.equal(replayed.commandId, "profile-command-b");
    assert.ok(
      BigInt(replayed.bridgeStateRevision as string) >
        BigInt(first.bridgeStateRevision as string),
    );
  } finally {
    await initialEvents?.body?.cancel().catch(() => {});
    await reconnectedEvents?.body?.cancel().catch(() => {});
    await bridge.close();
  }
});

test("the originating Profile command relies on its correlated state instead of self-refreshing", async () => {
  const state = {} as ChatDialogState;
  let bridge: Awaited<ReturnType<typeof createChatBridge>>;
  bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (_input, _signal, context) => {
      bridge.publishProfileSettingsChange({ commandId: context.commandId });
      return state;
    },
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const events = await fetch(endpoint("/events"));

  try {
    const nextPayload = readNextSsePayload(events);
    const response = await fetch(endpoint("/command"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "origin-profile-command",
      },
      body: JSON.stringify({ kind: "new_session" }),
    });
    assert.equal(response.status, 200);
    const payload = await nextPayload;
    assert.equal(payload.type, "state");
    assert.equal(payload.commandId, "origin-profile-command");
  } finally {
    await bridge.close();
  }
});

test("chat bridge reports commit-uncertain prompt persistence without downgrading a published user event", async () => {
  for (const userEventPublished of [false, true]) {
    const state = {} as ChatDialogState;
    const sendId = `commit-uncertain-${userEventPublished}`;
    const bridge = await createChatBridge({
      buildState: async () => state,
      renderHtml: () => "<html></html>",
      handleCommand: async () => state,
      handleSend: async (_input, stream) => {
        if (userEventPublished) {
          await stream.sessionEvent({
            id: "user-event",
            createdAt: "2026-08-03T00:00:00.000Z",
            kind: "user",
            content: "test",
          });
        }
        throw new ChatBridgePromptPersistenceUnknownError(
          "Prompt storage commit could not be confirmed.",
        );
      },
    });
    const chatUrl = new URL(bridge.url);
    const token = chatUrl.searchParams.get("token");

    try {
      const events = await fetch(`${chatUrl.origin}/events?token=${token}`);
      const response = await fetch(`${chatUrl.origin}/send?token=${token}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Live-Smith-Send-Id": sendId,
        },
        body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
      });
      const expected = userEventPublished ? "persisted" : "unknown";

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        error: "Prompt storage commit could not be confirmed.",
        promptPersistence: expected,
      });
      const errorEvent = await readSsePayload(events, "error");
      assert.equal(errorEvent.sendId, sendId);
      assert.equal(errorEvent.sessionId, "s1");
      assert.equal(errorEvent.promptPersistence, expected);
    } finally {
      await bridge.close();
    }
  }
});

test("chat bridge replays a pending confirmation to a newly connected event stream", async () => {
  let markConfirmationPending!: () => void;
  const confirmationPending = new Promise<void>((resolve) => {
    markConfirmationPending = resolve;
  });
  let markSecondConfirmationPending!: () => void;
  const secondConfirmationPending = new Promise<void>((resolve) => {
    markSecondConfirmationPending = resolve;
  });
  let confirmationResult: boolean | undefined;
  let secondConfirmationResult: boolean | undefined;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, stream) => {
      const result = stream.requestConfirmation({
        kind: "apply",
        message: "Apply one change?",
        groups: [{ title: "Song", rows: ["Set tempo to 124 BPM"] }],
      });
      markConfirmationPending();
      confirmationResult = await result;
      const secondResult = stream.requestConfirmation({
        kind: "resolve_recovery",
        message: "Keep completed changes and close the unfinished operation?",
        groups: [],
      });
      markSecondConfirmationPending();
      secondConfirmationResult = await secondResult;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const sendId = "send-confirmation-1";
  const send = fetch(endpoint("/send"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Live-Smith-Send-Id": sendId,
    },
    body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
  });

  try {
    await confirmationPending;
    const events = await fetch(endpoint("/events"));
    const payload = await readSsePayload(events, "confirm_request");
    assert.equal(payload.type, "confirm_request");
    assert.equal(payload.sendId, sendId);
    assert.equal(payload.sessionId, "s1");
    assert.equal(payload.kind, "apply");
    assert.equal(payload.message, "Apply one change?");
    assert.deepEqual(payload.groups, [
      { title: "Song", rows: ["Set tempo to 124 BPM"] },
    ]);
    assert.deepEqual(payload.activity, {
      status: "waiting_confirmation",
      message: "Waiting for confirmation",
    });
    assert.equal(typeof payload.id, "string");
    assert.equal(payload.confirmationGeneration, 1);

    const resolvedEvents = await fetch(endpoint("/events"));
    const resolvedPayload = readSsePayload(
      resolvedEvents,
      "confirm_resolved",
    );
    const confirmation = await fetch(endpoint("/confirm"), {
      method: "POST",
      headers: correlatedJsonHeaders(),
      body: JSON.stringify({ id: payload.id, apply: false }),
    });
    assert.equal(confirmation.status, 200);
    const confirmationBody = await confirmation.json() as Record<string, unknown>;
    assert.equal(
      confirmationBody.confirmationGeneration,
      payload.confirmationGeneration,
    );
    assert.deepEqual(
      withoutBridgeStateRevisions(await resolvedPayload),
      {
        type: "confirm_resolved",
        sendId,
        sessionId: "s1",
        id: payload.id,
        confirmationGeneration: payload.confirmationGeneration,
        activity: {
          status: "running",
          message: "Continuing after cancellation",
        },
      },
    );
    await secondConfirmationPending;
    const secondEvents = await fetch(endpoint("/events"));
    const secondPayload = await readSsePayload(secondEvents, "confirm_request");
    assert.notEqual(secondPayload.id, payload.id);
    assert.equal(secondPayload.confirmationGeneration, 2);
    assert.equal(secondPayload.kind, "resolve_recovery");
    assert.deepEqual(secondPayload.groups, []);
    const secondResolvedEvents = await fetch(endpoint("/events"));
    const secondResolvedPayload = readSsePayload(
      secondResolvedEvents,
      "confirm_resolved",
    );
    const secondConfirmation = await fetch(endpoint("/confirm"), {
      method: "POST",
      headers: correlatedJsonHeaders(),
      body: JSON.stringify({ id: secondPayload.id, apply: false }),
    });
    assert.equal(secondConfirmation.status, 200);
    const secondConfirmationBody = await secondConfirmation.json() as Record<
      string,
      unknown
    >;
    assert.equal(secondConfirmationBody.confirmationGeneration, 2);
    assert.deepEqual(secondConfirmationBody.activity, {
      status: "running",
      message: "Keeping unfinished operation active",
    });
    assert.deepEqual(
      withoutBridgeStateRevisions(await secondResolvedPayload),
      {
        type: "confirm_resolved",
        sendId,
        sessionId: "s1",
        id: secondPayload.id,
        confirmationGeneration: 2,
        activity: {
          status: "running",
          message: "Keeping unfinished operation active",
        },
      },
    );
    assert.equal((await send).status, 200);
    assert.equal(confirmationResult, false);
    assert.equal(secondConfirmationResult, false);
  } finally {
    await bridge.close();
  }
});

test("stop reports a non-terminal abort until the correlated send error completes", async () => {
  let releaseCleanup!: () => void;
  let markAborted!: () => void;
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, _stream, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          markAborted();
          resolve();
        }, { once: true });
      });
      await cleanupGate;
      throw signal.reason;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const events = await fetch(endpoint("/events"));
  const send = fetch(endpoint("/send"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Live-Smith-Send-Id": "send-stop-terminal-1",
    },
    body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
  });

  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const stop = await fetch(endpoint("/stop"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "send-stop-terminal-1",
      },
      body: "{}",
    });
    await aborted;
    assert.deepEqual(await stop.json(), {
      ok: true,
      terminal: false,
      sendId: "send-stop-terminal-1",
    });

    releaseCleanup();
    const errorEvent = await readSsePayload(events, "error");
    assert.equal(errorEvent.sendId, "send-stop-terminal-1");
    const sendResponse = await send;
    assert.equal(sendResponse.status, 500);

    const command = await fetch(endpoint("/command"), {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({ kind: "new_session" }),
    });
    assert.equal(command.status, 200);
  } finally {
    releaseCleanup();
    await bridge.close();
  }
});

test("stop tombstones a correlated send while its request body is still arriving", async () => {
  let sendCalls = 0;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {
      sendCalls += 1;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token")!;
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const sendId = "send-slow-body-stop";
  const body = JSON.stringify({ prompt: "slow", sessionId: "s1" });
  const splitAt = Math.floor(body.length / 2);
  const socket = connect(Number(chatUrl.port), "127.0.0.1");
  const responseChunks: NodeBuffer[] = [];
  socket.on("data", (chunk: NodeBuffer) => responseChunks.push(chunk));

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write([
      `POST /send?token=${token} HTTP/1.1`,
      `Host: 127.0.0.1:${chatUrl.port}`,
      "Content-Type: application/json",
      `X-Live-Smith-Send-Id: ${sendId}`,
      `Content-Length: ${NodeBuffer.byteLength(body)}`,
      "Connection: close",
      "",
      body.slice(0, splitAt),
    ].join("\r\n"));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    const firstStop = await fetch(endpoint("/stop"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": sendId,
      },
      body: "{}",
    });
    assert.deepEqual(await firstStop.json(), {
      ok: true,
      terminal: false,
      sendId,
    });

    const rawSendResponse = new Promise<string>((resolve, reject) => {
      socket.once("end", () => {
        resolve(NodeBuffer.concat(responseChunks).toString("utf8"));
      });
      socket.once("error", reject);
    });
    socket.end(body.slice(splitAt));
    const responseText = await rawSendResponse;
    assert.match(responseText, /^HTTP\/1\.1 409 /);
    assert.equal(sendCalls, 0);

    const terminalStop = await fetch(endpoint("/stop"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": sendId,
      },
      body: "{}",
    });
    assert.deepEqual(await terminalStop.json(), {
      ok: true,
      terminal: true,
      sendId,
      promptPersistence: "not_persisted",
    });
  } finally {
    socket.destroy();
    await bridge.close();
  }
});

test("stop fences late stream publications without hiding durable Session events", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let confirmationAfterStop: boolean | "pending" | undefined;
  const state = {
    activeSessionId: "s1",
    sessions: [{ id: "s1" }],
  } as unknown as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, stream, signal) => {
      markStarted();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await stream.assistantDelta("late delta");
      await stream.assistantReset();
      await stream.webSearchUpdate({
        id: "late-search",
        status: "searching",
        action: "search",
        queries: ["late"],
        sources: [],
      });
      await stream.sessionEvent({
        id: "late-durable-steering",
        createdAt: "2026-08-23T00:00:00.000Z",
        kind: "user",
        content: "Persisted before Stop completed",
        steeringReceipt: {
          sendId: "send-stop-publication-fence",
          id: "steer-stop-publication-fence",
          sha256: "a".repeat(64),
        },
      });
      await stream.progress("Late progress after Stop");
      confirmationAfterStop = await Promise.race([
        stream.requestConfirmation({
          kind: "apply",
          message: "Late confirmation after Stop?",
          groups: [{ title: "Song", rows: ["Set tempo"] }],
        }),
        new Promise<"pending">((resolve) => {
          setTimeout(() => resolve("pending"), 25);
        }),
      ]);
      throw signal.reason;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const events = await fetch(endpoint("/events"));
  const send = fetch(endpoint("/send"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Live-Smith-Send-Id": "send-stop-publication-fence",
    },
    body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
  });

  try {
    await started;
    const publications = readSsePayloadsThrough(events, "error");
    const stop = await fetch(endpoint("/stop"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "send-stop-publication-fence",
      },
      body: "{}",
    });
    assert.equal((await stop.json() as { terminal: boolean }).terminal, false);
    assert.equal((await send).status, 500);
    const payloads = await publications;

    assert.equal(confirmationAfterStop, false);
    assert.deepEqual(
      payloads.map((payload) => payload.type),
      ["session_event", "error"],
    );
    assert.deepEqual(payloads[0]?.activity, {
      status: "stopped",
      message: "Stopped",
    });
    const refreshed = await (await fetch(endpoint("/state"))).json() as ChatBridgeState;
    assert.deepEqual(refreshed.sessionActivities, [{
      sessionId: "s1",
      sendId: "send-stop-publication-fence",
      status: "stopped",
      message: "Stopped",
      unread: false,
    }]);
  } finally {
    await bridge.close();
  }
});

test("a delayed stop for an older send cannot abort the current send", async () => {
  let releaseSend!: () => void;
  let markStarted!: () => void;
  let currentSignal: AbortSignal | undefined;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, _stream, signal) => {
      currentSignal = signal;
      markStarted();
      await sendGate;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const send = fetch(endpoint("/send"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Live-Smith-Send-Id": "send-current-2",
    },
    body: JSON.stringify({ prompt: "current", sessionId: "s1" }),
  });

  try {
    await started;
    const stop = await fetch(endpoint("/stop"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "send-old-1",
      },
      body: "{}",
    });

    assert.deepEqual(await stop.json(), {
      ok: true,
      terminal: true,
      sendId: "send-old-1",
      promptPersistence: "unknown",
    });
    assert.equal(currentSignal?.aborted, false);
    releaseSend();
    assert.equal((await send).status, 200);
  } finally {
    releaseSend();
    await bridge.close();
  }
});

test("chat bridge serializes command mutations", async () => {
  let releaseCommand!: () => void;
  let markStarted!: () => void;
  const commandGate = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => {
      markStarted();
      await commandGate;
      return state;
    },
    handleSend: async () => {},
  });

  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const commandBody = JSON.stringify({ kind: "new_session" });
  const firstCommand = fetch(endpoint("/command"), {
    method: "POST",
    headers: correlatedJsonHeaders("command"),
    body: commandBody,
  });

  try {
    await started;
    const secondCommand = await fetch(endpoint("/command"), {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: commandBody,
    });
    const send = await fetch(endpoint("/send"), {
      method: "POST",
      headers: correlatedJsonHeaders("send"),
      body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
    });

    assert.equal(secondCommand.status, 409);
    assert.equal(send.status, 409);
  } finally {
    releaseCommand();
    await firstCommand;
    await bridge.close();
  }
});

test("state requested during an active command waits for the command terminal state", async () => {
  let releaseCommand!: () => void;
  let markStarted!: () => void;
  const commandGate = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  const commandStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let state = { status: "before" } as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => {
      markStarted();
      await commandGate;
      state = { status: "after" } as ChatDialogState;
      return state;
    },
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const command = fetch(endpoint("/command"), {
    method: "POST",
    headers: correlatedJsonHeaders("command"),
    body: JSON.stringify({ kind: "new_session" }),
  });
  let stateRequest: Promise<Response> | undefined;

  try {
    await commandStarted;
    let stateSettled = false;
    stateRequest = fetch(endpoint("/state")).then((response) => {
      stateSettled = true;
      return response;
    });
    const stateBeforeCommandTerminal = await Promise.race([
      stateRequest.then(() => "settled" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 100);
      }),
    ]);
    assert.equal(stateBeforeCommandTerminal, "pending");
    assert.equal(stateSettled, false);

    releaseCommand();
    assert.deepEqual(
      withoutBridgeStateRevisions(await (await stateRequest).json()),
      { status: "after" },
    );
    assert.deepEqual(
      withoutBridgeStateRevisions(await (await command).json()),
      { status: "after" },
    );
  } finally {
    releaseCommand();
    await command.catch(() => undefined);
    await stateRequest?.catch(() => undefined);
    await bridge.close();
  }
});

test("the command state fence starts before the command body finishes reading", async () => {
  let markCommandFinished!: () => void;
  const commandFinished = new Promise<void>((resolve) => {
    markCommandFinished = resolve;
  });
  let state = { status: "before" } as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => {
      state = { status: "after" } as ChatDialogState;
      markCommandFinished();
      return state;
    },
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const body = JSON.stringify({ kind: "new_session" });
  const socket = connect(Number(chatUrl.port), chatUrl.hostname);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write([
    `POST /command?token=${token} HTTP/1.1`,
    `Host: ${chatUrl.host}`,
    "Content-Type: application/json",
    "X-Live-Smith-Command-Id: partial-command-body",
    `Content-Length: ${NodeBuffer.byteLength(body)}`,
    "Connection: keep-alive",
    "",
    body.slice(0, 1),
  ].join("\r\n"));
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const stateRequest = fetch(`${chatUrl.origin}/state?token=${token}`);

  try {
    const stateBeforeBody = await Promise.race([
      stateRequest.then(() => "settled" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 100);
      }),
    ]);
    assert.equal(stateBeforeBody, "pending");

    socket.write(body.slice(1));
    await commandFinished;
    assert.deepEqual(
      withoutBridgeStateRevisions(await (await stateRequest).json()),
      { status: "after" },
    );
  } finally {
    socket.destroy();
    await bridge.close();
  }
});

test("the command state fence covers unknown-outcome reconciliation", async () => {
  let releaseReconciliation!: () => void;
  let markReconciliationStarted!: () => void;
  const reconciliationGate = new Promise<void>((resolve) => {
    releaseReconciliation = resolve;
  });
  const reconciliationStarted = new Promise<void>((resolve) => {
    markReconciliationStarted = resolve;
  });
  const state = { status: "reconciled" } as ChatDialogState;
  let buildCalls = 0;
  const bridge = await createChatBridge({
    buildState: async () => {
      buildCalls += 1;
      if (buildCalls === 1) {
        markReconciliationStarted();
        await reconciliationGate;
      }
      return state;
    },
    renderHtml: () => "<html></html>",
    handleCommand: async () => {
      throw new ChatBridgeCommandOutcomeUnknownError("Command outcome is unknown.");
    },
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const command = fetch(endpoint("/command"), {
    method: "POST",
    headers: correlatedJsonHeaders("command"),
    body: JSON.stringify({ kind: "new_session" }),
  });
  let stateRequest: Promise<Response> | undefined;

  try {
    await reconciliationStarted;
    stateRequest = fetch(endpoint("/state"));
    const stateBeforeReconciliation = await Promise.race([
      stateRequest.then(() => "settled" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 100);
      }),
    ]);
    assert.equal(stateBeforeReconciliation, "pending");

    releaseReconciliation();
    const commandResponse = await command;
    assert.equal(commandResponse.status, 500);
    assert.deepEqual(
      withoutBridgeStateRevisions(await (await stateRequest).json()),
      { status: "reconciled" },
    );
    assert.equal(buildCalls, 2);
  } finally {
    releaseReconciliation();
    await command.catch(() => undefined);
    await stateRequest?.catch(() => undefined);
    await bridge.close();
  }
});

test("a command unknown outcome uses its in-lease authoritative state without rebuilding", async () => {
  const authoritative = { status: "attached in lease" } as ChatDialogState;
  let buildCalls = 0;
  const bridge = await createChatBridge({
    buildState: async () => {
      buildCalls += 1;
      throw new Error("Post-lease state build must not run.");
    },
    renderHtml: () => "<html></html>",
    handleCommand: async () => {
      throw new ChatBridgeCommandOutcomeUnknownError(
        "Selected source outcome is unknown.",
        { authoritativeState: authoritative },
      );
    },
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  try {
    const response = await fetch(`${chatUrl.origin}/command?token=${token}`, {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({ kind: "new_session" }),
    });
    assert.equal(response.status, 500);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(typeof body.commandId, "string");
    delete body.commandId;
    assert.deepEqual(withoutBridgeStateRevisions(body), {
      error: "Selected source outcome is unknown.",
      commandOutcome: "unknown",
      state: authoritative,
    });
    assert.equal(buildCalls, 0);
  } finally {
    await bridge.close();
  }
});

test("chat bridge correlates command state with the request header without changing the body", async () => {
  const state = { status: "updated" } as ChatDialogState;
  let commandInput: unknown;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (input) => {
      commandInput = input;
      return state;
    },
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const events = await fetch(endpoint("/events"));

  try {
    const command = fetch(endpoint("/command"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "command-correlation-1",
      },
      body: JSON.stringify({ kind: "new_session" }),
    });
    const stateEvent = await readSsePayload(events, "state");
    const response = await command;

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("x-live-smith-command-id"),
      "command-correlation-1",
    );
    assert.equal(stateEvent.commandId, "command-correlation-1");
    assert.deepEqual(withoutBridgeStateRevisions(stateEvent.state), state);
    assert.deepEqual(commandInput, { kind: "new_session" });
  } finally {
    await bridge.close();
  }
});

test("chat bridge returns authoritative state when a command commit outcome is unknown", async () => {
  const state = { status: "authoritative" } as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => {
      throw new StorageCommitOutcomeUnknownError(new Error("directory sync failed"));
    },
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;

  try {
    const response = await fetch(endpoint("/command"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "command-unknown-1",
      },
      body: JSON.stringify({
        kind: "set_session_approval_mode",
        sessionId: "session-1",
        approvalMode: "everything",
      }),
    });

    assert.equal(response.status, 500);
    assert.deepEqual(withoutBridgeStateRevisions(await response.json()), {
      error: "Storage mutation completed, but its durable commit could not be confirmed.",
      commandId: "command-unknown-1",
      commandOutcome: "unknown",
      state,
    });
  } finally {
    await bridge.close();
  }
});

test("chat bridge marks an unknown command outcome as blocked when state reconciliation fails", async () => {
  const bridge = await createChatBridge({
    buildState: async () => {
      throw new Error("state unavailable");
    },
    renderHtml: () => "<html></html>",
    handleCommand: async () => {
      throw new StorageCommitOutcomeUnknownError(new Error("directory sync failed"));
    },
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");

  try {
    const response = await fetch(`${chatUrl.origin}/command?token=${token}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "command-unknown-2",
      },
      body: JSON.stringify({
        kind: "set_session_approval_mode",
        sessionId: "session-1",
        approvalMode: "manual",
      }),
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "Storage mutation completed, but its durable commit could not be confirmed.",
      commandId: "command-unknown-2",
      commandOutcome: "unknown",
      reconciliationRequired: true,
    });
  } finally {
    await bridge.close();
  }
});

test("closing the chat bridge aborts an active command", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let commandSignal: AbortSignal | undefined;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (_input, signal) => {
      commandSignal = signal;
      markStarted();
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return state;
    },
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const command = fetch(`${chatUrl.origin}/command?token=${token}`, {
    method: "POST",
    headers: correlatedJsonHeaders("command"),
    body: JSON.stringify({ kind: "new_session" }),
  });
  const events = await fetch(`${chatUrl.origin}/events?token=${token}`);

  await started;
  await bridge.close();
  assert.equal(commandSignal?.aborted, true);
  assert.equal((await command).status, 500);
  assert.equal(await events.text(), "\n");
});

test("closing the chat bridge aborts an active send with an event stream connected", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let sendSignal: AbortSignal | undefined;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, _stream, signal) => {
      sendSignal = signal;
      markStarted();
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const send = fetch(`${chatUrl.origin}/send?token=${token}`, {
    method: "POST",
    headers: correlatedJsonHeaders("send"),
    body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
  });
  const events = await fetch(`${chatUrl.origin}/events?token=${token}`);

  await started;
  await bridge.close();
  assert.equal(sendSignal?.aborted, true);
  assert.equal((await send).status, 500);
  assert.equal(await events.text(), "\n");
});

test("closing waits for an active handler to reach its terminal state", async () => {
  let markStarted!: () => void;
  let releaseSend!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {
      markStarted();
      await sendGate;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const send = fetch(`${chatUrl.origin}/send?token=${token}`, {
    method: "POST",
    headers: correlatedJsonHeaders("send"),
    body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
  });

  await started;
  let closeSettled = false;
  const closing = bridge.close().then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);

  releaseSend();
  await closing;
  await send.catch(() => undefined);
});

test("closing aborts and waits for read-only chat and state builds", {
  timeout: 2_000,
}, async () => {
  for (const path of ["/state", "/chat"]) {
    let finishState!: () => void;
    let markStarted!: () => void;
    let markAbortObserved!: () => void;
    const finishStateGate = new Promise<void>((resolve) => {
      finishState = resolve;
    });
    const stateStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const abortObserved = new Promise<void>((resolve) => {
      markAbortObserved = resolve;
    });
    const state = {} as ChatDialogState;
    const bridge = await createChatBridge({
      buildState: async (signal) => {
        markStarted();
        assert.ok(signal, `${path} must receive a bridge-owned AbortSignal.`);
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        markAbortObserved();
        await finishStateGate;
        throw signal.reason;
      },
      renderHtml: () => "<html></html>",
      handleCommand: async () => state,
      handleSend: async () => {},
    });
    const chatUrl = new URL(bridge.url);
    const token = chatUrl.searchParams.get("token");
    const readRequest = fetch(`${chatUrl.origin}${path}?token=${token}`).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    let closing: Promise<void> | undefined;

    try {
      await stateStarted;
      let closeSettled = false;
      closing = bridge.close().then(() => {
        closeSettled = true;
      });
      await abortObserved;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(closeSettled, false, `Bridge close did not wait for ${path}.`);

      finishState();
      await closing;
      const readResult = await readRequest;
      assert.ok("error" in readResult, `Expected ${path} connection to be destroyed.`);
    } finally {
      finishState();
      await readRequest;
      await (closing ?? bridge.close());
    }
  }
});

test("a confirmation requested after bridge shutdown starts resolves without deadlocking", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let confirmationResult: boolean | undefined;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, stream, signal) => {
      markStarted();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      confirmationResult = await stream.requestConfirmation({
        kind: "apply",
        message: "Late confirmation",
        groups: [{ title: "Song", rows: ["Set tempo"] }],
      });
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const send = fetch(`${chatUrl.origin}/send?token=${token}`, {
    method: "POST",
    headers: correlatedJsonHeaders("send"),
    body: JSON.stringify({ prompt: "test", sessionId: "s1" }),
  });

  await started;
  await Promise.race([
    bridge.close(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("Bridge close timed out.")), 1_000);
    }),
  ]);
  assert.equal(confirmationResult, false);
  assert.equal((await send).status, 200);
});

test("closing destroys partial command and send bodies before handlers can start", async () => {
  for (const path of ["/command", "/send"]) {
    let commandCalls = 0;
    let sendCalls = 0;
    const state = {} as ChatDialogState;
    const bridge = await createChatBridge({
      buildState: async () => state,
      renderHtml: () => "<html></html>",
      handleCommand: async () => {
        commandCalls += 1;
        return state;
      },
      handleSend: async () => {
        sendCalls += 1;
      },
    });
    const chatUrl = new URL(bridge.url);
    const token = chatUrl.searchParams.get("token");
    const socket = connect(Number(chatUrl.port), chatUrl.hostname);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write([
      `POST ${path}?token=${token} HTTP/1.1`,
      `Host: ${chatUrl.host}`,
      "Content-Type: application/json",
      path === "/command"
        ? "X-Live-Smith-Command-Id: partial-command-close"
        : "X-Live-Smith-Send-Id: partial-send-close",
      "Content-Length: 100",
      "Connection: keep-alive",
      "",
      "{",
    ].join("\r\n"));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    try {
      await Promise.race([
        bridge.close(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`Bridge close timed out for ${path}.`)), 1_000);
        }),
      ]);
      assert.equal(commandCalls, 0);
      assert.equal(sendCalls, 0);
    } finally {
      socket.destroy();
    }
  }
});

test("chat bridge rejects configuration and unknown fields on narrow request paths", async () => {
  const state = {} as ChatDialogState;
  let sendInput: unknown;
  let commandInput: unknown;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (input) => {
      commandInput = input;
      return state;
    },
    handleSend: async (input) => {
      sendInput = input;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;

  try {
    const send = await fetch(endpoint("/send"), {
      method: "POST",
      headers: correlatedJsonHeaders("send"),
      body: JSON.stringify({
        prompt: "test",
        sessionId: "s1",
        settings: { apiKey: "must-not-pass" },
      }),
    });
    assert.equal(send.status, 400);
    assert.match((await send.json() as { error: string }).error, /does not support property settings/i);
    assert.equal(sendInput, undefined);

    const command = await fetch(endpoint("/command"), {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({
        kind: "new_session",
        settings: { apiKey: "must-not-pass" },
      }),
    });
    assert.equal(command.status, 400);
    assert.match((await command.json() as { error: string }).error, /does not support property settings/i);
    assert.equal(commandInput, undefined);

    for (const kind of [
      "start_codex_login",
      "refresh_codex_account",
      "logout_codex",
    ]) {
      const authCommand = await fetch(endpoint("/command"), {
        method: "POST",
        headers: correlatedJsonHeaders("command"),
        body: JSON.stringify({ kind, accessToken: "must-not-pass" }),
      });
      assert.equal(authCommand.status, 400);
      assert.match(
        (await authCommand.json() as { error: string }).error,
        /does not support property accessToken/i,
      );
      assert.equal(commandInput, undefined);
    }

    for (const body of [
      { kind: "save_profile", profile: {} },
      {
        kind: "save_profile",
        profile: {},
        expectedProfileRevision: "stale",
      },
      {
        kind: "save_profile",
        profile: {},
        expectedProfileRevision: "A".repeat(64),
      },
    ]) {
      const profileCommand = await fetch(endpoint("/command"), {
        method: "POST",
        headers: correlatedJsonHeaders("command"),
        body: JSON.stringify(body),
      });
      assert.equal(profileCommand.status, 400);
      assert.match(
        (await profileCommand.json() as { error: string }).error,
        /expectedProfileRevision/i,
      );
      assert.equal(commandInput, undefined);
    }

    const restore = await fetch(endpoint("/command"), {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({
        kind: "restore_session",
        sessionId: "session-previous",
        projectKey: "must-not-pass",
        scope: { identity: "must-not-pass" },
        settings: { apiKey: "must-not-pass" },
      }),
    });
    assert.equal(restore.status, 400);
    assert.match((await restore.json() as { error: string }).error, /does not support property projectKey/i);
    assert.equal(commandInput, undefined);

    const archive = await fetch(endpoint("/command"), {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({
        kind: "archive_session",
        sessionId: "session-previous",
        projectKey: "must-not-pass",
      }),
    });
    assert.equal(archive.status, 400);
    assert.match(
      (await archive.json() as { error: string }).error,
      /does not support property projectKey/i,
    );
    assert.equal(commandInput, undefined);

  } finally {
    await bridge.close();
  }
});

test("Profile revision tokens keep large create and update commands below the body limit", async () => {
  const state = {} as ChatDialogState;
  const received: unknown[] = [];
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (input) => {
      received.push(input);
      return state;
    },
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = `${chatUrl.origin}/command?token=${token}`;
  const extraBodyValue = "x".repeat(600_000);
  const profile = {
    id: "large-profile",
    name: "Large Profile",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
    },
    defaultModel: "model-a",
    models: [{
      model: "model-a",
      parameters: {
        maxOutputTokens: 8192,
        reasoning: { mode: "default" },
      },
      advanced: { extraBody: { value: extraBodyValue } },
    }],
  };
  const payloads = [
    { kind: "save_profile", profile, expectedProfileRevision: null },
    {
      kind: "save_profile",
      profile: { ...profile, name: "Large Profile Updated" },
      expectedProfileRevision: "a".repeat(64),
    },
  ];

  try {
    for (const payload of payloads) {
      const body = JSON.stringify(payload);
      assert.ok(NodeBuffer.byteLength(body) < 1024 * 1024);
      assert.equal(body.split(extraBodyValue).length - 1, 1);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: correlatedJsonHeaders("command"),
        body,
      });
      assert.equal(response.status, 200, await response.text());
    }
    assert.equal(received.length, 2);
    for (const input of received as Array<Record<string, unknown>>) {
      assert.equal(Object.hasOwn(input, "expectedProfile"), false);
    }
  } finally {
    await bridge.close();
  }
});

test("Session approval commands require one Session and one valid mode", async () => {
  const state = {} as ChatDialogState;
  const received: unknown[] = [];
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (input) => {
      received.push(input);
      return state;
    },
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = `${chatUrl.origin}/command?token=${token}`;

  try {
    for (const approvalMode of ["manual", "low-risk", "everything"] as const) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: correlatedJsonHeaders("command"),
        body: JSON.stringify({
          kind: "set_session_approval_mode",
          sessionId: "session-1",
          approvalMode,
        }),
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(received, [
      { kind: "set_session_approval_mode", sessionId: "session-1", approvalMode: "manual" },
      { kind: "set_session_approval_mode", sessionId: "session-1", approvalMode: "low-risk" },
      { kind: "set_session_approval_mode", sessionId: "session-1", approvalMode: "everything" },
    ]);

    for (const body of [
      { kind: "set_session_approval_mode", sessionId: "session-1", approvalMode: "unsafe" },
      { kind: "set_session_approval_mode", approvalMode: "manual" },
      { kind: "set_session_approval_mode", sessionId: "session-1", autoApprove: true },
      { kind: "set_session_approval_mode", sessionId: "session-1", approvalMode: "manual", extra: true },
    ]) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: correlatedJsonHeaders("command"),
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(received.length, 3);
  } finally {
    await bridge.close();
  }
});

test("Session model selection commands accept only a bounded identity and effort", async () => {
  const state = {} as ChatDialogState;
  const received: unknown[] = [];
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (input) => {
      received.push(input);
      return state;
    },
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = `${chatUrl.origin}/command?token=${token}`;

  try {
    for (const reasoningEffort of [null, "low", "ultra"] as const) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: correlatedJsonHeaders("command"),
        body: JSON.stringify({
          kind: "set_session_model_selection",
          sessionId: "session-1",
          profileId: "profile-1",
          model: "model-a",
          reasoningEffort,
        }),
      });
      assert.equal(response.status, 200);
    }
    const loadResponse = await fetch(endpoint, {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({
        kind: "load_session_model_capabilities",
        sessionId: "session-1",
        profileId: "profile-1",
      }),
    });
    assert.equal(loadResponse.status, 200);
    assert.deepEqual(received, [
      {
        kind: "set_session_model_selection",
        sessionId: "session-1",
        profileId: "profile-1",
        model: "model-a",
        reasoningEffort: null,
      },
      {
        kind: "set_session_model_selection",
        sessionId: "session-1",
        profileId: "profile-1",
        model: "model-a",
        reasoningEffort: "low",
      },
      {
        kind: "set_session_model_selection",
        sessionId: "session-1",
        profileId: "profile-1",
        model: "model-a",
        reasoningEffort: "ultra",
      },
      {
        kind: "load_session_model_capabilities",
        sessionId: "session-1",
        profileId: "profile-1",
      },
    ]);

    for (const body of [
      {
        kind: "set_session_model_selection",
        sessionId: "session-1",
        profileId: "profile-1",
        model: "model-a",
        reasoningEffort: "extreme",
      },
      {
        kind: "set_session_model_selection",
        sessionId: "session-1",
        profileId: "profile-1",
        model: "model-a",
      },
      {
        kind: "set_session_model_selection",
        sessionId: "session-1",
        profileId: "profile-1",
        model: "model-a",
        reasoningEffort: null,
        parameters: {},
      },
    ]) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: correlatedJsonHeaders("command"),
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(received.length, 4);
  } finally {
    await bridge.close();
  }
});

test("credential-bearing bridge GET responses disable caching and referrers", async () => {
  const state = {
    settings: {
      profiles: [{ apiKey: "secret-provider-key" }],
    },
  } as unknown as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html>secret-provider-key</html>",
    handleCommand: async () => state,
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;

  try {
    for (const path of ["/chat", "/state", "/events"]) {
      const response = await fetch(endpoint(path));
      assert.equal(
        response.headers.get("cache-control"),
        "no-store, private, max-age=0",
      );
      assert.equal(response.headers.get("pragma"), "no-cache");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      if (path === "/events") await response.body?.cancel();
    }
  } finally {
    await bridge.close();
  }
});

test("chat bridge body parsing does not depend on an ambient Buffer constructor", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
  Object.defineProperty(globalThis, "Buffer", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  try {
    async function* requestChunks(): AsyncGenerator<Uint8Array> {
      yield NodeBuffer.from(JSON.stringify({ kind: "new_session" }));
    }
    assert.deepEqual(
      await readJsonBody(requestChunks()),
      { kind: "new_session" },
    );
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "Buffer", descriptor);
    else Reflect.deleteProperty(globalThis, "Buffer");
  }
});

test("chat bridge rejects request bodies larger than one MiB", async () => {
  async function* oversizedBody(): AsyncGenerator<Uint8Array> {
    yield NodeBuffer.alloc(1024 * 1024, 0x20);
    yield NodeBuffer.from("x");
  }

  await assert.rejects(
    readJsonBody(oversizedBody()),
    /request body exceeds 1048576 bytes/i,
  );
});

test("attachment upload and delete routes use bounded raw bodies and narrow inputs", async () => {
  const state = { status: "attachments-updated" } as ChatDialogState;
  let uploadInput: {
    sessionId: string;
    fileName: string;
    claimedMediaType?: string;
    bytes: Uint8Array;
  } | undefined;
  let deleteInput: { sessionId: string; attachmentId: string } | undefined;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {},
    preflightAttachmentUpload: async () => {},
    handleAttachmentUpload: async (input) => {
      uploadInput = input;
      return state;
    },
    handleAttachmentDelete: async (input) => {
      deleteInput = input;
      return state;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token")!;

  try {
    const upload = await fetch(
      `${chatUrl.origin}/attachments?token=${token}&sessionId=session-1&fileName=${encodeURIComponent("idea 中文.png")}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Live-Smith-File-Type": "image/png",
        },
        body: attachmentRequestBody(attachmentPng),
      },
    );
    assert.equal(upload.status, 201);
    assert.deepEqual(withoutBridgeStateRevisions(await upload.json()), state);
    assert.equal(uploadInput?.sessionId, "session-1");
    assert.equal(uploadInput?.fileName, "idea 中文.png");
    assert.equal(uploadInput?.claimedMediaType, "image/png");
    assert.deepEqual([...(uploadInput?.bytes ?? [])], [...attachmentPng]);

    const deletion = await fetch(
      `${chatUrl.origin}/attachments/attachment-1?token=${token}&sessionId=session-1`,
      { method: "DELETE" },
    );
    assert.equal(deletion.status, 200);
    assert.deepEqual(deleteInput, {
      sessionId: "session-1",
      attachmentId: "attachment-1",
    });

    const unauthorized = await fetch(
      `${chatUrl.origin}/attachments?sessionId=session-1&fileName=idea.png`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: attachmentRequestBody(attachmentPng),
      },
    );
    assert.equal(unauthorized.status, 403);
  } finally {
    await bridge.close();
  }
});

test("Skill install and delete routes use raw Markdown, receipts, and narrow inputs", async () => {
  const state = {} as ChatDialogState;
  const markdown = NodeBuffer.from(
    "---\nname: mix-review\ndescription: Review a mix\n---\nKeep the low end clear.\n",
  );
  const installs: Array<{ replace: boolean; bytes: Uint8Array }> = [];
  const deletes: string[] = [];
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => undefined,
    handleSkillInstall: async (input) => {
      installs.push({ replace: input.replace, bytes: Uint8Array.from(input.bytes) });
      return {
        state,
        receipt: { id: "mix-review", sha256: "a".repeat(64) },
      };
    },
    handleSkillDelete: async ({ skillId }) => {
      deletes.push(skillId);
      return state;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");

  try {
    const install = await fetch(
      `${chatUrl.origin}/skills?token=${token}&replace=true`,
      {
        method: "POST",
        headers: {
          "Content-Type": "Text/Markdown; Charset=UTF-8",
          "X-Live-Smith-Command-Id": "skill-install-1",
        },
        body: attachmentRequestBody(markdown),
      },
    );
    assert.equal(install.status, 201);
    assert.equal(
      install.headers.get("x-live-smith-command-id"),
      "skill-install-1",
    );
    assert.deepEqual(withoutBridgeStateRevisions(await install.json()), {
      state,
      receipt: { id: "mix-review", sha256: "a".repeat(64) },
    });
    assert.equal(installs.length, 1);
    assert.equal(installs[0]!.replace, true);
    assert.deepEqual(installs[0]!.bytes, new Uint8Array(markdown));

    const deletion = await fetch(
      `${chatUrl.origin}/skills/mix-review?token=${token}`,
      {
        method: "DELETE",
        headers: { "X-Live-Smith-Command-Id": "skill-delete-1" },
      },
    );
    assert.equal(deletion.status, 200);
    assert.deepEqual(deletes, ["mix-review"]);

    const rejected = await fetch(
      `${chatUrl.origin}/skills?token=${token}&replace=true&extra=1`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "X-Live-Smith-Command-Id": "skill-invalid-query",
        },
        body: attachmentRequestBody(markdown),
      },
    );
    assert.equal(rejected.status, 400);
    assert.equal(installs.length, 1);
  } finally {
    await bridge.close();
  }
});

test("Skill install early validation drains its body and does not broadcast an uncorrelated error", async () => {
  const state = {} as ChatDialogState;
  let handlerCalls = 0;
  let resumedSkillRequests = 0;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => undefined,
    handleSkillInstall: async () => {
      handlerCalls += 1;
      return {
        state,
        receipt: { id: "mix-review", sha256: "a".repeat(64) },
      };
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const events = await fetch(`${chatUrl.origin}/events?token=${token}`);
  const originalResume = IncomingMessage.prototype.resume;
  IncomingMessage.prototype.resume = function trackedResume() {
    if (this.url?.startsWith("/skills")) resumedSkillRequests += 1;
    return originalResume.call(this);
  };

  try {
    const unauthorizedResumesBefore = resumedSkillRequests;
    const unauthorized = await fetch(`${chatUrl.origin}/skills?token=wrong`, {
      method: "POST",
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
      body: attachmentRequestBody(NodeBuffer.from("invalid")),
    });
    assert.equal(unauthorized.status, 403);
    assert.ok(resumedSkillRequests > unauthorizedResumesBefore);

    const invalidCommandId = await fetch(
      `${chatUrl.origin}/skills?token=${token}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "X-Live-Smith-Command-Id": "x".repeat(129),
        },
        body: attachmentRequestBody(NodeBuffer.from("invalid")),
      },
    );
    assert.equal(invalidCommandId.status, 400);
    assert.ok(resumedSkillRequests >= 1);

    const nextEvent = readNextSsePayload(events);
    const valid = await fetch(`${chatUrl.origin}/skills?token=${token}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "X-Live-Smith-Command-Id": "valid-skill-command",
      },
      body: attachmentRequestBody(NodeBuffer.from("valid")),
    });
    assert.equal(valid.status, 201);
    assert.deepEqual(withoutBridgeStateRevisions(await nextEvent), {
      type: "state",
      commandId: "valid-skill-command",
      state,
    });
    const resumesAfterValidRequest = resumedSkillRequests;

    const invalidQuery = await fetch(
      `${chatUrl.origin}/skills?token=${token}&replace=maybe`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "X-Live-Smith-Command-Id": "invalid-skill-query",
        },
        body: attachmentRequestBody(NodeBuffer.from("invalid")),
      },
    );
    assert.equal(invalidQuery.status, 400);
    assert.ok(resumedSkillRequests > resumesAfterValidRequest);
    assert.equal(handlerCalls, 1);

    const bridgeWithoutSkillHandler = await createChatBridge({
      buildState: async () => state,
      renderHtml: () => "<html></html>",
      handleCommand: async () => state,
      handleSend: async () => undefined,
    });
    try {
      const unavailableUrl = new URL(bridgeWithoutSkillHandler.url);
      const resumesBeforeUnavailable = resumedSkillRequests;
      const unavailable = await fetch(
        `${unavailableUrl.origin}/skills?token=${unavailableUrl.searchParams.get("token")}`,
        {
          method: "POST",
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
          body: attachmentRequestBody(NodeBuffer.from("invalid")),
        },
      );
      assert.equal(unavailable.status, 404);
      assert.ok(resumedSkillRequests > resumesBeforeUnavailable);
    } finally {
      await bridgeWithoutSkillHandler.close();
    }
  } finally {
    IncomingMessage.prototype.resume = originalResume;
    await events.body?.cancel().catch(() => undefined);
    await bridge.close();
  }
});

test("attachment upload early exits drain unread raw bodies", async () => {
  const state = {} as ChatDialogState;
  let resumedAttachmentRequests = 0;
  const originalResume = IncomingMessage.prototype.resume;
  IncomingMessage.prototype.resume = function trackedResume() {
    if (this.url?.startsWith("/attachments")) resumedAttachmentRequests += 1;
    return originalResume.call(this);
  };

  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => undefined,
    preflightAttachmentUpload: async () => {},
    handleAttachmentUpload: async () => state,
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token")!;
  const endpoint = `${chatUrl.origin}/attachments?token=${token}&sessionId=session-1&fileName=idea.png`;

  try {
    const unauthorized = await fetch(endpoint.replace(`token=${token}`, "token=wrong"), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: attachmentRequestBody(attachmentPng),
    });
    assert.equal(unauthorized.status, 403);
    assert.ok(resumedAttachmentRequests > 0);

    const resumedAfterUnauthorized = resumedAttachmentRequests;
    const malformed = await fetch(
      `${chatUrl.origin}/attachments?token=${token}&sessionId=session-1`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: attachmentRequestBody(attachmentPng),
      },
    );
    assert.equal(malformed.status, 400);
    assert.ok(resumedAttachmentRequests > resumedAfterUnauthorized);

    const bridgeWithoutAttachmentHandler = await createChatBridge({
      buildState: async () => state,
      renderHtml: () => "<html></html>",
      handleCommand: async () => state,
      handleSend: async () => undefined,
    });
    try {
      const unavailableUrl = new URL(bridgeWithoutAttachmentHandler.url);
      const unavailable = await fetch(
        `${unavailableUrl.origin}/attachments?token=${unavailableUrl.searchParams.get("token")}` +
          "&sessionId=session-1&fileName=idea.png",
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: attachmentRequestBody(attachmentPng),
        },
      );
      assert.equal(unavailable.status, 404);
      assert.ok(resumedAttachmentRequests > resumedAfterUnauthorized + 1);
    } finally {
      await bridgeWithoutAttachmentHandler.close();
    }
  } finally {
    IncomingMessage.prototype.resume = originalResume;
    await bridge.close();
  }
});

test("Skill raw bodies enforce exact media type and the 64 KiB boundary", async () => {
  for (const [contentType, size, expectedStatus] of [
    ["text/plain; charset=utf-8", 1, 400],
    ["text/markdown", 1, 400],
    ["text/markdown; charset=utf-8", MAX_SKILL_FILE_BYTES, 201],
    ["text/markdown; charset=utf-8", MAX_SKILL_FILE_BYTES + 1, 413],
  ] as const) {
    let handlerCalls = 0;
    const state = {} as ChatDialogState;
    const bridge = await createChatBridge({
      buildState: async () => state,
      renderHtml: () => "<html></html>",
      handleCommand: async () => state,
      handleSend: async () => undefined,
      handleSkillInstall: async () => {
        handlerCalls += 1;
        return {
          state,
          receipt: { id: "bounded", sha256: "b".repeat(64) },
        };
      },
    });
    const chatUrl = new URL(bridge.url);
    try {
      const response = await fetch(
        `${chatUrl.origin}/skills?token=${chatUrl.searchParams.get("token")}`,
        {
          method: "POST",
          headers: {
            "Content-Type": contentType,
            "X-Live-Smith-Command-Id": `skill-media-${size}`,
          },
          body: attachmentRequestBody(NodeBuffer.alloc(size, 0x61)),
        },
      );
      assert.equal(response.status, expectedStatus);
      assert.equal(handlerCalls, expectedStatus === 201 ? 1 : 0);
    } finally {
      await bridge.close();
    }
  }
});

test("attachment upload preflight rejects before reading or allocating its body", async () => {
  const state = {} as ChatDialogState;
  let preflightInput: { sessionId: string } | undefined;
  let handlerCalls = 0;
  const allocations: number[] = [];
  let resumedRequests = 0;
  let resumeObservedBeforeErrorSerialization = false;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {},
    preflightAttachmentUpload: async (input) => {
      preflightInput = input;
      const error = new ChatBridgeResourceNotFoundError(
        "That Session is unavailable.",
      );
      Object.defineProperty(error, "message", {
        configurable: true,
        get: () => {
          resumeObservedBeforeErrorSerialization = resumedRequests > 0;
          return "That Session is unavailable.";
        },
      });
      throw error;
    },
    handleAttachmentUpload: async () => {
      handlerCalls += 1;
      return state;
    },
    attachmentBodyReadOptions: {
      allocateBuffer: (byteLength) => {
        allocations.push(byteLength);
        return NodeBuffer.allocUnsafe(byteLength);
      },
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token")!;
  const originalResume = IncomingMessage.prototype.resume;
  IncomingMessage.prototype.resume = function trackedResume() {
    resumedRequests += 1;
    return originalResume.call(this);
  };

  try {
    const response = await fetch(
      `${chatUrl.origin}/attachments?token=${token}` +
        "&sessionId=missing-session&fileName=idea.png",
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: attachmentRequestBody(attachmentPng),
      },
    );
    assert.equal(response.status, 404);
    assert.deepEqual(preflightInput, { sessionId: "missing-session" });
    assert.equal(handlerCalls, 0);
    assert.deepEqual(allocations, []);
    assert.equal(resumedRequests, 1);
    assert.equal(resumeObservedBeforeErrorSerialization, true);
  } finally {
    IncomingMessage.prototype.resume = originalResume;
    await bridge.close();
  }
});

test("attachment body concurrency is shared across bridge instances", async () => {
  const state = {} as ChatDialogState;
  const bodyReadStarted: Array<Promise<void>> = [];
  const markBodyReadStarted: Array<() => void> = [];
  for (let index = 0; index < 2; index += 1) {
    bodyReadStarted.push(new Promise<void>((resolve) => {
      markBodyReadStarted.push(resolve);
    }));
  }
  let thirdAllocations = 0;
  let handlerCalls = 0;
  const bridgeForIndex = (index: number) => createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {},
    preflightAttachmentUpload: async () => {},
    handleAttachmentUpload: async () => {
      handlerCalls += 1;
      return state;
    },
    attachmentBodyReadOptions: {
      timeoutMs: 1_000,
      allocateBuffer: (byteLength) => {
        if (index < 2) markBodyReadStarted[index]?.();
        else thirdAllocations += 1;
        return NodeBuffer.allocUnsafe(byteLength);
      },
    },
  });
  const bridges = await Promise.all([0, 1, 2].map(bridgeForIndex));
  const sockets: ReturnType<typeof connect>[] = [];

  try {
    for (let index = 0; index < 2; index += 1) {
      const chatUrl = new URL(bridges[index]!.url);
      const token = chatUrl.searchParams.get("token")!;
      const socket = connect(Number(chatUrl.port), chatUrl.hostname);
      sockets.push(socket);
      socket.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write([
        `POST /attachments?token=${token}&sessionId=session-${index}&fileName=held.png HTTP/1.1`,
        `Host: ${chatUrl.host}`,
        "Content-Type: application/octet-stream",
        "Content-Length: 100",
        "Connection: keep-alive",
        "",
        "",
      ].join("\r\n"));
      await bodyReadStarted[index];
    }

    const thirdUrl = new URL(bridges[2]!.url);
    const thirdToken = thirdUrl.searchParams.get("token")!;
    const thirdEndpoint =
      `${thirdUrl.origin}/attachments?token=${thirdToken}` +
      "&sessionId=session-third&fileName=third.png";
    const rejected = await fetch(thirdEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: attachmentRequestBody(attachmentPng),
    });
    assert.equal(rejected.status, 409);
    assert.match(
      (await rejected.json() as { error: string }).error,
      /too many attachment uploads/i,
    );
    assert.equal(thirdAllocations, 0);
    assert.equal(handlerCalls, 0);

    await Promise.all([bridges[0]!.close(), bridges[1]!.close()]);
    const accepted = await fetch(thirdEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: attachmentRequestBody(attachmentPng),
    });
    assert.equal(accepted.status, 201);
    assert.equal(thirdAllocations, 1);
    assert.equal(handlerCalls, 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all(bridges.map((bridge) => bridge.close()));
  }
});

test("attachment body timeout returns a safe HTTP response and releases the bridge", async () => {
  const state = {} as ChatDialogState;
  let handlerCalls = 0;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {},
    preflightAttachmentUpload: async () => {},
    handleAttachmentUpload: async () => {
      handlerCalls += 1;
      return state;
    },
    attachmentBodyReadOptions: { timeoutMs: 5 },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token")!;
  const socket = connect(Number(chatUrl.port), chatUrl.hostname);
  const chunks: NodeBuffer[] = [];
  socket.on("data", (chunk: NodeBuffer) => chunks.push(chunk));

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write([
      `POST /attachments?token=${token}&sessionId=session-timeout&fileName=slow.png HTTP/1.1`,
      `Host: ${chatUrl.host}`,
      "Content-Type: application/octet-stream",
      "Content-Length: 100",
      "Connection: close",
      "",
      "x",
    ].join("\r\n"));
    await new Promise<void>((resolve, reject) => {
      socket.once("end", resolve);
      socket.once("error", reject);
    });
    const response = NodeBuffer.concat(chunks).toString("utf8");
    assert.match(response, /^HTTP\/1\.1 408 /);
    assert.match(response, /timed out before the complete body was received/i);
    assert.doesNotMatch(response, /Users|Bearer|secret/i);
    assert.equal(handlerCalls, 0);

    const accepted = await fetch(
      `${chatUrl.origin}/attachments?token=${token}` +
        "&sessionId=session-timeout&fileName=after-timeout.png",
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: attachmentRequestBody(attachmentPng),
      },
    );
    assert.equal(accepted.status, 201);
    assert.equal(handlerCalls, 1);
  } finally {
    socket.destroy();
    await bridge.close();
  }
});

test("attachment routes reject malformed, duplicate, oversized, and empty inputs", async () => {
  let handlerCalls = 0;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {},
    preflightAttachmentUpload: async () => {},
    handleAttachmentUpload: async () => {
      handlerCalls += 1;
      return state;
    },
    handleAttachmentDelete: async () => {
      handlerCalls += 1;
      return state;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token")!;
  const upload = async (query: string, body: Uint8Array, contentType = "application/octet-stream") =>
    fetch(`${chatUrl.origin}/attachments?token=${token}&${query}`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: attachmentRequestBody(body),
    });

  try {
    const responses = [
      await upload("fileName=missing-session.png", attachmentPng),
      await upload("sessionId=session-1&fileName=a.png&fileName=b.png", attachmentPng),
      await upload(
        `sessionId=session-1&fileName=${"a".repeat(161)}`,
        attachmentPng,
      ),
      await upload("sessionId=session-1&fileName=empty.png", new Uint8Array()),
      await upload("sessionId=session-1&fileName=wrong.png", attachmentPng, "image/png"),
      await fetch(
        `${chatUrl.origin}/attachments/attachment-1?token=${token}`,
        { method: "DELETE" },
      ),
      await fetch(
        `${chatUrl.origin}/attachments/attachment-1?token=${token}&sessionId=session-1&extra=x`,
        { method: "DELETE" },
      ),
    ];
    assert.deepEqual(responses.map((response) => response.status), [400, 400, 400, 400, 400, 400, 400]);

    const tooLarge = await upload(
      "sessionId=session-1&fileName=large.png",
      new Uint8Array(MAX_DOCUMENT_ATTACHMENT_BYTES + 1),
    );
    assert.equal(tooLarge.status, 413);
    assert.equal(handlerCalls, 0);
  } finally {
    await bridge.close();
  }
});

test("attachment routes preserve typed safe 400, 404, 409, and 413 errors", async () => {
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {},
    preflightAttachmentUpload: async () => {},
    handleAttachmentUpload: async (input) => {
      if (input.fileName === "invalid.png") {
        throw new ChatBridgeAttachmentValidationError("Only valid images are supported.");
      }
      if (input.fileName === "missing.png") {
        throw new ChatBridgeResourceNotFoundError("That Session is unavailable.");
      }
      if (input.fileName === "quota.png") {
        throw new ChatBridgePayloadTooLargeError("Pending image quota exceeded.");
      }
      return state;
    },
    handleAttachmentDelete: async () => {
      throw new ChatBridgeConflictError("Referenced images cannot be removed.");
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token")!;
  const post = (fileName: string) => fetch(
    `${chatUrl.origin}/attachments?token=${token}&sessionId=session-1&fileName=${fileName}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: attachmentRequestBody(attachmentPng),
    },
  );

  try {
    for (const [fileName, status] of [
      ["invalid.png", 400],
      ["missing.png", 404],
      ["quota.png", 413],
    ] as const) {
      const response = await post(fileName);
      assert.equal(response.status, status);
      assert.doesNotMatch(await response.text(), /secret|\/Users\//);
    }
    const conflict = await fetch(
      `${chatUrl.origin}/attachments/attachment-1?token=${token}&sessionId=session-1`,
      { method: "DELETE" },
    );
    assert.equal(conflict.status, 409);
  } finally {
    await bridge.close();
  }
});

test("attachment routes never expose unclassified filesystem or credential-bearing errors", async () => {
  const state = {} as ChatDialogState;
  const sensitiveCause =
    "EACCES /Users/private/.live-smith Authorization: Bearer provider-secret";
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {},
    preflightAttachmentUpload: async () => {},
    handleAttachmentUpload: async () => {
      throw new Error(sensitiveCause);
    },
    handleAttachmentDelete: async () => {
      throw new Error(sensitiveCause);
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token")!;

  try {
    const upload = await fetch(
      `${chatUrl.origin}/attachments?token=${token}` +
        "&sessionId=session-1&fileName=private.png",
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: attachmentRequestBody(attachmentPng),
      },
    );
    const deletion = await fetch(
      `${chatUrl.origin}/attachments/attachment-1?token=${token}&sessionId=session-1`,
      { method: "DELETE" },
    );

    for (const response of [upload, deletion]) {
      assert.equal(response.status, 500);
      const body = await response.text();
      assert.match(body, /attachment operation could not be completed/i);
      assert.doesNotMatch(body, /Users|Authorization|Bearer|provider-secret|EACCES/);
    }
  } finally {
    await bridge.close();
  }
});

test("attachment operations conflict only with the same Session's active mutation", async () => {
  let releaseSend!: () => void;
  let markStarted!: () => void;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (input) => {
      if (input.sessionId === "session-1") {
        markStarted();
        await sendGate;
      }
    },
    preflightAttachmentUpload: async () => {},
    handleAttachmentUpload: async () => state,
    handleAttachmentDelete: async () => state,
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token")!;
  const send = fetch(`${chatUrl.origin}/send?token=${token}`, {
    method: "POST",
    headers: correlatedJsonHeaders("send"),
    body: JSON.stringify({ prompt: "test", sessionId: "session-1" }),
  });

  try {
    await started;
    const sameSession = await fetch(
      `${chatUrl.origin}/attachments?token=${token}&sessionId=session-1&fileName=same.png`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: attachmentRequestBody(attachmentPng),
      },
    );
    const otherSession = await fetch(
      `${chatUrl.origin}/attachments?token=${token}&sessionId=session-2&fileName=other.png`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: attachmentRequestBody(attachmentPng),
      },
    );
    assert.equal(sameSession.status, 409);
    assert.equal(otherSession.status, 201);
  } finally {
    releaseSend();
    await send;
    await bridge.close();
  }
});

test("different-Session attachment failures stay on their initiating HTTP response", async () => {
  let releaseFailure!: () => void;
  let markFailureStarted!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  const failureStarted = new Promise<void>((resolve) => {
    markFailureStarted = resolve;
  });
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, stream) => {
      await stream.progress("correlated probe");
      return state;
    },
    preflightAttachmentUpload: async () => {},
    handleAttachmentUpload: async (input) => {
      if (input.sessionId === "session-failure") {
        markFailureStarted();
        await failureGate;
        throw new Error("attachment failure");
      }
      return state;
    },
    handleAttachmentDelete: async () => state,
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token")!;
  const events = await fetch(`${chatUrl.origin}/events?token=${token}`);
  const upload = (sessionId: string, fileName: string) => fetch(
    `${chatUrl.origin}/attachments?token=${token}` +
      `&sessionId=${sessionId}&fileName=${fileName}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: attachmentRequestBody(attachmentPng),
    },
  );

  try {
    const failedUpload = upload("session-failure", "failure.png");
    await failureStarted;
    const successfulUpload = upload("session-success", "success.png");
    releaseFailure();
    assert.deepEqual(
      await Promise.all([failedUpload, successfulUpload]).then((responses) =>
        responses.map((response) => response.status)
      ),
      [500, 201],
    );

    const send = await fetch(`${chatUrl.origin}/send?token=${token}`, {
      method: "POST",
      headers: correlatedJsonHeaders("send"),
      body: JSON.stringify({ prompt: "probe", sessionId: "session-success" }),
    });
    assert.equal(send.status, 200);
    const firstPayload = await readNextSsePayload(events);
    assert.equal(firstPayload.type, "progress");
    assert.equal(firstPayload.sessionId, "session-success");
    assert.equal(firstPayload.message, "correlated probe");
  } finally {
    releaseFailure();
    await bridge.close();
  }
});

test("attachment post-commit state failures reconcile as unknown outcomes", async () => {
  const authoritative = { status: "attachment-present" } as ChatDialogState;
  let builds = 0;
  const bridge = await createChatBridge({
    buildState: async () => {
      builds += 1;
      return authoritative;
    },
    renderHtml: () => "<html></html>",
    handleCommand: async () => authoritative,
    handleSend: async () => {},
    preflightAttachmentUpload: async () => {},
    handleAttachmentUpload: async () => {
      throw new ChatBridgeCommandOutcomeUnknownError(
        "Attachment changed, but state could not be confirmed.",
      );
    },
    handleAttachmentDelete: async () => authoritative,
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token")!;

  try {
    const response = await fetch(
      `${chatUrl.origin}/attachments?token=${token}&sessionId=session-1&fileName=idea.png`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: attachmentRequestBody(attachmentPng),
      },
    );
    assert.equal(response.status, 500);
    assert.deepEqual(withoutBridgeStateRevisions(await response.json()), {
      error: "Attachment changed, but state could not be confirmed.",
      commandOutcome: "unknown",
      state: authoritative,
    });
    assert.equal(builds, 1);
  } finally {
    await bridge.close();
  }
});

test("raw attachment reader allocates declared lengths exactly and validates them", async () => {
  const allocations: number[] = [];
  const exact = Object.assign(new PassThrough(), {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": "4",
    },
  });
  const exactRead = readRawAttachmentBody(exact as never, {
    allocateBuffer: (byteLength) => {
      allocations.push(byteLength);
      return NodeBuffer.allocUnsafe(byteLength);
    },
  });
  exact.write(new Uint8Array([1, 2]));
  exact.end(new Uint8Array([3, 4]));
  const exactBytes = await exactRead;
  assert.equal(NodeBuffer.isBuffer(exactBytes), true);
  assert.deepEqual([...exactBytes], [1, 2, 3, 4]);
  assert.deepEqual(allocations, [4]);

  const mismatch = Object.assign(new PassThrough(), {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": "4",
    },
  });
  const mismatchRead = readRawAttachmentBody(mismatch as never);
  mismatch.end(new Uint8Array([1, 2, 3]));
  await assert.rejects(mismatchRead, /Content-Length does not match/);

  const overflow = Object.assign(new PassThrough(), {
    headers: { "content-type": "application/octet-stream" },
  });
  const overflowRead = readRawAttachmentBody(overflow as never);
  overflow.end(new Uint8Array(MAX_DOCUMENT_ATTACHMENT_BYTES + 1));
  await assert.rejects(
    overflowRead,
    (error: unknown) => {
      assert.ok(error instanceof ChatBridgePayloadTooLargeError);
      assert.equal(
        error.message,
        `Attachment uploads may not exceed ${MAX_DOCUMENT_ATTACHMENT_BYTES} bytes.`,
      );
      assert.equal("cause" in error, false);
      return true;
    },
  );
});

test("raw attachment reader drains header failures before acquiring a permit", () => {
  for (const headers of [
    { "content-type": "image/png", "content-length": "4" },
    { "content-type": "application/octet-stream", "content-length": "invalid" },
  ]) {
    const request = Object.assign(new PassThrough(), { headers });
    const requestResume = request.resume.bind(request);
    let bodyDrained = false;
    request.resume = () => {
      bodyDrained = true;
      return requestResume();
    };

    assert.throws(() => readRawAttachmentBody(request as never));
    assert.equal(bodyDrained, true);
  }
});

test("unknown-length attachment bodies grow from a small bounded buffer", async () => {
  const allocations: number[] = [];
  const request = Object.assign(new PassThrough(), {
    headers: { "content-type": "application/octet-stream" },
  });
  const read = readRawAttachmentBody(request as never, {
    allocateBuffer: (byteLength) => {
      allocations.push(byteLength);
      return NodeBuffer.allocUnsafe(byteLength);
    },
  });
  request.write(new Uint8Array([1]));
  request.end(new Uint8Array(70 * 1024));

  const bytes = await read;
  assert.equal(bytes.byteLength, 70 * 1024 + 1);
  assert.deepEqual(allocations, [64 * 1024, 128 * 1024]);
  assert.equal(allocations.includes(MAX_DOCUMENT_ATTACHMENT_BYTES), false);
});

test("raw attachment reads enforce a process-wide cap and release permits", async () => {
  const heldRequests = [0, 1].map(() => Object.assign(new PassThrough(), {
    headers: { "content-type": "application/octet-stream" },
  }));
  const heldReads = heldRequests.map((request) =>
    readRawAttachmentBody(request as never, { timeoutMs: 1_000 })
  );
  const rejected = Object.assign(new PassThrough(), {
    headers: { "content-type": "application/octet-stream" },
  });
  const rejectedResume = rejected.resume.bind(rejected);
  let rejectedBodyDrained = false;
  rejected.resume = () => {
    rejectedBodyDrained = true;
    return rejectedResume();
  };

  assert.throws(
    () => readRawAttachmentBody(rejected as never),
    (error: unknown) => {
      assert.ok(error instanceof ChatBridgeConflictError);
      assert.match(error.message, /too many attachment uploads/i);
      return true;
    },
  );
  assert.equal(rejectedBodyDrained, true);

  for (const request of heldRequests) request.destroy();
  await Promise.all(heldReads.map((read) => assert.rejects(read, /complete body/i)));

  const afterRelease = Object.assign(new PassThrough(), {
    headers: { "content-type": "application/octet-stream" },
  });
  const afterReleaseRead = readRawAttachmentBody(afterRelease as never);
  afterRelease.end(new Uint8Array([1]));
  assert.deepEqual([...(await afterReleaseRead)], [1]);
});

test("raw attachment allocation failure drains the request and releases its permit", async () => {
  const request = Object.assign(new PassThrough(), {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": "4",
    },
  });
  const requestResume = request.resume.bind(request);
  let bodyDrained = false;
  request.resume = () => {
    bodyDrained = true;
    return requestResume();
  };

  assert.throws(
    () => readRawAttachmentBody(request as never, {
      allocateBuffer: () => {
        throw new Error("private allocator failure");
      },
    }),
    /could not be buffered/i,
  );
  assert.equal(bodyDrained, true);

  const afterFailure = Object.assign(new PassThrough(), {
    headers: { "content-type": "application/octet-stream" },
  });
  const read = readRawAttachmentBody(afterFailure as never);
  afterFailure.end(new Uint8Array([1]));
  assert.deepEqual([...(await read)], [1]);
});

test("raw attachment read timeout is fixed, safe, and releases its permit", async () => {
  const stalled = Object.assign(new PassThrough(), {
    headers: { "content-type": "application/octet-stream" },
  });
  await assert.rejects(
    readRawAttachmentBody(stalled as never, { timeoutMs: 5 }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "Attachment upload timed out before the complete body was received.",
      );
      assert.doesNotMatch(error.message, /Users|Bearer|secret/i);
      return true;
    },
  );
  stalled.destroy();

  const afterTimeout = Object.assign(new PassThrough(), {
    headers: { "content-type": "application/octet-stream" },
  });
  const read = readRawAttachmentBody(afterTimeout as never);
  afterTimeout.end(new Uint8Array([1]));
  assert.deepEqual([...(await read)], [1]);
});

test("raw attachment reader accepts exactly 20 MiB and rejects one byte over", async () => {
  const exact = Object.assign(new PassThrough(), {
    headers: { "content-type": "application/octet-stream" },
  });
  const exactRead = readRawAttachmentBody(exact as never);
  exact.end(new Uint8Array(MAX_DOCUMENT_ATTACHMENT_BYTES));
  const exactBytes = await exactRead;
  assert.equal(exactBytes.byteLength, MAX_DOCUMENT_ATTACHMENT_BYTES);
  assert.equal(NodeBuffer.isBuffer(exactBytes), true);

  const over = Object.assign(new PassThrough(), {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(MAX_DOCUMENT_ATTACHMENT_BYTES + 1),
    },
  });
  assert.throws(
    () => readRawAttachmentBody(over as never),
    (error: unknown) => {
      assert.ok(error instanceof ChatBridgePayloadTooLargeError);
      assert.equal("cause" in error, false);
      return true;
    },
  );
});

test("raw Skill reader is bounded, exact-length, cancellable, and releases permits", async () => {
  const exact = Object.assign(new PassThrough(), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-length": String(MAX_SKILL_FILE_BYTES),
    },
  });
  const exactRead = readRawSkillBody(exact as never);
  exact.end(new Uint8Array(MAX_SKILL_FILE_BYTES));
  assert.equal((await exactRead).byteLength, MAX_SKILL_FILE_BYTES);

  const over = Object.assign(new PassThrough(), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-length": String(MAX_SKILL_FILE_BYTES + 1),
    },
  });
  assert.throws(
    () => readRawSkillBody(over as never),
    ChatBridgePayloadTooLargeError,
  );

  const stalled = Object.assign(new PassThrough(), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
  await assert.rejects(
    readRawSkillBody(stalled as never, { timeoutMs: 5 }),
    /Skill upload timed out/i,
  );
  stalled.destroy();

  const afterTimeout = Object.assign(new PassThrough(), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
  const afterRead = readRawSkillBody(afterTimeout as never);
  afterTimeout.end(new Uint8Array([1]));
  assert.deepEqual([...(await afterRead)], [1]);
});

test("attachment protocol tokens use locale-independent ASCII case folding", async () => {
  const request = Object.assign(new PassThrough(), {
    headers: {
      "content-type": "APPLICATION/OCTET-STREAM",
      "content-length": "4",
    },
    rawHeaders: [
      "CoNtEnT-TyPe",
      "APPLICATION/OCTET-STREAM",
      "CoNtEnT-LeNgTh",
      "4",
    ],
  });
  const originalToLocaleLowerCase = String.prototype.toLocaleLowerCase;
  let read: Promise<Uint8Array>;
  String.prototype.toLocaleLowerCase = function localeSensitiveCaseFoldMustNotRun() {
    throw new Error("Protocol parsing must not use locale-sensitive case folding.");
  };
  try {
    read = readRawAttachmentBody(request as never);
  } finally {
    String.prototype.toLocaleLowerCase = originalToLocaleLowerCase;
  }
  request.end(new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual([...(await read)], [1, 2, 3, 4]);
});

test("raw HTTP accepts one case-insensitive MIME token and rejects ambiguous attachment headers", async () => {
  let handlerCalls = 0;
  let claimedMediaType: string | undefined;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {},
    preflightAttachmentUpload: async () => {},
    handleAttachmentUpload: async (input) => {
      handlerCalls += 1;
      claimedMediaType = input.claimedMediaType;
      return state;
    },
    handleAttachmentDelete: async () => state,
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token")!;
  const baseHeaders = [
    `Host: 127.0.0.1:${chatUrl.port}`,
    `Content-Length: ${attachmentPng.byteLength}`,
    "Connection: close",
  ];
  const requestPath =
    `/attachments?token=${token}&sessionId=session-1&fileName=duplicate.png`;

  try {
    const duplicateContentType = await rawHttpStatus(
      Number(chatUrl.port),
      requestPath,
      [
        ...baseHeaders,
        "Content-Type: application/octet-stream",
        "Content-Type: application/octet-stream",
      ],
      attachmentPng,
    );
    const duplicateClaimedType = await rawHttpStatus(
      Number(chatUrl.port),
      requestPath,
      [
        ...baseHeaders,
        "Content-Type: application/octet-stream",
        "X-Live-Smith-File-Type: image/png",
        "X-Live-Smith-File-Type: image/png",
      ],
      attachmentPng,
    );
    const duplicateContentLength = await rawHttpStatus(
      Number(chatUrl.port),
      requestPath,
      [
        `Host: 127.0.0.1:${chatUrl.port}`,
        `Content-Length: ${attachmentPng.byteLength}`,
        `Content-Length: ${attachmentPng.byteLength}`,
        "Content-Type: application/octet-stream",
        "Connection: close",
      ],
      attachmentPng,
    );
    const mergedClaimedType = await rawHttpStatus(
      Number(chatUrl.port),
      requestPath,
      [
        ...baseHeaders,
        "Content-Type: application/octet-stream",
        "X-Live-Smith-File-Type: image/png, image/jpeg",
      ],
      attachmentPng,
    );
    const controlledClaimedType = await rawHttpStatus(
      Number(chatUrl.port),
      requestPath,
      [
        ...baseHeaders,
        "Content-Type: application/octet-stream",
        "X-Live-Smith-File-Type: image/png\u0001",
      ],
      attachmentPng,
    );
    const mixedCaseClaimedType = await rawHttpStatus(
      Number(chatUrl.port),
      requestPath,
      [
        ...baseHeaders,
        "Content-Type: application/octet-stream",
        "x-LiVe-SmItH-FiLe-TyPe: ImAgE/PnG",
      ],
      attachmentPng,
    );

    assert.deepEqual(
      [
        duplicateContentType,
        duplicateClaimedType,
        duplicateContentLength,
        mergedClaimedType,
        controlledClaimedType,
        mixedCaseClaimedType,
      ],
      [400, 400, 400, 400, 400, 201],
    );
    assert.equal(handlerCalls, 1);
    assert.equal(claimedMediaType, "image/png");
  } finally {
    await bridge.close();
  }
});

test("an attachment upload closed early never reaches the mutation handler", async () => {
  let handlerCalls = 0;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {},
    preflightAttachmentUpload: async () => {},
    handleAttachmentUpload: async () => {
      handlerCalls += 1;
      return state;
    },
    handleAttachmentDelete: async () => state,
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token")!;
  const socket = connect(Number(chatUrl.port), "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write([
    `POST /attachments?token=${token}&sessionId=session-1&fileName=partial.png HTTP/1.1`,
    `Host: 127.0.0.1:${chatUrl.port}`,
    "Content-Type: application/octet-stream",
    "Content-Length: 100",
    "Connection: close",
    "",
    "partial",
  ].join("\r\n"));
  socket.destroy();

  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(handlerCalls, 0);
  await bridge.close();
});

test("chat bridge preserves Profile validation fields in safe command errors", async () => {
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => {
      throw new ProfileValidationError("baseUrl", "Base URL is invalid.");
    },
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");

  try {
    const command = await fetch(`${chatUrl.origin}/command?token=${token}`, {
      method: "POST",
      headers: correlatedJsonHeaders("command"),
      body: JSON.stringify({ kind: "new_session" }),
    });

    assert.equal(command.status, 400);
    const body = await command.json() as Record<string, unknown>;
    assert.equal(body.error, "Base URL is invalid.");
    assert.equal(body.field, "baseUrl");
    assert.equal(typeof body.commandId, "string");
  } finally {
    await bridge.close();
  }
});

function withoutBridgeStateRevisions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBridgeStateRevisions);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      key === "bridgeStateRevision" ||
          key === "bridgeStateCoveredThroughRevision"
        ? []
        : [[key, withoutBridgeStateRevisions(entry)]]
    ),
  );
}

async function readSsePayload(
  response: Response,
  type: string,
): Promise<Record<string, unknown>> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  let received = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Event stream ended before ${type}.`);
      received += NodeBuffer.from(chunk.value).toString("utf8");
      for (const block of received.split("\n\n")) {
        const data = block.split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (!data) continue;
        const payload = JSON.parse(data) as Record<string, unknown>;
        if (payload.type === type) return payload;
      }
    }
  } finally {
    await reader.cancel();
  }
}

async function readNextSsePayload(
  response: Response,
): Promise<Record<string, unknown>> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  let received = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Event stream ended before a payload arrived.");
      received += NodeBuffer.from(chunk.value).toString("utf8");
      for (const block of received.split("\n\n")) {
        const data = block.split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (data) return JSON.parse(data) as Record<string, unknown>;
      }
    }
  } finally {
    await reader.cancel();
  }
}

async function readSsePayloadsThrough(
  response: Response,
  terminalType: string,
): Promise<Record<string, unknown>[]> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const payloads: Record<string, unknown>[] = [];
  let received = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error(`Event stream ended before ${terminalType}.`);
      }
      received += NodeBuffer.from(chunk.value).toString("utf8");
      for (;;) {
        const boundary = received.indexOf("\n\n");
        if (boundary < 0) break;
        const block = received.slice(0, boundary);
        received = received.slice(boundary + 2);
        const data = block.split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (!data) continue;
        const payload = JSON.parse(data) as Record<string, unknown>;
        payloads.push(payload);
        if (payload.type === terminalType) return payloads;
      }
    }
  } finally {
    await reader.cancel();
  }
}

async function rawHttpStatus(
  port: number,
  requestPath: string,
  headers: string[],
  body: Uint8Array,
): Promise<number> {
  const socket = connect(port, "127.0.0.1");
  const chunks: NodeBuffer[] = [];
  socket.on("data", (chunk: NodeBuffer) => chunks.push(chunk));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write([
    `POST ${requestPath} HTTP/1.1`,
    ...headers,
    "",
    "",
  ].join("\r\n"));
  socket.end(NodeBuffer.from(body));
  await new Promise<void>((resolve, reject) => {
    socket.once("end", resolve);
    socket.once("error", reject);
  });
  const statusLine = NodeBuffer.concat(chunks).toString("utf8").split("\r\n", 1)[0];
  const match = /^HTTP\/1\.1 (\d{3}) /.exec(statusLine ?? "");
  assert.ok(match, `Expected an HTTP response, received ${JSON.stringify(statusLine)}.`);
  return Number(match[1]);
}
