import * as esbuild from "esbuild";

export async function buildPluginAppsScript(production: boolean): Promise<string> {
  const result = await esbuild.build({
    entryPoints: ["src/ui/client/plugin-apps.ts"], bundle: true, format: "iife", platform: "browser",
    target: "es2020", minify: production, write: false, logLevel: "silent",
  });
  const script = result.outputFiles?.[0]?.text;
  if (!script || /<\/script/iu.test(script)) throw new Error("Plugin apps client build produced invalid JavaScript.");
  return script;
}
