import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeProfile } from "../model/provider.js";
import { buildModelRequest } from "./model-request.js";
import { resolveSkillContext } from "./skill-context.js";

const skillIds = [
  "arranging-section-energy",
  "developing-musical-variation",
  "organizing-instrument-roles",
] as const;

const runtimeProfile: RuntimeProfile = {
  profile: {
    id: "offline-test",
    name: "Offline test",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
    },
  },
  model: {
    model: "model-a",
    parameters: {
      maxOutputTokens: 4096,
      reasoning: { mode: "default" },
    },
    advanced: {},
  },
  capabilities: {
    tools: true,
    streaming: true,
    temperature: "supported",
    reasoning: {
      supported: false,
      canDisable: false,
      efforts: [],
      budgetTokens: false,
      strategy: "none",
    },
    inputs: { image: false, audio: false, pdf: false },
  },
  inputCapabilityEvidence: {
    image: "unverified",
    audio: "unverified",
    pdf: "unverified",
  },
};

test("built-in arrangement Skill bodies reach only trusted system instructions", async () => {
  const prompt = `Keep this exact prompt, including $${skillIds[0]}.`;
  const skillContext = await resolveSkillContext({
    storageDirectory: undefined,
    sessionSkillIds: [...skillIds],
    prompt,
  });
  const history = [{
    role: "user" as const,
    content: [{ type: "text" as const, text: "Earlier request" }],
  }];
  const request = buildModelRequest({
    prompt,
    liveContext: "Observed Arrangement state",
    history,
    skillContext,
    agentMessages: [],
    runtimeProfile,
    tools: [],
  });

  assert.deepEqual(skillContext.activeSkillIds, [...skillIds].sort());
  for (const skillId of skillIds) {
    assert.match(request.systemInstructions, new RegExp(`<skill id="${skillId}">`));
  }
  const currentText = request.currentUserContent.find(
    (part) => part.type === "text",
  );
  assert.ok(currentText?.type === "text");
  assert.match(currentText.text, new RegExp(prompt.replace("$", "\\$")));
  const untrustedRequestData = JSON.stringify({
    currentUserContent: request.currentUserContent,
    history: request.history,
    agentMessages: request.agentMessages,
    tools: request.tools,
  });
  assert.doesNotMatch(untrustedRequestData, /Least-Change Ladder/u);
  assert.doesNotMatch(untrustedRequestData, /Variation Ladder/u);
  assert.deepEqual(request.history, history);

  const disabled = await resolveSkillContext({
    storageDirectory: undefined,
    sessionSkillIds: [],
    prompt: "No Skill mention here.",
  });
  const disabledRequest = buildModelRequest({
    prompt: "No Skill mention here.",
    liveContext: "Observed Arrangement state",
    history: [],
    skillContext: disabled,
    agentMessages: [],
    runtimeProfile,
    tools: [],
  });
  assert.doesNotMatch(disabledRequest.systemInstructions, /<skill id=/u);
});
