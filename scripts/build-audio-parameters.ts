import * as esbuild from "esbuild";

export async function buildAudioParametersScript(production: boolean): Promise<string> {
  const result = await esbuild.build({
    entryPoints: ["src/ui/client/audio-parameters.ts"], bundle: true, format: "iife", platform: "browser",
    target: "es2020", minify: production, write: false, logLevel: "silent",
  });
  const script = result.outputFiles?.[0]?.text;
  if (!script || /<\/script/iu.test(script)) throw new Error("Audio parameters client build produced invalid JavaScript.");
  return script;
}
