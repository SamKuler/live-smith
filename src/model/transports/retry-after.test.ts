import assert from "node:assert/strict";
import test from "node:test";

import { providerRetryAfterMs } from "./retry-after.js";

test("provider retry delay prefers milliseconds and honors remote waits", () => {
  assert.equal(
    providerRetryAfterMs(new Headers({
      "retry-after": "9",
      "retry-after-ms": "1250.1",
    })),
    1_251,
  );
  assert.equal(
    providerRetryAfterMs(new Headers({ "retry-after": "120" })),
    120_000,
  );
});

test("provider retry delay rejects malformed and negative values", () => {
  for (const value of ["", "-1", "+1", "1 second", "Infinity"]) {
    assert.equal(
      providerRetryAfterMs(new Headers({ "retry-after": value })),
      undefined,
    );
  }
});

test("provider retry delay honors an HTTP date and treats a past date as elapsed", (t) => {
  const now = Date.UTC(2026, 8, 24, 12, 0, 0);
  t.mock.method(Date, "now", () => now);
  const future = new Date(now + 120_000).toUTCString();
  const beyondAutomaticRetry = new Date(now + 360_000).toUTCString();
  const past = new Date(now - 1_000).toUTCString();

  assert.equal(providerRetryAfterMs(new Headers({ "retry-after": future })), 120_000);
  assert.equal(providerRetryAfterMs(new Headers({ "retry-after": beyondAutomaticRetry })), 360_000);
  assert.equal(providerRetryAfterMs(new Headers({ "retry-after": past })), 0);
  assert.equal(providerRetryAfterMs(new Headers({
    "retry-after": future,
    "retry-after-ms": "2500",
  })), 2_500);
});

test("provider retry delay reads all HTTP-date wire formats as UTC", (t) => {
  t.mock.method(Date, "now", () => Date.UTC(1994, 10, 6, 8, 49, 0));
  for (const value of [
    "Sun, 06 Nov 1994 08:49:37 GMT",
    "Sunday, 06-Nov-94 08:49:37 GMT",
    "Sun Nov  6 08:49:37 1994",
  ]) {
    assert.equal(providerRetryAfterMs(new Headers({ "retry-after": value })), 37_000, value);
  }
});

test("provider retry delay rejects impossible HTTP calendar dates", () => {
  assert.equal(providerRetryAfterMs(new Headers({
    "retry-after": "Wed, 31 Feb 2027 12:00:00 GMT",
  })), undefined);
});
