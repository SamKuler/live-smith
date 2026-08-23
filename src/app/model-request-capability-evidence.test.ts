import assert from "node:assert/strict";
import test from "node:test";

import type { DiscoveredModelInfo } from "../model/provider.js";
import type {
  DraftModelConfig,
  DraftProfile,
} from "../model/profile.js";
import {
  capabilityPreviewForProfile,
  resolveDiscoveredModels,
} from "./model-request.js";

type ProfileOverrides = Partial<Omit<DraftProfile, "defaultModel" | "models">> &
  Partial<DraftModelConfig>;

function profile(overrides: ProfileOverrides = {}): DraftProfile {
  const {
    model = "typed-model",
    parameters = {
      maxOutputTokens: 4096,
      reasoning: { mode: "default" },
    },
    advanced = {},
    ...profileOverrides
  } = overrides;
  return {
    id: "profile-evidence",
    name: "Evidence",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "https://example.test/v1",
      apiKey: "key",
    },
    defaultModel: model,
    models: [{ model, parameters, advanced }],
    ...profileOverrides,
  };
}

test("preview keeps a typed non-catalog model unverified", () => {
  const preview = capabilityPreviewForProfile(profile(), [{
    id: "different-model",
    displayName: "Different",
    capabilities: { inputs: { image: true } },
  }]);

  assert.deepEqual(preview.capabilities.inputs, {
    image: false,
    audio: false,
    pdf: false,
  });
  assert.deepEqual(preview.capabilityEvidence, {
    temperature: "unverified",
    maxOutputTokens: "unverified",
    contextWindowTokens: "unverified",
    reasoning: "unverified",
    inputs: {
      image: "unverified",
      audio: "unverified",
      pdf: "unverified",
    },
  });
});

test("each discovered model carries evidence for explicit and missing hints", () => {
  const models: DiscoveredModelInfo[] = [
    {
      id: "explicit-model",
      displayName: "Explicit",
      capabilities: {
        temperature: "unsupported",
        maxOutputTokens: 32_000,
        contextWindowTokens: 200_000,
        reasoning: { supported: true },
        inputs: { image: true, audio: false },
      },
    },
    {
      id: "missing-model",
      displayName: "Missing",
      capabilities: {},
    },
  ];

  const [explicit, missing] = resolveDiscoveredModels(profile(), models);
  assert.deepEqual(explicit?.capabilityEvidence, {
    temperature: "unsupported",
    maxOutputTokens: "verified",
    contextWindowTokens: "verified",
    reasoning: "supported",
    inputs: {
      image: "supported",
      audio: "unsupported",
      pdf: "unverified",
    },
  });
  assert.deepEqual(missing?.capabilityEvidence, {
    temperature: "unverified",
    maxOutputTokens: "unverified",
    contextWindowTokens: "unverified",
    reasoning: "unverified",
    inputs: {
      image: "unverified",
      audio: "unverified",
      pdf: "unverified",
    },
  });
});

test("preview projection leaves manual overrides for the Draft form to apply last", () => {
  const overridden = profile({
    model: "explicit-model",
    advanced: {
      capabilityOverrides: {
        temperature: "supported",
        maxOutputTokens: 64_000,
        reasoning: { supported: false },
        inputs: { image: false },
      },
    },
  });
  const models: DiscoveredModelInfo[] = [{
    id: "explicit-model",
    displayName: "Explicit",
    capabilities: {
      temperature: "unsupported",
      maxOutputTokens: 32_000,
      reasoning: { supported: true },
      inputs: { image: true },
    },
  }];

  const preview = capabilityPreviewForProfile(overridden, models);
  assert.equal(preview.capabilities.temperature, "unsupported");
  assert.equal(preview.capabilities.maxOutputTokens, 32_000);
  assert.equal(preview.capabilities.reasoning.supported, true);
  assert.equal(preview.capabilities.inputs.image, true);
  assert.deepEqual(preview.capabilityEvidence, {
    temperature: "unsupported",
    maxOutputTokens: "verified",
    contextWindowTokens: "unverified",
    reasoning: "supported",
    inputs: {
      image: "supported",
      audio: "unverified",
      pdf: "unverified",
    },
  });
});
