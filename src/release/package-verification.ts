import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

const REQUIRED_THIRD_PARTY_NOTICE_MARKERS = [
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
  "`marked` 18.0.9",
  "Copyright (c) 2018+, MarkedJS",
  "Copyright (c) 2011-2018, Christopher Jeffrey",
  "Copyright © 2004, John Gruber",
  "`dompurify` 3.4.13",
  "Copyright (c) Cure53 and other contributors",
  "Apache License",
  "Version 2.0, January 2004",
  "END OF TERMS AND CONDITIONS",
  "Permission is hereby granted",
  "The above copyright notice and this permission notice shall be included in all",
  'THE SOFTWARE IS PROVIDED "AS IS"',
] as const;

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
): void {
  const bundle = Buffer.from(
    packagedBundle.buffer,
    packagedBundle.byteOffset,
    packagedBundle.byteLength,
  );
  const missingMarker = REQUIRED_THIRD_PARTY_NOTICE_MARKERS.find(
    (marker) => !bundle.includes(marker),
  );
  if (missingMarker === undefined) return;

  throw new Error(
    "Packaged extension bundle is missing the required third-party notice. Rebuild before release.",
  );
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
