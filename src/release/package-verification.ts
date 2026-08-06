import { createHash } from "node:crypto";

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

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
