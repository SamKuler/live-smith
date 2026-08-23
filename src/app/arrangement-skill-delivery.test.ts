import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { RuntimeProfile } from "../model/provider.js";
import { installSkill } from "../storage/skills.js";
import { buildModelRequest } from "./model-request.js";
import { resolveSkillContext } from "./skill-context.js";

const examplesDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../examples/skills",
);
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

test("arrangement Skill bodies reach only trusted system instructions", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-arrangement-delivery-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const skillId of skillIds) {
    await installSkill(
      directory,
      await fs.readFile(path.join(examplesDirectory, skillId, "SKILL.md")),
    );
  }

  const prompt = `Keep this exact prompt, including $${skillIds[0]}.`;
  const skillContext = await resolveSkillContext({
    storageDirectory: directory,
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
    storageDirectory: directory,
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
