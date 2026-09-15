import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = "src/runtime/native";
const capsulePath = `${root}/verifier-capsule.json`;
const sourcePaths = [`${root}/suno-verification.m`, `${root}/Info.plist`, "scripts/build-native-verifier.ts"];
const appPaths = ["Contents/MacOS/SunoVerification", "Contents/Info.plist", "Contents/_CodeSignature/CodeResources"];
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface NativeVerifierCapsule {
  version: 1;
  sourceDigest: string;
  files: Array<{ path: string; base64: string; sha256: string }>;
}

/** Builds consume the receipt: a source change cannot silently ship old native code. */
export async function readNativeVerifierCapsule(): Promise<NativeVerifierCapsule> {
  const hash = createHash("sha256");
  for (const source of sourcePaths) hash.update(source).update(await fs.readFile(source));
  const sourceDigest = hash.digest("hex");
  let capsule: NativeVerifierCapsule | undefined;
  try { capsule = JSON.parse(await fs.readFile(capsulePath, "utf8")) as NativeVerifierCapsule; } catch {}
  if (capsule?.version !== 1 || capsule.sourceDigest !== sourceDigest) {
    if (process.platform !== "darwin") throw new Error("The native verifier capsule is stale. Rebuild it on macOS with Command Line Tools before packaging.");
    capsule = await compileCapsule(sourceDigest);
    await fs.writeFile(capsulePath, JSON.stringify(capsule) + "\n");
  }
  if (capsule.files.length !== appPaths.length || capsule.files.some((file, index) =>
    file.path !== appPaths[index] || file.sha256 !== digest(Buffer.from(file.base64, "base64")))) {
    throw new Error("The native verifier capsule failed its content verification.");
  }
  return capsule;
}

async function compileCapsule(sourceDigest: string): Promise<NativeVerifierCapsule> {
  // Use the separately installed CLT toolchain; never accept an Xcode license.
  const tools = "/Library/Developer/CommandLineTools";
  const compiler = `${tools}/usr/bin/clang`;
  const sdk = `${tools}/SDKs/MacOSX.sdk`;
  const temporary = await fs.mkdtemp(path.join(tmpdir(), "live-smith-verifier-build-"));
  try {
    const app = path.join(temporary, "SunoVerification.app");
    await fs.mkdir(path.join(app, "Contents/MacOS"), { recursive: true });
    await fs.copyFile(`${root}/Info.plist`, path.join(app, "Contents/Info.plist"));
    await run(compiler, ["-fobjc-arc", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=14.0",
      "-isysroot", sdk, "-framework", "Cocoa", "-framework", "WebKit", "-framework", "Network",
      `${root}/suno-verification.m`, "-o", path.join(app, appPaths[0]!)], { timeout: 120_000, maxBuffer: 256_000 });
    await run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "dev.livesmith.suno-verification", app], { timeout: 30_000 });
    await run("/usr/bin/codesign", ["--verify", "--strict", app], { timeout: 30_000 });
    const files = [];
    for (const file of appPaths) {
      const bytes = await fs.readFile(path.join(app, file));
      files.push({ path: file, base64: bytes.toString("base64"), sha256: digest(bytes) });
    }
    return { version: 1, sourceDigest, files };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
