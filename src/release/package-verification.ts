import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

const REQUIRED_THIRD_PARTY_NOTICE_MARKERS = [
  "Third-Party Notices for Live Smith",
  "fflate 0.8.3",
  "fast-xml-parser 5.10.1",
  "Permission is hereby granted",
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
