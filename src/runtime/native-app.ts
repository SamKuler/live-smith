import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

/** Only the exact executable, plist and signature from the build capsule are staged. */
export async function stageNativeApp(capsule: string, name: string, prefix: string) {
  const paths = [`Contents/MacOS/${name}`, "Contents/Info.plist", "Contents/_CodeSignature/CodeResources"];
  const data = JSON.parse(capsule) as { version: unknown; files: Array<{ path: string; base64: string; sha256: string }> };
  if (data.version !== 1 || !Array.isArray(data.files) || data.files.length !== paths.length) throw new Error("Invalid native application capsule.");
  const files = data.files.map((file, index) => {
    if (!file || file.path !== paths[index] || typeof file.base64 !== "string" || file.base64.length > 2_000_000) throw new Error("Invalid native application capsule.");
    const bytes = Buffer.from(file.base64, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("Invalid native application capsule.");
    return bytes;
  });
  const directory = await fs.mkdtemp(path.join(tmpdir(), prefix));
  const app = path.join(directory, `${name}.app`);
  const dispose = () => fs.rm(directory, { recursive: true, force: true });
  try {
    await fs.chmod(directory, 0o700);
    for (const [index, bytes] of files.entries()) {
      const target = path.join(app, paths[index]!);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, bytes, { mode: index === 0 ? 0o700 : 0o600, flag: "wx" });
    }
    return { executable: path.join(app, paths[0]!), dispose };
  } catch (error) { await dispose(); throw error; }
}
