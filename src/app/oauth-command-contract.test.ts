import assert from "node:assert/strict";
import test from "node:test";

import { parseCommandInput } from "./chat-bridge-http.js";

test("OAuth commands require one explicit supported provider", () => {
  for (const kind of [
    "start_oauth_login",
    "refresh_oauth_account",
    "logout_oauth",
  ] as const) {
    assert.throws(
      () => parseCommandInput({ kind }),
      /provider must be openai, anthropic, or google/i,
    );
    for (const provider of ["openai", "anthropic", "google"] as const) {
      assert.deepEqual(parseCommandInput({ kind, provider }), { kind, provider });
    }
    assert.throws(
      () => parseCommandInput({ kind, provider: "other" }),
      /provider must be openai, anthropic, or google/i,
    );
    assert.throws(
      () => parseCommandInput({ kind, apiKey: "forbidden" }),
      /does not support property apiKey/i,
    );
  }
});
