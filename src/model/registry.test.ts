import assert from "node:assert/strict";
import test from "node:test";

import type { SavedProfile } from "./profile.js";
import { transportForProfile } from "./registry.js";

function profile(
  apiFamily: SavedProfile["apiFamily"],
  apiMode: SavedProfile["apiMode"],
): SavedProfile {
  return {
    id: `${apiFamily}-${apiMode}`,
    name: `${apiFamily}-${apiMode}`,
    apiFamily,
    apiMode,
    baseUrl: "https://example.test",
    apiKey: "key",
    model: "model",
    parameters: { maxOutputTokens: 4096, reasoning: { mode: "default" } },
    advanced: {},
  };
}

test("transportForProfile selects the three valid protocol transports", () => {
  assert.equal(transportForProfile(profile("openai", "responses")).apiMode, "responses");
  assert.equal(
    transportForProfile(profile("openai", "chat-completions")).apiMode,
    "chat-completions",
  );
  assert.equal(transportForProfile(profile("anthropic", "messages")).apiMode, "messages");
});

test("transportForProfile rejects invalid family and mode combinations", () => {
  assert.throws(
    () => transportForProfile(profile("anthropic", "responses")),
    /Unsupported API family\/mode combination/,
  );
});
