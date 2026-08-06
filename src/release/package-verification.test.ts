import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import test from "node:test";

import { assertPackagedBundleMatches } from "./package-verification.js";

test("package verification accepts the exact current bundle", () => {
  const bundle = Buffer.from("current extension bundle");
  assert.doesNotThrow(() => assertPackagedBundleMatches(bundle, bundle));
});

test("package verification reports both hashes without bundle contents", () => {
  const current = Buffer.from("current extension bundle with private data");
  const packaged = Buffer.from("stale extension bundle with old private data");
  const currentHash = createHash("sha256").update(current).digest("hex");
  const packagedHash = createHash("sha256").update(packaged).digest("hex");

  assert.throws(
    () => assertPackagedBundleMatches(current, packaged),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(currentHash) &&
      error.message.includes(packagedHash) &&
      !error.message.includes("private data"),
  );
});
