import * as esbuild from "esbuild";

export async function buildMarkdownRendererScript(
  production: boolean,
): Promise<string> {
  const result = await esbuild.build({
    entryPoints: ["src/ui/client/markdown-renderer.ts"],
    bundle: true,
    format: "iife",
    logLevel: "silent",
    minify: production,
    platform: "browser",
    target: "es2020",
    write: false,
  });
  const script = result.outputFiles?.[0]?.text;
  if (!script) throw new Error("Markdown client build produced no JavaScript.");
  if (/<\/script/i.test(script)) {
    throw new Error("Markdown client build contains an unsafe script terminator.");
  }
  return script;
}
