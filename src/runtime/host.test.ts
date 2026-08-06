import assert from "node:assert/strict";
import test from "node:test";

import {
  createHostAbortController,
  resolveFetchImplementation,
  throwIfAborted,
} from "./host.js";

test("fetch resolution accepts injection and reports a missing host capability", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  const injected: typeof fetch = async () => new Response("ok");
  try {
    assert.equal(resolveFetchImplementation(injected), injected);
    assert.throws(
      () => resolveFetchImplementation(),
      /Extension host does not provide the Fetch API/,
    );
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "fetch", descriptor);
    else Reflect.deleteProperty(globalThis, "fetch");
  }
});

test("abort checks preserve the host reason and support legacy signals", () => {
  const active = new AbortController();
  assert.doesNotThrow(() => throwIfAborted(active.signal));

  const reason = new Error("stop now");
  active.abort(reason);
  assert.throws(() => throwIfAborted(active.signal), (error) => error === reason);

  assert.throws(
    () => throwIfAborted({ aborted: true } as AbortSignal),
    /Operation aborted/,
  );
});

test("abort controller creation reports a missing host capability", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "AbortController");
  Object.defineProperty(globalThis, "AbortController", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  try {
    assert.throws(
      () => createHostAbortController(),
      /Extension host does not provide AbortController/,
    );
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "AbortController", descriptor);
    } else {
      Reflect.deleteProperty(globalThis, "AbortController");
    }
  }
});
