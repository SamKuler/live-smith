import * as esbuild from "esbuild";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { argv, stdout } from "node:process";
import { fileURLToPath, URL } from "node:url";
import { strToU8, zipSync } from "fflate/browser";

const fixtureDirectory = fileURLToPath(new URL("../test-fixtures/plugins/mcp-app/", import.meta.url));
const packageFiles = ["plugin.json", "mcp.json", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json", "server.mjs"];

export async function buildPluginAppExample(): Promise<Uint8Array> {
  const build = await esbuild.build({
    entryPoints: [path.join(fixtureDirectory, "app.ts")], bundle: true, platform: "browser", format: "iife",
    target: "es2020", minify: true, write: false, logLevel: "silent", legalComments: "inline",
  });
  const script = build.outputFiles[0]?.text;
  if (!script || /<\/script/iu.test(script)) throw new Error("MCP App example produced unsafe inline JavaScript.");
  const template = await fs.readFile(path.join(fixtureDirectory, "app.html"), "utf8");
  if (template.split("__MCP_APP_SCRIPT__").length !== 2) throw new Error("MCP App example template must contain one script marker.");
  const files = Object.fromEntries(await Promise.all(packageFiles.map(async (name) =>
    [name, await fs.readFile(path.join(fixtureDirectory, name))] as const)));
  const notices = await fs.readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url));
  return zipSync({ ...files, "THIRD_PARTY_NOTICES.md": notices,
    "app.html": strToU8(template.replace("__MCP_APP_SCRIPT__", () => script)) }, { level: 6 });
}

if (argv[1] && path.resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.resolve(argv[2] ?? "/private/tmp/live-smith-mcp-app.zip");
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, await buildPluginAppExample());
  stdout.write(`MCP Apps example: ${output}\n`);
}
