import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { parsePluginPackageManifest } from "../plugins/manifest.js";

const REQUIRED_THIRD_PARTY_NOTICE_MARKERS = [
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
  "Copyright (c) Tailwind Labs, Inc.",
  "`@modelcontextprotocol/client`",
  "`@modelcontextprotocol/core`",
  "`@modelcontextprotocol/ext-apps`",
  "`@standard-schema/spec`",
  "Copyright (c) 2024-2025 Model Context Protocol",
  "`eventsource`",
  "`jose`",
  "`zod`",
  "`cross-spawn`",
  "The ISC License",
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
] as const;

const FORBIDDEN_FIXTURE_CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /\bAuthorization\s*[:=]\s*Bearer\s+[^\s"']+/iu,
  /["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/iu,
  /\b__(?:client|session)=[^;\s]{16,}/iu,
] as const;

export interface PluginFixtureReleaseFile {
  path: string;
  bytes: Uint8Array;
  mode: number;
  tracked: boolean;
}

export function assertPackagedBundleMatches(
  currentBundle: Uint8Array,
  packagedBundle: Uint8Array,
): void {
  const currentHash = sha256(currentBundle);
  const packagedHash = sha256(packagedBundle);
  if (currentHash === packagedHash) return;

  throw new Error(
    `Packaged extension bundle is stale: current sha256=${currentHash}, packaged sha256=${packagedHash}. Rebuild and package the current source before release.`,
  );
}

export function assertPackagedBundleContainsThirdPartyNotices(
  packagedBundle: Uint8Array,
  lockfile: { packages: Record<string, { version?: string }> },
): void {
  const bundle = Buffer.from(
    packagedBundle.buffer,
    packagedBundle.byteOffset,
    packagedBundle.byteLength,
  );
  const missingMarker = REQUIRED_THIRD_PARTY_NOTICE_MARKERS.find(
    (marker) => !bundle.includes(marker),
  );
  if (missingMarker !== undefined) {
    throw new Error(
      "Packaged extension bundle is missing the required third-party notice. Rebuild before release.",
    );
  }
  assertThirdPartyNoticeVersions(bundle.toString("utf8"), lockfile);
}

function assertThirdPartyNoticeVersions(
  notices: string,
  lockfile: { packages: Record<string, { version?: string }> },
): void {
  const verified = new Set<string>();
  for (const [, name, declared] of notices.matchAll(/`([^`\r\n]+)`[ \t]+([0-9][^\s`]*)/gu)) {
    const locked = lockfile.packages[`node_modules/${name}`]?.version;
    // Embedded upstream components can have notices without separate npm
    // lock entries; their license text remains part of the bundled notice.
    if (locked === undefined) continue;
    if (declared !== locked) {
      throw new Error(`Third-party notice version for ${name} is ${declared}; package-lock.json requires ${locked}.`);
    }
    verified.add(`\`${name}\``);
  }
  for (const marker of REQUIRED_THIRD_PARTY_NOTICE_MARKERS) {
    if (marker.startsWith("`") && !verified.has(marker)) {
      throw new Error(`Third-party notice must declare the locked version of ${marker}.`);
    }
  }
}

export function assertPluginFixtureReleaseSafety(
  files: readonly PluginFixtureReleaseFile[],
): void {
  if (!files.length) throw new Error("Plugin fixture package is empty.");
  for (const file of files) {
    if (!file.tracked) {
      throw new Error(`Plugin fixture contains untracked package data: ${file.path}.`);
    }
    if ((file.mode & 0o111) !== 0) {
      throw new Error(`Plugin fixture contains an executable file: ${file.path}.`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    } catch {
      throw new Error(`Plugin fixture contains non-text package data: ${file.path}.`);
    }
    if (FORBIDDEN_FIXTURE_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) {
      throw new Error(`Plugin fixture contains credential-shaped data: ${file.path}.`);
    }
  }
  parsePluginPackageManifest(files.map(({ path: filePath, bytes }) => ({
    path: filePath,
    bytes,
  })));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
