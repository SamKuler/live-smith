import assert from "node:assert/strict";
import test from "node:test";

import type { SavedProfile } from "./profile.js";
import { HOSTED_WEB_SEARCH_MAX_USES, modelToolsForProfile } from "./tools.js";

function profile(enabled: boolean): SavedProfile {
  return {
    id: "profile",
    name: "Profile",
    apiFamily: "openai",
    apiMode: "responses",
    baseUrl: "https://example.test/v1",
    apiKey: "secret",
    model: "model",
    parameters: { maxOutputTokens: 4096, reasoning: { mode: "default" } },
    advanced: enabled ? { hostedTools: { webSearch: true } } : {},
  };
}

test("model tools append hosted Web Search only for an opted-in Profile", () => {
  const clientTool = {
    type: "function" as const,
    function: { name: "inspect", description: "Inspect" },
  };
  assert.deepEqual(modelToolsForProfile(profile(false), [clientTool]), [clientTool]);
  assert.deepEqual(modelToolsForProfile(profile(true), [clientTool]), [
    clientTool,
    { type: "hosted_web_search", maxUses: HOSTED_WEB_SEARCH_MAX_USES },
  ]);
});
