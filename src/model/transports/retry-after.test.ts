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
