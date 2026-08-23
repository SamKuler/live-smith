import assert from "node:assert/strict";
import test from "node:test";

import type { SavedProfile } from "../profile.js";
import { withTransportContext } from "./errors.js";

const profile: SavedProfile = {
  id: "signed-proxy",
  name: "Signed proxy",
  connection: {
    kind: "direct-api",
    apiFamily: "openai",
    apiMode: "responses",
    baseUrl:
      "https://example.test/v1?token=signed-secret&tenant=studio-secret" +
      "#fragment-secret",
    apiKey: "api-secret",
  },
  model: "model-a",
  parameters: {
    maxOutputTokens: 1024,
    reasoning: { mode: "default" },
  },
  advanced: {},
};

test("transport errors remove every URL query and fragment before propagation", async () => {
  await assert.rejects(
    withTransportContext(profile, "request", async () => {
      throw new Error(
        "api-secret failed at " +
          "https://alice:url-secret@example.test/v1/responses" +
          "?token=signed-secret#fragment-secret and " +
          "http://127.0.0.1:8080/proxy?access=second-secret; detached " +
          "signed-secret, studio-secret, and fragment-secret",
      );
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /^openai\/responses request failed:/);
      assert.match(message, /https:\/\/\[redacted\]@example\.test\/v1\/responses/);
      assert.match(message, /http:\/\/127\.0\.0\.1:8080\/proxy/);
      assert.doesNotMatch(
        message,
        /api-secret|url-secret|signed-secret|studio-secret|fragment-secret|second-secret|[?#]/,
      );
      return true;
    },
  );
});

test("transport errors redact raw, decoded, repeated, plus, and malformed URL secrets", async () => {
  if (profile.connection.kind !== "direct-api") {
    throw new Error("Expected the transport fixture to use Direct API.");
  }
  const rawFragment =
    "token=fragment%2Dsecret&tenant=studio%20fragment" +
    "&malformed=broken%2Dfragment%zz" +
    "&repeat=first%2Dfragment&repeat=second%2Dfragment" +
    "&literal=plus+fragment";
  const forgivingDecodedFragment =
    "token=fragment-secret&tenant=studio fragment" +
    "&malformed=broken-fragment%zz" +
    "&repeat=first-fragment&repeat=second-fragment" +
    "&literal=plus+fragment";
  const encodedProfile: SavedProfile = {
    ...profile,
    connection: {
      ...profile.connection,
      baseUrl:
        "https://example.test/v1?encoded=raw%2Dquery&space=signed%20query" +
        "&slash=signed%2fquery&plus=plus+query" +
        "&repeat=first%2Drepeat&repeat=second%2Drepeat" +
        "&malformed=broken%2Dquery%zz" +
        `#${rawFragment}`,
    },
  };
  const exposedForms = [
    "raw%2Dquery",
    "raw-query",
    "signed%20query",
    "signed+query",
    "signed query",
    "signed%2fquery",
    "signed%2Fquery",
    "signed/query",
    "plus+query",
    "plus query",
    "first%2Drepeat",
    "first-repeat",
    "second%2Drepeat",
    "second-repeat",
    "broken%2Dquery%zz",
    "broken-query%25zz",
    "broken-query%zz",
    rawFragment,
    forgivingDecodedFragment,
    "fragment%2Dsecret",
    "fragment-secret",
    "studio%20fragment",
    "studio fragment",
    "broken%2Dfragment%zz",
    "broken-fragment%zz",
    "first%2Dfragment",
    "first-fragment",
    "second%2Dfragment",
    "second-fragment",
    "plus+fragment",
  ];

  await assert.rejects(
    withTransportContext(encodedProfile, "request", async () => {
      throw new Error(
        `Detached values: ${exposedForms.join(" | ")} | unrelated plus fragment`,
      );
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      for (const exposed of exposedForms) {
        assert.equal(message.includes(exposed), false, `Leaked ${exposed}`);
      }
      assert.match(message, /unrelated plus fragment/);
      return true;
    },
  );
});
