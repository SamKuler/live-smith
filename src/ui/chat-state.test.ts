import assert from "node:assert/strict";
import test from "node:test";

import {
  chatDialogStateForWire,
  chatSessionEvent,
  chatRuntimeSummary,
  serializeChatStateForHtml,
  type ChatDialogState,
} from "./chat-state.js";

test("chatSessionEvent keeps storage hashes behind the UI projection", () => {
  const projected = chatSessionEvent({
    id: "event-1",
    createdAt: "2026-08-23T00:00:00.000Z",
    kind: "user",
    content: "Leave more headroom",
    steeringReceipt: {
      sendId: "send-1",
      id: "steer-1",
      sha256: "a".repeat(64),
    },
  });

  assert.deepEqual(projected, {
    id: "event-1",
    createdAt: "2026-08-23T00:00:00.000Z",
    kind: "user",
    content: "Leave more headroom",
    steeringAck: { sendId: "send-1", steerId: "steer-1" },
  });
  assert.doesNotMatch(JSON.stringify(projected), /sha256|steeringReceipt/);
});

test("chatSessionEvent projects legacy attachment paths as safe display names", () => {
  const projected = chatSessionEvent({
    id: "event-legacy-path",
    createdAt: "2026-08-23T00:00:00.000Z",
    kind: "user",
    content: "Legacy attachment",
    attachments: [{
      id: "attachment-legacy-path",
      kind: "audio",
      fileName: "/Users/alice/Clients/\u202e\u0000secret\u0007 project.wav",
      mediaType: "audio/wav",
      byteLength: 1,
      sha256: "a".repeat(64),
    }],
  });

  assert.equal(projected.attachments?.[0]?.fileName, "secret project.wav");
  assert.doesNotMatch(
    JSON.stringify(projected),
    /Users|Clients|[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u,
  );
});

test("chatDialogStateForWire safely projects pending legacy attachment names", () => {
  const state = {
    events: [],
    pendingAttachments: [{
      id: "attachment-legacy-pending",
      kind: "image",
      fileName: "\u202e\u0085e\u0301.png",
      mediaType: "image/png",
      byteLength: 1,
      sha256: "b".repeat(64),
    }],
  } as unknown as ChatDialogState;

  const projected = chatDialogStateForWire(state);

  assert.equal(projected.pendingAttachments[0]?.fileName, "é.png");
  assert.equal(state.pendingAttachments[0]?.fileName, "\u202e\u0085e\u0301.png");
});

test("chatRuntimeSummary keeps Runtime display aligned without credentials", () => {
  const capabilities = {
    tools: true,
    streaming: true,
    temperature: "supported" as const,
    reasoning: {
      supported: false,
      canDisable: false,
      efforts: [],
      budgetTokens: false,
      strategy: "none" as const,
    },
    inputs: { image: false, audio: false, pdf: false },
  };
  const summary = chatRuntimeSummary({
    profile: {
      id: "p1",
      name: "Runtime",
      connection: {
        kind: "direct-api",
        apiFamily: "openai",
        apiMode: "responses",
        baseUrl: "https://example.test/v1",
        apiKey: "secret-key",
      },
      model: "runtime-model",
      parameters: { maxOutputTokens: 1024, reasoning: { mode: "default" } },
      advanced: { extraBody: { secret: true } },
    },
    capabilities,
    inputCapabilityEvidence: {
      image: "supported",
      audio: "unverified",
      pdf: "unsupported",
    },
  });

  assert.deepEqual(summary, {
    profile: {
      id: "p1",
      name: "Runtime",
      connectionKind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      model: "runtime-model",
    },
    capabilities,
    inputCapabilityEvidence: {
      image: "supported",
      audio: "unverified",
      pdf: "unsupported",
    },
  });
  assert.equal("apiKey" in summary.profile, false);
  assert.equal("advanced" in summary.profile, false);
});

test("serializeChatStateForHtml escapes script-breaking characters", () => {
  const serialized = serializeChatStateForHtml({
    bridgeStateRevision: "1",
    bridgeStateCoveredThroughRevision: "0",
    contextSummary: "<script>&\u2028\u2029",
    sessionContinueTarget: { kind: "track", label: "Bass" },
    sessions: [],
    previousSessions: [],
    archivedSessions: [],
    activeSessionId: "",
    approvalMode: "manual",
    events: [],
    pendingAttachments: [],
    availableSkills: [],
    activeSkillIds: [],
    capabilities: {
      tools: true,
      streaming: false,
      temperature: "unsupported",
      reasoning: {
        supported: false,
        canDisable: false,
        efforts: [],
        budgetTokens: false,
        strategy: "none",
      },
      inputs: { image: false, audio: false, pdf: false },
    },
    availableModels: [],
    modelStateSource: null,
    runtimeProfile: null,
    settings: {
      schemaVersion: 4,
      activeProfileId: null,
      approvalMode: "manual",
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "0",
      profiles: [],
    },
    openSettingsOnLoad: false,
  });

  assert.match(serialized, /\\u003Cscript\\u003E/);
  assert.match(serialized, /\\u0026/);
  assert.match(serialized, /\\u2028/);
  assert.match(serialized, /\\u2029/);
  assert.doesNotMatch(serialized, /[<>&\u2028\u2029]/);
});

test("managed auth state and subscription connections expose no credential-shaped keys", () => {
  const managedSurface = {
    codexAuth: {
      status: "pending",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    },
    connection: {
      kind: "codex-subscription",
      provider: "openai",
    },
  };
  const keys: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      keys.push(key);
      visit(entry);
    }
  };

  visit(managedSurface);

  assert.deepEqual(
    keys.filter((key) => /access|refresh|token|credentialPath/i.test(key)),
    [],
  );
});
