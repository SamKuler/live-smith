import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelConnectionError,
  ModelRetryableError,
} from "../model/connection-error.js";
import { createHostAbortController } from "../runtime/host.js";
import { requestModelWithReconnect } from "./model-reconnect.js";

test("model reconnect uses the fixed schedule and announces a proven response once", async () => {
  const controller = createHostAbortController();
  const events: string[] = [];
  const delays: number[] = [];
  const reconnectStates: object[] = [];
  let calls = 0;

  const result = await requestModelWithReconnect({
    signal: controller.signal,
    request: async ({ markResponseStarted, reconnectState }) => {
      calls += 1;
      reconnectStates.push(reconnectState);
      events.push(`request:${calls}`);
      if (calls === 1) throw new ModelConnectionError();
      await markResponseStarted();
      await markResponseStarted();
      events.push("provider-content");
      return "connected";
    },
    resetTransient: () => {
      events.push("reset");
    },
    onProgress: (message) => {
      events.push(`progress:${message}`);
    },
    waitForDelay: async (delayMs) => {
      delays.push(delayMs);
      events.push(`wait:${delayMs}`);
    },
  });

  assert.deepEqual(result, { value: "connected", reconnected: true });
  assert.equal(reconnectStates[0], reconnectStates[1]);
  assert.deepEqual(delays, [500]);
  assert.deepEqual(events, [
    "request:1",
    "reset",
    "progress:The model connection was interrupted. Reconnecting (1/5) in 500 ms…",
    "wait:500",
    "request:2",
    "progress:Reconnected. Reading model response",
    "provider-content",
  ]);
});

test("model reconnect exhausts exactly five retries with a fixed safe error", async () => {
  const controller = createHostAbortController();
  const delays: number[] = [];
  const progress: string[] = [];
  let calls = 0;
  let resets = 0;

  await assert.rejects(
    requestModelWithReconnect({
      signal: controller.signal,
      request: async () => {
        calls += 1;
        throw new ModelConnectionError();
      },
      resetTransient: () => {
        resets += 1;
      },
      onProgress: (message) => {
        progress.push(message);
      },
      waitForDelay: async (delayMs) => {
        delays.push(delayMs);
      },
    }),
    (error: unknown) => {
      assert.equal(error instanceof ModelConnectionError, false);
      assert.equal(
        error instanceof Error && error.message,
        "The model connection was interrupted. Reconnect limit reached after 5 attempts.",
      );
      return true;
    },
  );

  assert.equal(calls, 6);
  assert.equal(resets, 5);
  assert.deepEqual(delays, [500, 1_000, 2_000, 4_000, 8_000]);
  assert.deepEqual(progress, [
    "The model connection was interrupted. Reconnecting (1/5) in 500 ms…",
    "The model connection was interrupted. Reconnecting (2/5) in 1000 ms…",
    "The model connection was interrupted. Reconnecting (3/5) in 2000 ms…",
    "The model connection was interrupted. Reconnecting (4/5) in 4000 ms…",
    "The model connection was interrupted. Reconnecting (5/5) in 8000 ms…",
  ]);
});

test("model reconnect does not catch ordinary model failures", async () => {
  const controller = createHostAbortController();
  const failure = new Error("ordinary model failure");
  let resets = 0;
  let waits = 0;

  await assert.rejects(
    requestModelWithReconnect({
      signal: controller.signal,
      request: async () => {
        throw failure;
      },
      resetTransient: () => {
        resets += 1;
      },
      onProgress: () => {},
      waitForDelay: async () => {
        waits += 1;
      },
    }),
    (error: unknown) => error === failure,
  );
  assert.equal(resets, 0);
  assert.equal(waits, 0);
});

test("model reconnect keeps an initial success outside reconnect UX", async () => {
  const controller = createHostAbortController();
  const progress: string[] = [];

  const result = await requestModelWithReconnect({
    signal: controller.signal,
    request: async ({ markResponseStarted }) => {
      await markResponseStarted();
      return 42;
    },
    resetTransient: () => {},
    onProgress: (message) => {
      progress.push(message);
    },
  });

  assert.deepEqual(result, { value: 42, reconnected: false });
  assert.deepEqual(progress, []);
});

test("model reconnect rejects a late success after cancellation", async () => {
  const controller = createHostAbortController();
  const cancellation = new Error("dialog closed");
  let releaseRequest!: () => void;
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });

  const request = requestModelWithReconnect({
    signal: controller.signal,
    request: async () => {
      await requestGate;
      return "late provider response";
    },
    resetTransient: () => {},
    onProgress: () => {},
  });

  controller.abort(cancellation);
  releaseRequest();
  await assert.rejects(request, (error: unknown) => error === cancellation);
});

test("model reconnect announces a non-streaming recovery before resolving", async () => {
  const controller = createHostAbortController();
  const events: string[] = [];
  let calls = 0;

  const result = await requestModelWithReconnect({
    signal: controller.signal,
    request: async () => {
      calls += 1;
      events.push(`request:${calls}`);
      if (calls === 1) throw new ModelConnectionError();
      events.push("provider-resolved");
      return "connected";
    },
    resetTransient: () => {
      events.push("reset");
    },
    onProgress: (message) => {
      events.push(`progress:${message}`);
    },
    waitForDelay: async () => {},
  });

  assert.deepEqual(result, { value: "connected", reconnected: true });
  assert.deepEqual(events, [
    "request:1",
    "reset",
    "progress:The model connection was interrupted. Reconnecting (1/5) in 500 ms…",
    "request:2",
    "provider-resolved",
    "progress:Reconnected. Reading model response",
  ]);
});

test("model retry honors a provider delay without calling it connection loss", async () => {
  const controller = createHostAbortController();
  const delays: number[] = [];
  const progress: string[] = [];
  let calls = 0;

  const result = await requestModelWithReconnect({
    signal: controller.signal,
    request: async () => {
      calls += 1;
      if (calls === 1) {
        throw new ModelRetryableError("Provider rate limit was reached.", 3_000);
      }
      return "recovered";
    },
    resetTransient: () => {},
    onProgress: (message) => {
      progress.push(message);
    },
    waitForDelay: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  assert.deepEqual(result, { value: "recovered", reconnected: true });
  assert.deepEqual(delays, [3_000]);
  assert.deepEqual(progress, [
    "Provider rate limit was reached. Retrying (1/5) in 3000 ms…",
    "Retry succeeded. Reading model response",
  ]);
});

test("model retry exhaustion preserves its fixed safe provider diagnosis", async () => {
  const controller = createHostAbortController();
  let calls = 0;

  await assert.rejects(
    requestModelWithReconnect({
      signal: controller.signal,
      request: async () => {
        calls += 1;
        throw new ModelRetryableError("Provider rate limit was reached.");
      },
      resetTransient: () => {},
      onProgress: () => {},
      waitForDelay: async () => {},
    }),
    /Provider rate limit was reached\. Retry limit reached after 5 attempts\./u,
  );
  assert.equal(calls, 6);
});

test("model retry refuses a provider delay beyond the automatic wait window", async () => {
  const controller = createHostAbortController();
  let calls = 0;
  let waits = 0;

  await assert.rejects(
    requestModelWithReconnect({
      signal: controller.signal,
      request: async () => {
        calls += 1;
        throw new ModelRetryableError("Provider rate limit was reached.", 300_001);
      },
      resetTransient: () => {},
      onProgress: () => {},
      waitForDelay: async () => {
        waits += 1;
      },
    }),
    /longer than the 5-minute automatic retry window; try again later/u,
  );
  assert.equal(calls, 1);
  assert.equal(waits, 0);
});

test("model reconnect delay is canceled with the caller's exact reason", {
  timeout: 1_000,
}, async () => {
  const controller = createHostAbortController();
  const reason = new Error("request stopped during reconnect");
  const order: string[] = [];

  await assert.rejects(
    requestModelWithReconnect({
      signal: controller.signal,
      request: async () => {
        throw new ModelConnectionError();
      },
      resetTransient: () => {
        order.push("reset");
      },
      onProgress: () => {
        order.push("progress");
        setTimeout(() => controller.abort(reason), 0);
      },
    }),
    (error: unknown) => error === reason,
  );
  assert.deepEqual(order, ["reset", "progress"]);
});

test("model reconnect normalizes a rejected wait to an active abort reason", async () => {
  const controller = createHostAbortController();
  const reason = new Error("request stopped while the wait seam rejected");
  const waitFailure = new Error("injected wait failure");

  await assert.rejects(
    requestModelWithReconnect({
      signal: controller.signal,
      request: async () => {
        throw new ModelConnectionError();
      },
      resetTransient: () => {},
      onProgress: () => {},
      waitForDelay: async () => {
        controller.abort(reason);
        throw waitFailure;
      },
    }),
    (error: unknown) => error === reason,
  );
});
