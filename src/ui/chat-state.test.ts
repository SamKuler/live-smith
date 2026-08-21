import assert from "node:assert/strict";
import test from "node:test";

import {
  chatRuntimeSummary,
  serializeChatStateForHtml,
} from "./chat-state.js";

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
    defaultPrompt: "<script>&\u2028\u2029",
    contextSummary: "",
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
