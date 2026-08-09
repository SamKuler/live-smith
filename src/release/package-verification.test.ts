import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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

test("package verification requires the actual bundled third-party notices", async () => {
  const noticedBundle = await readFile(
    new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url),
  );
  assert.doesNotThrow(() =>
    assertPackagedBundleContainsThirdPartyNotices(noticedBundle)
  );

  for (const missingMarker of [
    "Third-Party Notices for Live Smith",
    "`fflate` 0.8.3 — Copyright (c) 2026 Arjun Barrett",
    "`fast-xml-parser` 5.10.1 — Copyright (c) 2017 Amit Kumar Gupta",
    "`@nodable/entities` 3.0.0 — authored by Amit Gupta",
    "`anynum` 1.0.1 — Copyright (c) 2026 Natural Intelligence",
    "`fast-xml-builder` 1.3.0 — Copyright (c) 2026 Natural Intelligence",
    "`is-unsafe` 2.0.0 — Copyright (c) 2026 Natural Intelligence",
    "`path-expression-matcher` 1.6.2 — Copyright (c) 2024",
    "`strnum` 2.4.1 — Copyright (c) 2021 Natural Intelligence",
    "`xml-naming` 0.3.0 — Copyright (c) 2026 Natural Intelligence",
    "Permission is hereby granted",
    "The above copyright notice and this permission notice shall be included in all",
    'THE SOFTWARE IS PROVIDED "AS IS"',
  ]) {
    assert.throws(
      () => assertPackagedBundleContainsThirdPartyNotices(
        Buffer.from(noticedBundle.toString("utf8").replace(missingMarker, "missing")),
      ),
      /third-party notice/i,
    );
  }
});
