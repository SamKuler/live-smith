import * as esbuild from "esbuild";

/** The parser runs under Node's own worker runtime, outside the host's restricted VM. */
export async function buildDocumentParserScript(production: boolean): Promise<string> {
  const result = await esbuild.build({
    entryPoints: ["src/attachments/office-parser.worker.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    minify: production,
    metafile: true,
    legalComments: "inline",
    // The slim bundle includes its module graph. Disable its optional native
    // resolver so parsing never searches for a runtime node_modules directory.
    define: { require: "undefined" },
  });
  const script = result.outputFiles?.[0]?.text;
  if (!script) throw new Error("Document parser build produced no JavaScript.");
  const parserInputs = Object.keys(result.metafile!.inputs).filter((name) => name.includes("node_modules/officeparser/"));
  if (parserInputs.length !== 1 || !parserInputs[0]!.endsWith("/dist/officeparser.browser.slim.mjs")) {
    throw new Error("Document parsing must bundle the self-contained officeparser slim distribution.");
  }
  return script;
}
