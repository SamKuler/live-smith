import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";

const cli = fileURLToPath(new URL("../../node_modules/@ableton-extensions/cli/dist/cli.mjs", import.meta.url));

test("CLI packaging retains nested assets and exact bytes with the overridden glob dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-smith-cli-package-"));
  try {
    await mkdir(join(directory, "dist"));
    await mkdir(join(directory, "assets", "nested"), { recursive: true });
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ name: "Archive compatibility", version: "1.0.0", entry: "dist/extension.js" }));
    await writeFile(join(directory, "dist/extension.js"), "export const enabled = true;\n");
    await writeFile(join(directory, "assets/nested/音色 sample.txt"), "nested asset\n");
    await writeFile(join(directory, "assets/bytes.bin"), new Uint8Array([0, 1, 128, 255]));
    await writeFile(join(directory, "excluded.txt"), "outside included paths");
    const archive = join(directory, "output.ablx");
    execFileSync(execPath, [cli, "package", directory, "--output", archive, "--include", "assets"], { timeout: 20_000, stdio: "pipe" });
    const files = unzipSync(await readFile(archive));
    const names = Object.keys(files).filter(name => !name.endsWith("/")).sort();
    assert.deepEqual(names, ["assets/bytes.bin", "assets/nested/音色 sample.txt", "dist/extension.js", "manifest.json"]);
    assert.equal(strFromU8(files["dist/extension.js"]!), "export const enabled = true;\n");
    assert.equal(strFromU8(files["assets/nested/音色 sample.txt"]!), "nested asset\n");
    assert.deepEqual(files["assets/bytes.bin"], new Uint8Array([0, 1, 128, 255]));

    const fromCli = createRequire(cli);
    const fromArchiver = createRequire(fromCli.resolve("archiver"));
    const utilities = fromArchiver("archiver-utils");
    assert.deepEqual(utilities.file.expand({ cwd: directory, filter: "isFile" }, ["assets/**/*", "!**/*.bin"]), ["assets/nested/音色 sample.txt"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
