import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import {
  CodexExecutableUnavailableError,
  resolveCodexExecutable,
} from "./codex-executable.js";

test("official npm Codex 0.148 resolves to its optional-dependency native executable", async (t) => {
  const install = await createOfficialInstall(t);

  const resolved = await resolveCodexExecutable(pathEnvironment(
    install.pathDirectory,
  ));

  assert.equal(resolved, await fs.realpath(install.nativeExecutable));
  assert.notEqual(resolved, await fs.realpath(install.launcher));
  assert.notEqual(resolved, await fs.realpath(install.pathCommand));
});

test("an opaque native PATH shim fails closed despite a native file signature", async (t) => {
  const directory = await temporaryDirectory(t, "live-smith-native-shim-");
  const executable = path.join(directory, pathCommandName("native"));
  await writeNativeExecutable(executable);
  await assertUnavailable(
    resolveCodexExecutable(pathEnvironment(directory, true)),
    directory,
  );
});

test("an untrusted first PATH wrapper fails closed instead of falling through", async (t) => {
  const wrapperDirectory = await temporaryDirectory(t, "live-smith-untrusted-codex-");
  const laterInstall = await createOfficialInstall(t);
  const nativeDirectory = path.dirname(laterInstall.nativeExecutable);
  const wrapper = path.join(wrapperDirectory, pathCommandName("wrapper"));
  await fs.writeFile(wrapper, "#!/bin/sh\n/private/raw-wrapper-path\n");
  await fs.chmod(wrapper, 0o755);

  await assertUnavailable(
    resolveCodexExecutable(pathEnvironment(
      [wrapperDirectory, nativeDirectory].join(path.delimiter),
    )),
    wrapperDirectory,
    "/private/raw-wrapper-path",
  );
});

test("a local npm bin fails closed outside the supported global install", async (t) => {
  const install = await createOfficialInstall(t, { installationScope: "local" });
  await assertUnavailable(
    resolveCodexExecutable(pathEnvironment(install.pathDirectory)),
    install.installRoot,
  );
});

test("a missing optional native package fails without exposing installation paths", async (t) => {
  const install = await createOfficialInstall(t, {
    includeNative: false,
    nativeLayout: "base",
  });
  await assertUnavailable(
    resolveCodexExecutable(pathEnvironment(install.pathDirectory)),
    install.installRoot,
  );
});

test("the official base-package vendor fallback resolves its native executable", async (t) => {
  const install = await createOfficialInstall(t, { nativeLayout: "base" });
  assert.equal(
    await resolveCodexExecutable(pathEnvironment(install.pathDirectory)),
    await fs.realpath(install.nativeExecutable),
  );
});

test("the base vendor cannot be displaced by a platform package on NODE_PATH", async (t) => {
  const install = await createOfficialInstall(t, { nativeLayout: "base" });
  const externalRoot = await temporaryDirectory(t, "live-smith-external-codex-");
  const target = currentCodexTarget();
  const externalPackageRoot = path.join(
    externalRoot,
    "node_modules",
    ...target.packageName.split("/"),
  );
  const externalNative = path.join(
    externalPackageRoot,
    "vendor",
    target.targetTriple,
    "bin",
    target.executableName,
  );
  await fs.mkdir(externalPackageRoot, { recursive: true });
  await fs.writeFile(path.join(externalPackageRoot, "package.json"), JSON.stringify({
    name: "@openai/codex",
    version: `0.148.0-${target.packageVersionSuffix}`,
  }));
  await writeNativeExecutable(externalNative);

  const moduleUrl = new URL("./codex-executable.ts", import.meta.url).href;
  const script = `
    const { resolveCodexExecutable } = await import(${JSON.stringify(moduleUrl)});
    const resolved = await resolveCodexExecutable({
      PATH: process.env.LIVE_SMITH_TEST_PATH,
      PATHEXT: process.env.LIVE_SMITH_TEST_PATHEXT,
    });
    process.stdout.write(resolved);
  `;
  const resolved = execFileSync(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    script,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      LIVE_SMITH_TEST_PATH: install.pathDirectory,
      LIVE_SMITH_TEST_PATHEXT: ".CMD;.EXE",
      NODE_PATH: path.join(externalRoot, "node_modules"),
    },
  });

  assert.equal(resolved, await fs.realpath(install.nativeExecutable));
  assert.notEqual(resolved, await fs.realpath(externalNative));
});

test("an official hoisted optional dependency resolves through the launcher", async (t) => {
  const install = await createOfficialInstall(t, {
    optionalPlacement: "hoisted",
  });
  assert.equal(
    await resolveCodexExecutable(pathEnvironment(install.pathDirectory)),
    await fs.realpath(install.nativeExecutable),
  );
});

test("relative PATH entries resolve from the child working directory", async (t) => {
  const install = await createOfficialInstall(t);
  const relativePath = path.relative(install.installRoot, install.pathDirectory);
  assert.equal(
    await resolveCodexExecutable(
      pathEnvironment(relativePath),
      install.installRoot,
    ),
    await fs.realpath(install.nativeExecutable),
  );
});

test("an npm launcher outside the required 0.148 line fails closed", async (t) => {
  const install = await createOfficialInstall(t, { version: "0.149.0" });
  await assertUnavailable(
    resolveCodexExecutable(pathEnvironment(install.pathDirectory)),
    install.installRoot,
  );
});

interface FakeInstallOptions {
  includeNative?: boolean;
  installationScope?: "global" | "local";
  nativeLayout?: "base" | "optional";
  optionalPlacement?: "hoisted" | "nested";
  version?: string;
}

async function createOfficialInstall(
  t: TestContext,
  options: FakeInstallOptions = {},
): Promise<{
  installRoot: string;
  launcher: string;
  nativeExecutable: string;
  pathCommand: string;
  pathDirectory: string;
}> {
  const target = currentCodexTarget();
  const version = options.version ?? "0.148.0";
  const nativeLayout = options.nativeLayout ?? "optional";
  const installRoot = await temporaryDirectory(t, "live-smith-codex-package-");
  const localInstall = options.installationScope === "local";
  const pathDirectory = localInstall
    ? path.join(installRoot, "node_modules", ".bin")
    : process.platform === "win32"
      ? installRoot
      : path.join(installRoot, "bin");
  const packageRoot = localInstall
    ? path.join(installRoot, "node_modules", "@openai", "codex")
    : process.platform === "win32"
      ? path.join(installRoot, "node_modules", "@openai", "codex")
      : path.join(installRoot, "lib", "node_modules", "@openai", "codex");
  const launcher = path.join(packageRoot, "bin", "codex.js");
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  await fs.mkdir(pathDirectory, { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@openai/codex",
    version,
    bin: { codex: "bin/codex.js" },
    optionalDependencies: {
      [target.packageName]:
        `npm:@openai/codex@${version}-${target.packageVersionSuffix}`,
    },
  }));
  await fs.writeFile(launcher, "#!/usr/bin/env node\n");
  await fs.chmod(launcher, 0o755);

  const pathCommand = path.join(pathDirectory, pathCommandName("wrapper"));
  if (process.platform === "win32") {
    await fs.writeFile(
      pathCommand,
      "@node node_modules\\@openai\\codex\\bin\\codex.js %*\r\n",
    );
  } else {
    await fs.symlink(launcher, pathCommand, "file");
  }

  const platformPackageRoot = nativeLayout === "base"
    ? packageRoot
    : options.optionalPlacement === "hoisted"
      ? path.join(
          path.dirname(packageRoot),
          target.packageName.slice("@openai/".length),
        )
      : path.join(packageRoot, "node_modules", ...target.packageName.split("/"));
  const nativeExecutable = path.join(
    platformPackageRoot,
    "vendor",
    target.targetTriple,
    "bin",
    target.executableName,
  );
  await fs.mkdir(path.dirname(nativeExecutable), { recursive: true });
  if (nativeLayout === "optional") {
    await fs.writeFile(path.join(platformPackageRoot, "package.json"), JSON.stringify({
      name: "@openai/codex",
      version: `${version}-${target.packageVersionSuffix}`,
      os: [target.packageOs],
      cpu: [process.arch],
    }));
  }
  if (options.includeNative !== false) {
    await writeNativeExecutable(nativeExecutable);
  }
  return {
    installRoot,
    launcher,
    nativeExecutable,
    pathCommand,
    pathDirectory,
  };
}

async function writeNativeExecutable(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, nativeExecutableSignature());
  await fs.chmod(filePath, 0o755);
}

function pathCommandName(kind: "native" | "wrapper"): string {
  if (process.platform !== "win32") return "codex";
  return kind === "native" ? "codex.exe" : "codex.cmd";
}

function pathEnvironment(
  pathValue: string,
  preferNative = false,
): NodeJS.ProcessEnv {
  return {
    PATH: pathValue,
    PATHEXT: preferNative ? ".EXE;.CMD" : ".CMD;.EXE",
  };
}

async function temporaryDirectory(
  t: TestContext,
  prefix: string,
): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function assertUnavailable(
  resolution: Promise<string>,
  ...rawValues: readonly string[]
): Promise<void> {
  await assert.rejects(resolution, (error: unknown) => {
    assert.equal(error instanceof CodexExecutableUnavailableError, true);
    assert.equal(
      error instanceof Error && error.message,
      "Codex executable unavailable.",
    );
    for (const rawValue of rawValues) {
      assert.equal(String(error).includes(rawValue), false);
    }
    return true;
  });
}

interface TestCodexTarget {
  readonly executableName: "codex" | "codex.exe";
  readonly packageName: string;
  readonly packageOs: "darwin" | "linux" | "win32";
  readonly packageVersionSuffix: string;
  readonly targetTriple: string;
}

function currentCodexTarget(): TestCodexTarget {
  const architecture = process.arch === "x64" ? "x64" : "arm64";
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error("unsupported test architecture");
  }
  if (process.platform === "darwin") {
    return {
      executableName: "codex",
      packageName: `@openai/codex-darwin-${architecture}`,
      packageOs: "darwin",
      packageVersionSuffix: `darwin-${architecture}`,
      targetTriple: architecture === "x64"
        ? "x86_64-apple-darwin"
        : "aarch64-apple-darwin",
    };
  }
  if (process.platform === "linux" || process.platform === "android") {
    return {
      executableName: "codex",
      packageName: `@openai/codex-linux-${architecture}`,
      packageOs: "linux",
      packageVersionSuffix: `linux-${architecture}`,
      targetTriple: architecture === "x64"
        ? "x86_64-unknown-linux-musl"
        : "aarch64-unknown-linux-musl",
    };
  }
  if (process.platform === "win32") {
    return {
      executableName: "codex.exe",
      packageName: `@openai/codex-win32-${architecture}`,
      packageOs: "win32",
      packageVersionSuffix: `win32-${architecture}`,
      targetTriple: architecture === "x64"
        ? "x86_64-pc-windows-msvc"
        : "aarch64-pc-windows-msvc",
    };
  }
  throw new Error("unsupported test platform");
}

function nativeExecutableSignature(): Buffer {
  if (process.platform === "win32") return Buffer.from([0x4d, 0x5a, 0, 0]);
  if (process.platform === "darwin") {
    return Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
  }
  return Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
}
