import * as esbuild from "esbuild";

export async function buildClientScript(entryPoint: string, production: boolean): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: production,
    write: false,
    logLevel: "silent",
  });
  const script = result.outputFiles?.[0]?.text;
  if (!script || /<\/script/iu.test(script)) {
    throw new Error(`Client build for ${entryPoint} produced invalid JavaScript.`);
  }
  return script;
}
