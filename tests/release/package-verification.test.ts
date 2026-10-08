import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertPackagedBundleContainsThirdPartyNotices,
  assertPackagedBundleMatches,
  assertPluginFixtureReleaseSafety,
} from "../../src/release/package-verification.js";

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
  const lockfile = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() =>
    assertPackagedBundleContainsThirdPartyNotices(noticedBundle, lockfile)
  );

  for (const missingMarker of [
    "Third-Party Notices for Live Smith",
    "`fflate`",
    "Copyright (c) 2026 Arjun Barrett",
    "`officeparser`",
    "`xlsx`",
    "`fast-xml-parser`",
    "Copyright (c) 2017 Amit Kumar Gupta",
    "`@nodable/entities`",
    "authored by Amit Gupta",
    "`anynum`",
    "Copyright (c) 2026 Natural Intelligence",
    "`fast-xml-builder`",
    "`is-unsafe`",
    "`path-expression-matcher`",
    "Copyright (c) 2024",
    "`strnum`",
    "Copyright (c) 2021 Natural Intelligence",
    "`xml-naming`",
    "`tailwindcss`",
    "`@modelcontextprotocol/client`",
    "`@modelcontextprotocol/core`",
    "`@modelcontextprotocol/ext-apps`",
    "Copyright (c) Tailwind Labs, Inc.",
    "`ws`",
    "Copyright (c) 2016 Luigi Pinca",
    "`https-proxy-agent`",
    "`socks-proxy-agent`",
    "`agent-base`",
    "`proxy-agent-negotiate`",
    "`debug`",
    "`ms`",
    "`socks`",
    "`ip-address`",
    "`smart-buffer`",
    "`marked`",
    "Copyright (c) 2018+, MarkedJS",
    "Copyright (c) 2011-2018, Christopher Jeffrey",
    "Copyright © 2004, John Gruber",
    "`dompurify`",
    "Copyright (c) Cure53 and other contributors",
    "Apache License",
    "Version 2.0, January 2004",
    "END OF TERMS AND CONDITIONS",
    "Permission is hereby granted",
    "The above copyright notice and this permission notice shall be included in all",
    'THE SOFTWARE IS PROVIDED "AS IS"',
  ]) {
    assert.throws(
      () => assertPackagedBundleContainsThirdPartyNotices(
        Buffer.from(noticedBundle.toString("utf8").replaceAll(missingMarker, "missing")),
        lockfile,
      ),
      /third-party notice/i,
    );
  }
});

for (const packageName of ["@modelcontextprotocol/client", "@modelcontextprotocol/core", "fflate", "undici"]) {
  test(`package verification rejects notice versions behind the lockfile for ${packageName}`, async () => {
    const bundle = await readFile(new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url));
    const lockfile = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
    lockfile.packages[`node_modules/${packageName}`].version = "99.0.0";
    assert.throws(() => assertPackagedBundleContainsThirdPartyNotices(bundle, lockfile), (error: unknown) =>
      error instanceof Error && error.message.includes(packageName) && error.message.includes("99.0.0"));
  });
}

test("notice upgrades follow the lockfile without changing release validation code", async () => {
  const notices = await readFile(new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  const lockfile = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
  const packageName = "@modelcontextprotocol/client";
  const locked = lockfile.packages[`node_modules/${packageName}`];
  const updated = notices.replaceAll(`\`${packageName}\` ${locked.version}`, `\`${packageName}\` 99.0.0`);
  assert.notEqual(updated, notices);
  locked.version = "99.0.0";
  assert.doesNotThrow(() => assertPackagedBundleContainsThirdPartyNotices(Buffer.from(updated), lockfile));
  assert.throws(() => assertPackagedBundleContainsThirdPartyNotices(
    Buffer.from(updated.replaceAll(`\`${packageName}\` 99.0.0`, `\`${packageName}\``)), lockfile,
  ), /declare the locked version/);
  delete lockfile.packages[`node_modules/${packageName}`];
  assert.throws(() => assertPackagedBundleContainsThirdPartyNotices(Buffer.from(updated), lockfile), /locked version/);
});

test("bundled notices retain the complete Markdown dependency licenses", async () => {
  const notices = await readFile(
    new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url),
    "utf8",
  );
  for (const packageName of ["marked", "dompurify"]) {
    const license = await readFile(
      new URL(`../../node_modules/${packageName}/LICENSE`, import.meta.url),
      "utf8",
    );
    assert.ok(
      notices.includes(license.trim()),
      `Bundled notices must include the complete ${packageName} license.`,
    );
  }
});

test("Plugin fixture release safety rejects credentials, executable bits, untracked data, and manifest escapes", () => {
  const manifest = Buffer.from(JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "fixture.safe",
    version: "1.0.0",
  }));
  const valid = [{ path: "plugin.json", bytes: manifest, mode: 0o100644, tracked: true }];
  assert.doesNotThrow(() => assertPluginFixtureReleaseSafety(valid));
  assert.throws(() => assertPluginFixtureReleaseSafety([
    ...valid,
    { path: "secret.txt", bytes: Buffer.from("Authorization: Bearer private-value"), mode: 0o100644, tracked: true },
  ]), /credential-shaped/u);
  assert.throws(() => assertPluginFixtureReleaseSafety([
    ...valid,
    { path: "config.json", bytes: Buffer.from('{"apiKey":"fixture-secret-value"}'), mode: 0o100644, tracked: true },
  ]), /credential-shaped/u);
  assert.throws(() => assertPluginFixtureReleaseSafety([
    { ...valid[0]!, mode: 0o100755 },
  ]), /executable/u);
  assert.throws(() => assertPluginFixtureReleaseSafety([
    { ...valid[0]!, tracked: false },
  ]), /untracked/u);
  assert.throws(() => assertPluginFixtureReleaseSafety([
    ...valid,
    { path: "payload.bin", bytes: Uint8Array.from([0xff]), mode: 0o100644, tracked: true },
  ]), /non-text/u);
  assert.throws(() => assertPluginFixtureReleaseSafety([
    { path: "../plugin.json", bytes: manifest, mode: 0o100644, tracked: true },
  ]), /path/u);
  assert.throws(() => assertPluginFixtureReleaseSafety([{
    path: ".codex-plugin/plugin.json",
    bytes: Buffer.from(JSON.stringify({ name: "fixture.escape", skills: "../skills" })),
    mode: 0o100644,
    tracked: true,
  }]), /path/u);
});
