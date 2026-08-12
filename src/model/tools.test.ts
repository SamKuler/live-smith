import assert from "node:assert/strict";
import test from "node:test";

import type { SavedProfile } from "./profile.js";
import {
  HOSTED_WEB_SEARCH_REQUEST_MAX_USES,
  modelToolsForProfile,
} from "./tools.js";

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
    {
      type: "hosted_web_search",
      maxUses: HOSTED_WEB_SEARCH_REQUEST_MAX_USES,
    },
  ]);
  assert.deepEqual(modelToolsForProfile(profile(true), [clientTool], 2), [
    clientTool,
    { type: "hosted_web_search", maxUses: 2 },
  ]);
  assert.deepEqual(modelToolsForProfile(profile(true), [clientTool], 0), [
    clientTool,
  ]);
  for (const invalid of [-1, 1.5, HOSTED_WEB_SEARCH_REQUEST_MAX_USES + 1]) {
    assert.throws(
      () => modelToolsForProfile(profile(true), [clientTool], invalid),
      /request limit is invalid/,
    );
  }
});
