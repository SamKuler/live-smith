import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export interface NativeAppCapsule {
  version: 1;
  sourceDigest: string;
  files: Array<{ path: string; base64: string; sha256: string }>;
}
interface Recipe {
  name: string; identifier: string; source: string; plist: string; recipe: string;
  capsule: string; frameworks: string[];
}

/** A source receipt binds each signed helper to its sources and shared build recipe. */
export async function readNativeAppCapsule(recipe: Recipe): Promise<NativeAppCapsule> {
  const hash = createHash("sha256");
  for (const source of [recipe.source, recipe.plist, recipe.recipe, "scripts/native-app-capsule.ts"]) hash.update(source).update(await fs.readFile(source));
  const sourceDigest = hash.digest("hex");
  const appPaths = [`Contents/MacOS/${recipe.name}`, "Contents/Info.plist", "Contents/_CodeSignature/CodeResources"];
  let capsule: NativeAppCapsule | undefined;
  try { capsule = JSON.parse(await fs.readFile(recipe.capsule, "utf8")) as NativeAppCapsule; } catch {}
  if (capsule?.version !== 1 || capsule.sourceDigest !== sourceDigest) {
    if (process.platform !== "darwin") throw new Error(`The ${recipe.name} capsule is stale. Rebuild it on macOS with Command Line Tools before packaging.`);
    const temporary = await fs.mkdtemp(path.join(tmpdir(), "live-smith-native-build-"));
    try {
      const app = path.join(temporary, `${recipe.name}.app`);
      await fs.mkdir(path.join(app, "Contents/MacOS"), { recursive: true });
      await fs.copyFile(recipe.plist, path.join(app, "Contents/Info.plist"));
      const tools = "/Library/Developer/CommandLineTools";
      await run(`${tools}/usr/bin/clang`, ["-fobjc-arc", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=14.0",
        "-isysroot", `${tools}/SDKs/MacOSX.sdk`, ...recipe.frameworks.flatMap(name => ["-framework", name]),
        recipe.source, "-o", path.join(app, appPaths[0]!)], { timeout: 120_000, maxBuffer: 256_000 });
      await run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", recipe.identifier, app], { timeout: 30_000 });
      await run("/usr/bin/codesign", ["--verify", "--strict", app], { timeout: 30_000 });
      const files = [];
      for (const file of appPaths) {
        const bytes = await fs.readFile(path.join(app, file));
        files.push({ path: file, base64: bytes.toString("base64"), sha256: digest(bytes) });
      }
      capsule = { version: 1, sourceDigest, files };
      await fs.writeFile(recipe.capsule, JSON.stringify(capsule) + "\n");
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  if (!Array.isArray(capsule.files) || capsule.files.length !== appPaths.length || capsule.files.some((file, index) =>
    file.path !== appPaths[index] || file.sha256 !== digest(Buffer.from(file.base64, "base64")))) {
    throw new Error(`The ${recipe.name} capsule failed its content verification.`);
  }
  return capsule;
}
