import assert from "node:assert/strict";
import test from "node:test";

import type { DirectApiConnection, SavedProfile } from "./profile.js";
import { transportForProfile } from "./registry.js";

function profile(connection: DirectApiConnection): SavedProfile {
  return {
    id: `${connection.apiFamily}-${connection.apiMode}`,
    name: `${connection.apiFamily}-${connection.apiMode}`,
    connection,
    defaultModel: "model",
    models: [{
      model: "model",
      parameters: { maxOutputTokens: 4096, reasoning: { mode: "default" } },
      advanced: {},
    }],
  };
}

test("transportForProfile selects the three valid protocol transports", () => {
  assert.equal(transportForProfile(profile({
    kind: "direct-api",
    apiFamily: "openai",
    apiMode: "responses",
    baseUrl: "https://example.test",
    apiKey: "key",
  })).apiMode, "responses");
  assert.equal(
    transportForProfile(profile({
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "chat-completions",
      baseUrl: "https://example.test",
      apiKey: "key",
    })).apiMode,
    "chat-completions",
  );
  assert.equal(transportForProfile(profile({
    kind: "direct-api",
    apiFamily: "anthropic",
    apiMode: "messages",
    baseUrl: "https://example.test",
    apiKey: "key",
  })).apiMode, "messages");
});

test("transportForProfile rejects invalid family and mode combinations", () => {
  const invalid = {
    ...profile({
      kind: "direct-api",
      apiFamily: "anthropic",
      apiMode: "messages",
      baseUrl: "https://example.test",
      apiKey: "key",
    }),
    connection: {
      kind: "direct-api",
      apiFamily: "anthropic",
      apiMode: "responses",
      baseUrl: "https://example.test",
      apiKey: "key",
    },
  } as unknown as SavedProfile;
  assert.throws(
    () => transportForProfile(invalid),
    /Unsupported API family\/mode combination/,
  );
});
