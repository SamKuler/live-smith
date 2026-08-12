import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const maximumLinesPerTestFile = 4_000;
const maximumTestDeclarationsPerFile = 80;

const violations: string[] = [];
for (const filePath of testFilesUnder("src")) {
  const source = readFileSync(filePath, "utf8");
  const lineCount = source.split(/\r?\n/u).length;
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const testCount = countNodeTestDeclarations(sourceFile);
  if (lineCount > maximumLinesPerTestFile) {
    violations.push(
      `${filePath} has ${lineCount} lines; split it below ${maximumLinesPerTestFile}.`,
    );
  }
  if (testCount > maximumTestDeclarationsPerFile) {
    violations.push(
      `${filePath} has ${testCount} test declarations; split it below ${maximumTestDeclarationsPerFile}.`,
    );
  }
}

function countNodeTestDeclarations(sourceFile: ts.SourceFile): number {
  const testBindings = new Set<string>();
  const nodeTestNamespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "node:test") {
      continue;
    }
    const importClause = statement.importClause;
    if (importClause?.name) testBindings.add(importClause.name.text);
    const bindings = importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      nodeTestNamespaces.add(bindings.name.text);
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (["it", "test"].includes(
          element.propertyName?.text ?? element.name.text,
        )) {
          testBindings.add(element.name.text);
        }
      }
    }
  }

  let count = 0;
  const visit = (node: ts.Node, testContextBindings: ReadonlySet<string>): void => {
    let callback: ts.ArrowFunction | ts.FunctionExpression | undefined;
    let callbackTestContexts = testContextBindings;
    if (
      ts.isCallExpression(node) &&
      isNodeTestCall(node.expression, testContextBindings)
    ) {
      count += 1;
      callback = [...node.arguments].reverse().find(
        (argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
          ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
      );
      const contextParameter = callback?.parameters[0]?.name;
      if (contextParameter && ts.isIdentifier(contextParameter)) {
        callbackTestContexts = new Set([
          ...testContextBindings,
          contextParameter.text,
        ]);
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, child === callback ? callbackTestContexts : testContextBindings);
    });
  };
  const isNodeTestCall = (
    expression: ts.Expression,
    testContextBindings: ReadonlySet<string>,
  ): boolean => {
    if (ts.isIdentifier(expression)) return testBindings.has(expression.text);
    if (!ts.isPropertyAccessExpression(expression)) return false;
    if (ts.isIdentifier(expression.expression) &&
      nodeTestNamespaces.has(expression.expression.text) &&
      ["it", "test"].includes(expression.name.text)) {
      return true;
    }
    if (ts.isIdentifier(expression.expression) &&
      testContextBindings.has(expression.expression.text) &&
      expression.name.text === "test") {
      return true;
    }
    return isNodeTestCall(expression.expression, testContextBindings) &&
      ["skip", "only", "todo"].includes(expression.name.text);
  };
  visit(sourceFile, new Set());
  return count;
}

if (violations.length > 0) {
  throw new Error(`Test structure check failed:\n${violations.join("\n")}`);
}

function testFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return testFilesUnder(entryPath);
    return entry.name.endsWith(".test.ts") ? [entryPath] : [];
  });
}
