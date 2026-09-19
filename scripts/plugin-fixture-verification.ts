import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  assertPluginFixtureReleaseSafety,
  type PluginFixtureReleaseFile,
} from "../src/release/package-verification.js";

export async function verifyTrackedPluginFixtures(
  projectDirectory: string,
): Promise<number> {
  const fixtureRoot = path.join(projectDirectory, "test-fixtures", "plugins");
  const trackedResult = spawnSync(
    "git",
    ["ls-files", "-z", "--", "test-fixtures/plugins"],
    { cwd: projectDirectory, encoding: "utf8" },
  );
  if (trackedResult.error || trackedResult.status !== 0) {
    throw new Error("Could not inspect tracked Plugin fixture files.");
  }
  const tracked = new Set(
    (trackedResult.stdout ?? "").split("\0").filter(Boolean),
  );
  const entries = await fs.readdir(fixtureRoot, { withFileTypes: true });
  if (!entries.length) throw new Error("Plugin compatibility fixtures are missing.");
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      throw new Error("Plugin fixture root may contain package directories only.");
    }
    const root = path.join(fixtureRoot, entry.name);
    const files: PluginFixtureReleaseFile[] = [];
    await collectFixtureFiles(projectDirectory, root, root, tracked, files);
    assertPluginFixtureReleaseSafety(files);
  }
  return entries.length;
}

async function collectFixtureFiles(
  projectDirectory: string,
  root: string,
  directory: string,
  tracked: ReadonlySet<string>,
  output: PluginFixtureReleaseFile[],
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFixtureFiles(projectDirectory, root, target, tracked, output);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error("Plugin fixtures may contain regular files only.");
    }
    const stat = await fs.stat(target);
    const projectPath = portablePath(path.relative(projectDirectory, target));
    output.push({
      path: portablePath(path.relative(root, target)),
      bytes: await fs.readFile(target),
      mode: stat.mode,
      tracked: tracked.has(projectPath),
    });
  }
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}
