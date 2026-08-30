import assert from "node:assert/strict";
import test from "node:test";

import {
  validateDraftProfileForSave,
  type DraftProfile,
  type OAuthSubscriptionConnection,
} from "./profile.js";

function profile(connection: OAuthSubscriptionConnection): DraftProfile {
  return {
    id: `${connection.provider}-subscription`,
    name: `${connection.provider} subscription`,
    connection,
    defaultModel: "model-1",
    models: [{
      model: "model-1",
      parameters: { reasoning: { mode: "default" } },
      advanced: {},
    }],
  };
}

test("OAuth subscription Profiles accept only the three product providers", () => {
  for (const provider of ["openai", "anthropic", "google"] as const) {
    const saved = validateDraftProfileForSave(profile({
      kind: "oauth-subscription",
      provider,
    }));
    assert.deepEqual(saved.connection, {
      kind: "oauth-subscription",
      provider,
    });
    assert.deepEqual(saved.models[0]?.parameters, {
      reasoning: { mode: "default" },
    });
  }
});

test("OAuth subscription Profiles reject credential and endpoint fields", () => {
  const base = profile({ kind: "oauth-subscription", provider: "openai" });
  for (const connection of [
    { ...base.connection, apiKey: "secret" },
    { ...base.connection, baseUrl: "https://example.com" },
    { kind: "oauth-subscription", provider: "other" },
  ]) {
    assert.throws(
      () => validateDraftProfileForSave({ ...base, connection } as DraftProfile),
      /connection|unsupported/i,
    );
  }
});

test("current Profile validation rejects the removed Codex connection kind", () => {
  const base = profile({ kind: "oauth-subscription", provider: "openai" });
  assert.throws(
    () => validateDraftProfileForSave({
      ...base,
      connection: { kind: "codex-subscription", provider: "openai" },
    } as unknown as DraftProfile),
    /connection kind is unsupported/i,
  );
});
