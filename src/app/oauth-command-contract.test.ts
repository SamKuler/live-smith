import assert from "node:assert/strict";
import test from "node:test";

import { parseCommandInput } from "./chat-bridge-http.js";

test("OAuth commands require one explicit Profile and supported provider", () => {
  const profileId = "profile-oauth";
  for (const kind of [
    "start_oauth_login",
    "refresh_oauth_account",
    "open_oauth_authorization",
    "logout_oauth",
  ] as const) {
    assert.throws(
      () => parseCommandInput({ kind }),
      /profileId must be a valid Profile ID/i,
    );
    assert.throws(
      () => parseCommandInput({ kind, profileId }),
      /provider must be openai, anthropic, or google/i,
    );
    for (const provider of ["openai", "anthropic", "google"] as const) {
      assert.deepEqual(
        parseCommandInput({ kind, profileId, provider }),
        { kind, profileId, provider },
      );
    }
    assert.throws(
      () => parseCommandInput({ kind, profileId, provider: "other" }),
      /provider must be openai, anthropic, or google/i,
    );
    for (const extra of [
      { apiKey: "forbidden" },
      { verificationUrl: "https://example.test/forbidden" },
    ]) {
      assert.throws(
        () => parseCommandInput({
          kind,
          profileId,
          provider: "openai",
          ...extra,
        }),
        /does not support property/i,
      );
    }
  }
});

test("discard_profile_oauth accepts only one exact Profile ID", () => {
  const input = {
    kind: "discard_profile_oauth" as const,
    profileId: "profile-oauth",
  };
  assert.deepEqual(parseCommandInput(input), input);
  assert.throws(
    () => parseCommandInput({ kind: input.kind }),
    /profileId must be a string/i,
  );
  assert.throws(
    () => parseCommandInput({ ...input, profileId: "bad profile" }),
    /profileId must be a valid Profile ID/i,
  );
  for (const extra of [
    { provider: "google" },
    { apiKey: "forbidden" },
    { accessToken: "forbidden" },
  ]) {
    assert.throws(
      () => parseCommandInput({ ...input, ...extra }),
      /does not support property/i,
    );
  }
});
