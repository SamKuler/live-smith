import assert from "node:assert/strict";
import test from "node:test";

import {
  requireOAuthJson,
  startLoopbackAuthorization,
} from "./oauth-utils.js";

test("OAuth HTTP failures never expose remote credential-bearing bodies", async () => {
  const response = new Response(JSON.stringify({
    error: "invalid refresh token secret-refresh-value",
  }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(
    requireOAuthJson(response, "Provider OAuth"),
    (error: unknown) => {
      assert.match(String(error), /Provider OAuth HTTP 401: request failed/);
      assert.doesNotMatch(String(error), /secret-refresh-value/);
      return true;
    },
  );
});

test("loopback OAuth binds an ephemeral port and terminates a denied authorization", async () => {
  const controller = new AbortController();
  const authorization = await startLoopbackAuthorization({
    port: 0,
    path: "/callback",
    expectedState: "expected-state",
    signal: controller.signal,
    successMessage: "Signed in.",
  });
  const callback = new URL(authorization.redirectUri);
  assert.notEqual(callback.port, "0");
  callback.searchParams.set("state", "expected-state");
  callback.searchParams.set("error", "access_denied_with_remote_details");
  const completion = assert.rejects(
    authorization.completion,
    /OAuth authorization did not complete/u,
  );

  const response = await fetch(callback);
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /access_denied_with_remote_details/u);
  await completion;
});
