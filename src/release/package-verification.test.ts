import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertPackagedBundleContainsThirdPartyNotices,
  assertPackagedBundleMatches,
} from "./package-verification.js";

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

test("package verification requires bundled third-party notices", () => {
  const noticedBundle = Buffer.from([
    "Third-Party Notices for Live Smith",
    "fflate 0.8.3",
    "fast-xml-parser 5.10.1",
    "Permission is hereby granted",
  ].join("\n"));
  assert.doesNotThrow(() =>
    assertPackagedBundleContainsThirdPartyNotices(noticedBundle)
  );

  for (const missingMarker of [
    "Third-Party Notices for Live Smith",
    "fflate 0.8.3",
    "fast-xml-parser 5.10.1",
    "Permission is hereby granted",
  ]) {
    assert.throws(
      () => assertPackagedBundleContainsThirdPartyNotices(
        Buffer.from(noticedBundle.toString("utf8").replace(missingMarker, "missing")),
      ),
      /third-party notice/i,
    );
  }
});
