import * as esbuild from "esbuild";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { argv, pid as processId } from "node:process";
import * as vm from "node:vm";
import ts from "typescript";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8")) as {
  entry: string;
};
const production = argv.includes("--production");

verifySourceRuntimeBoundaries("src");

const buildResult = await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
  loader: { ".html": "text" },
});

const outputFiles = buildResult.outputFiles ?? [];
const entryOutput = outputFiles.find((output) =>
  path.normalize(output.path) === path.normalize(path.resolve(manifest.entry))
);
if (!entryOutput) throw new Error(`Build did not produce ${manifest.entry}.`);
const bundle = entryOutput.text;

verifyBundleDoesNotUseUnsupportedGlobals(bundle, manifest.entry);
verifyBundleEntrypointLoads(bundle, manifest.entry);
writeVerifiedBuildOutputs(outputFiles, production ? `${manifest.entry}.map` : undefined);

function verifySourceRuntimeBoundaries(sourceDirectory: string): void {
  const violations: string[] = [];
  for (const file of sourceFiles(sourceDirectory)) {
    if (file.endsWith(".test.ts")) continue;
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const hasNodeUrl = hasNamedImport(source, "node:url", "URL", "URL");
    const hasNodeBuffer = hasNamedImport(source, "node:buffer", "Buffer", "Buffer");
    const hasNodeProcess = hasDefaultImport(source, "node:process", "process");
    const isHostBoundary = path.normalize(file) === path.normalize("src/runtime/host.ts");

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === "structuredClone") {
        const message = `${file}: structuredClone is a reserved unsupported identifier`;
        if (!violations.includes(message)) violations.push(message);
      }
      if (isStructuredCloneElementAccess(node)) {
        const message = `${file}: computed structuredClone access is unsupported`;
        if (!violations.includes(message)) violations.push(message);
      }
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) {
          if (node.expression.text === "fetch" && !isHostBoundary) {
            violations.push(`${file}: resolve fetch through src/runtime/host.ts`);
          }
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "throwIfAborted"
        ) {
          violations.push(`${file}: use the shared throwIfAborted runtime helper`);
        }
      }

      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === "URL" && !hasNodeUrl) {
          violations.push(`${file}: import URL explicitly from node:url`);
        }
        if (node.expression.text === "AbortController" && !isHostBoundary) {
          violations.push(`${file}: create abort controllers through src/runtime/host.ts`);
        }
      }

      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === "Buffer" && !hasNodeBuffer) {
          violations.push(`${file}: import Buffer explicitly from node:buffer`);
        }
        if (node.expression.text === "process" && !hasNodeProcess) {
          violations.push(`${file}: import process explicitly from node:process`);
        }
        if (
          (node.expression.text === "globalThis" || node.expression.text === "global") &&
          ["URL", "Buffer", "process"].includes(node.name.text)
        ) {
          violations.push(`${file}: do not depend on ambient ${node.name.text}`);
        }
        if (
          (node.expression.text === "globalThis" || node.expression.text === "global") &&
          ["fetch", "AbortController"].includes(node.name.text) &&
          !isHostBoundary
        ) {
          violations.push(`${file}: access ${node.name.text} through src/runtime/host.ts`);
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  if (violations.length) {
    throw new Error(`Extension host compatibility checks failed:\n${violations.join("\n")}`);
  }
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(resolved);
    return entry.isFile() && resolved.endsWith(".ts") ? [resolved] : [];
  });
}

function hasNamedImport(
  source: ts.SourceFile,
  moduleName: string,
  importedName: string,
  localName: string,
): boolean {
  return source.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    return bindings !== undefined &&
      ts.isNamedImports(bindings) && bindings.elements.some((element) =>
      (element.propertyName?.text ?? element.name.text) === importedName &&
      element.name.text === localName
    );
  });
}

function hasDefaultImport(
  source: ts.SourceFile,
  moduleName: string,
  localName: string,
): boolean {
  return source.statements.some((statement) =>
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === moduleName &&
    statement.importClause?.name?.text === localName
  );
}

function verifyBundleDoesNotUseUnsupportedGlobals(
  bundleSource: string,
  filename: string,
): void {
  const source = ts.createSourceFile(
    filename,
    bundleSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let detected = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isIdentifier(node) && node.text === "structuredClone") ||
      isStructuredCloneElementAccess(node)
    ) {
      detected = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (detected) {
    throw new Error("Bundle contains reserved unsupported identifier structuredClone.");
  }
}

function isStructuredCloneElementAccess(node: ts.Node): boolean {
  if (
    !ts.isElementAccessExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    (node.expression.text !== "globalThis" && node.expression.text !== "global")
  ) {
    return false;
  }
  const argument = node.argumentExpression;
  return (
    ts.isStringLiteral(argument) ||
    ts.isNoSubstitutionTemplateLiteral(argument)
  ) && argument.text === "structuredClone";
}

function verifyBundleEntrypointLoads(
  bundleSource: string,
  filename: string,
): void {
  const bundledModule: { exports: Record<string, unknown> } = { exports: {} };
  vm.runInNewContext(
    bundleSource,
    {
      exports: bundledModule.exports,
      module: bundledModule,
      require: createRequire(import.meta.url),
    },
    { filename, timeout: 5_000 },
  );
  if (typeof bundledModule.exports.activate !== "function") {
    throw new Error("Bundle host smoke test did not find the activate export.");
  }
}

function writeVerifiedBuildOutputs(
  outputs: esbuild.OutputFile[],
  staleOutput?: string,
): void {
  const pending = outputs.map((output) => ({
    output,
    temporary: `${output.path}.${processId}.tmp`,
  }));
  try {
    for (const { output, temporary } of pending) {
      fs.mkdirSync(path.dirname(output.path), { recursive: true });
      fs.writeFileSync(temporary, output.contents);
    }
    for (const { output, temporary } of pending.sort((left, right) =>
      Number(left.output.path === path.resolve(manifest.entry)) -
      Number(right.output.path === path.resolve(manifest.entry))
    )) {
      fs.renameSync(temporary, output.path);
    }
    if (staleOutput) fs.rmSync(staleOutput, { force: true });
  } finally {
    for (const { temporary } of pending) fs.rmSync(temporary, { force: true });
  }
}
