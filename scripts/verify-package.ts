import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

import { assertPackagedBundleMatches } from "../src/release/package-verification.js";

interface ExtensionManifest {
  name: string;
  entry: string;
  version: string;
}

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  await readFile(path.join(projectDirectory, "manifest.json"), "utf8"),
) as ExtensionManifest;
const archivePath = path.resolve(
  projectDirectory,
  argv[2] ?? `${packageSlug(manifest.name)}-${manifest.version}.ablx`,
);
const currentBundle = await readFile(path.resolve(projectDirectory, manifest.entry));
const extraction = spawnSync(
  "unzip",
  ["-p", archivePath, manifest.entry],
  { encoding: null, maxBuffer: 64 * 1024 * 1024 },
);
if (extraction.error) {
  throw new Error(`Could not inspect ${path.basename(archivePath)}: ${extraction.error.message}`);
}
if (extraction.status !== 0 || !extraction.stdout?.length) {
  const status = extraction.status === null ? "unknown" : String(extraction.status);
  throw new Error(
    `Could not extract ${manifest.entry} from ${path.basename(archivePath)} (unzip status ${status}).`,
  );
}

assertPackagedBundleMatches(currentBundle, extraction.stdout);
console.log(
  `Verified ${path.basename(archivePath)} contains the current ${manifest.entry}.`,
);

function packageSlug(name: string): string {
  const slug = name.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("Manifest name cannot produce a package filename.");
  return slug;
}
