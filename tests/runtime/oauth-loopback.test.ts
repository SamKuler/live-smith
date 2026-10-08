import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

import { createHostAbortController } from "../../src/runtime/host.js";
import { startOAuthLoopbackCallback } from "../../src/runtime/oauth-loopback.js";

for (const scenario of ["success", "denied", "cancel", "abort", "timeout"] as const) {
  for (const spareRequest of ["idle", "incomplete"] as const) {
    test(`OAuth ${scenario} releases completion and ${spareRequest} spare connections`, async () => {
      const controller = createHostAbortController();
      const callback = await startOAuthLoopbackCallback({
        port: 0, path: "/callback", expectedState: "expected-state", signal: controller.signal,
        successMessage: "Signed in <success> & ready.", redirectHost: "127.0.0.1",
        timeoutMs: scenario === "timeout" ? 200 : 5_000,
      });
      const outcome = callback.completion.then(
        (value) => ({ kind: "success" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const target = new URL(callback.redirectUri);
      const spare = connect(Number(target.port), "127.0.0.1");
      spare.on("error", (error: NodeJS.ErrnoException) => assert.equal(error.code, "ECONNRESET"));
      const closed = new Promise<void>((resolve) => spare.once("close", () => resolve()));
      await once(spare, "connect");
      spare.resume();
      if (spareRequest === "incomplete") spare.write("GET /callback HTTP/1.1\r\nHost: localhost\r\n");
      try {
        const unrelated = new URL("/unrelated", target);
        assert.equal((await fetch(unrelated)).status, 404);
        if (scenario === "success" || scenario === "denied") {
          target.searchParams.set("state", "expected-state");
          if (scenario === "success") {
            target.searchParams.set("code", "fixture-code");
            target.searchParams.set("iss", "https://issuer.example");
          } else target.searchParams.set("error", "fixture-private-error");
          const response = await fetch(target);
          assert.equal(response.status, scenario === "success" ? 200 : 400);
          assert.match(await response.text(), scenario === "success"
            ? /Signed in &lt;success&gt; &amp; ready\.<\/p>$/
            : /OAuth authorization did not complete\.<\/p>$/);
        } else if (scenario === "cancel") callback.cancel(new Error("fixture cancel"));
        else if (scenario === "abort") controller.abort(new Error("fixture abort"));

        const result = await Promise.race([outcome, delay(1_000, { kind: "pending" as const }, { ref: false })]);
        assert.notEqual(result.kind, "pending", "authorization must settle while a spare connection is still open");
        if (scenario === "success") {
          assert.deepEqual(result, { kind: "success", value: { code: "fixture-code", iss: "https://issuer.example" } });
        } else {
          assert.equal(result.kind, "error");
          if (result.kind === "error") assert.match(String(result.error), scenario === "timeout"
            ? /timed out/ : scenario === "denied" ? /did not complete/ : new RegExp(`fixture ${scenario}`));
        }
        assert.equal(await Promise.race([closed.then(() => true), delay(1_000, false, { ref: false })]), true);
        await assert.rejects(fetch(target));
      } finally {
        spare.destroy();
        callback.cancel();
        await outcome;
      }
    });
  }
}

test("OAuth completion bounds teardown when the callback peer stops reading its response", async () => {
  const callback = await startOAuthLoopbackCallback({
    port: 0, path: "/callback", expectedState: "expected-state", signal: createHostAbortController().signal,
    successMessage: "Signed in. ".repeat(1024 * 1024), redirectHost: "127.0.0.1",
  });
  const target = new URL(callback.redirectUri);
  const peer = connect(Number(target.port), "127.0.0.1");
  peer.on("error", (error: NodeJS.ErrnoException) => assert.equal(error.code, "ECONNRESET"));
  const outcome = callback.completion.then((value) => value, () => undefined);
  try {
    await once(peer, "connect");
    peer.write("GET /callback?state=expected-state&code=fixture-code HTTP/1.1\r\nHost: localhost\r\n\r\n");
    const result = await Promise.race([outcome, delay(2_000, "pending", { ref: false })]);
    assert.deepEqual(result, { code: "fixture-code" });
    await assert.rejects(fetch(target));
  } finally {
    peer.destroy();
    callback.cancel();
    await outcome;
  }
});
