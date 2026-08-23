import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";

const resolutionErrorMessage = "Codex executable unavailable.";

interface CodexTarget {
  readonly executableName: "codex" | "codex.exe";
  readonly packageName: string;
  readonly packageVersionSuffix: string;
  readonly targetTriple: string;
}

interface LocatedCommand {
  readonly entryPath: string;
  readonly realPath: string;
}

interface OfficialCodexPackage {
  readonly launcher: string;
  readonly version: string;
}

export class CodexExecutableUnavailableError extends Error {
  constructor() {
    super(resolutionErrorMessage);
    this.name = "CodexExecutableUnavailableError";
  }
}

export type CodexExecutableResolutionImplementation = (
  environment: NodeJS.ProcessEnv,
  workingDirectory: string,
) => Promise<string>;

export async function resolveCodexExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory: string = process.cwd(),
): Promise<string> {
  try {
    const target = codexTarget(process.platform, process.arch);
    const command = await findPathCommand(environment, workingDirectory);
    if (await isNativeExecutable(command.realPath)) {
      throw new Error("opaque native Codex command");
    }
    const packageRoot = await officialPackageRoot(command);
    const metadata = await readOfficialPackage(packageRoot, target);
    if (command.realPath !== metadata.launcher && process.platform !== "win32") {
      throw new Error("untrusted Codex launcher");
    }
    return await resolvePackageNative(packageRoot, metadata, target);
  } catch {
    throw new CodexExecutableUnavailableError();
  }
}

async function findPathCommand(
  environment: NodeJS.ProcessEnv,
  workingDirectory: string,
): Promise<LocatedCommand> {
  const pathValue = environment.PATH;
  if (pathValue === undefined) throw new Error("missing PATH");
  const extensions = process.platform === "win32"
    ? windowsPathExtensions(environment.PATHEXT)
    : [""];
  for (const directoryEntry of pathValue.split(path.delimiter)) {
    const directory = path.resolve(workingDirectory, directoryEntry || ".");
    const commandBase = path.join(directory, "codex");
    for (const extension of extensions) {
      const entryPath = `${commandBase}${extension}`;
      try {
        const metadata = await fs.stat(entryPath);
        if (!metadata.isFile()) continue;
        await fs.access(
          entryPath,
          process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
        );
        return { entryPath, realPath: await fs.realpath(entryPath) };
      } catch {
        // Match executable lookup by continuing to the next PATH candidate.
      }
    }
  }
  throw new Error("missing Codex command");
}

function windowsPathExtensions(pathExt: string | undefined): readonly string[] {
  const extensions = (pathExt ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => /^\.[A-Za-z0-9]+$/u.test(value));
  if (extensions.length === 0) throw new Error("invalid PATHEXT");
  return extensions;
}

async function resolvePackageNative(
  packageRoot: string,
  packageMetadata: OfficialCodexPackage,
  target: CodexTarget,
): Promise<string> {
  const platformPackageRoot = await installedPlatformPackageRoot(
    packageRoot,
    target,
  );
  const vendorOwner = platformPackageRoot ?? packageRoot;
  if (platformPackageRoot !== undefined) {
    const platformPackageJson = path.join(platformPackageRoot, "package.json");
    const platformMetadata = await readJson(platformPackageJson);
    if (!isRecord(platformMetadata) ||
      platformMetadata.name !== "@openai/codex" ||
      platformMetadata.version !==
        `${packageMetadata.version}-${target.packageVersionSuffix}`
    ) {
      throw new Error("untrusted Codex platform package");
    }
  }

  const executable = await fs.realpath(path.join(
    vendorOwner,
    "vendor",
    target.targetTriple,
    "bin",
    target.executableName,
  ));
  if (!isWithin(vendorOwner, executable)) {
    throw new Error("untrusted Codex executable path");
  }
  await fs.access(
    executable,
    process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
  );
  if (!(await fs.stat(executable)).isFile() ||
    !(await isNativeExecutable(executable))
  ) {
    throw new Error("invalid Codex executable");
  }
  return executable;
}

async function installedPlatformPackageRoot(
  packageRoot: string,
  target: CodexTarget,
): Promise<string | undefined> {
  const packageSegments = target.packageName.split("/");
  const packageDirectoryName = target.packageName.slice("@openai/".length);
  const candidates = [
    {
      boundary: packageRoot,
      root: path.join(packageRoot, "node_modules", ...packageSegments),
    },
    {
      boundary: path.dirname(packageRoot),
      root: path.join(path.dirname(packageRoot), packageDirectoryName),
    },
  ];
  for (const candidate of candidates) {
    let platformPackageRoot: string;
    try {
      platformPackageRoot = await fs.realpath(candidate.root);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    if (!isWithin(candidate.boundary, platformPackageRoot)) {
      throw new Error("untrusted Codex platform package path");
    }
    const platformPackageJson = await fs.realpath(path.join(
      platformPackageRoot,
      "package.json",
    ));
    if (path.dirname(platformPackageJson) !== platformPackageRoot) {
      throw new Error("untrusted Codex platform package metadata");
    }
    return platformPackageRoot;
  }
  return undefined;
}

async function officialPackageRoot(command: LocatedCommand): Promise<string> {
  if (path.basename(command.realPath) === "codex.js" &&
    path.basename(path.dirname(command.realPath)) === "bin"
  ) {
    const packageRoot = path.dirname(path.dirname(command.realPath));
    const globalPackageRoot = await fs.realpath(path.join(
      path.dirname(path.dirname(command.entryPath)),
      "lib",
      "node_modules",
      "@openai",
      "codex",
    ));
    if (packageRoot !== globalPackageRoot) {
      throw new Error("unsupported local Codex launcher");
    }
    return packageRoot;
  }
  if (process.platform !== "win32" ||
    path.basename(command.entryPath).toLowerCase() !== "codex.cmd"
  ) {
    throw new Error("untrusted Codex wrapper");
  }
  // A Windows command shim is never executed. It only selects the exact
  // standard npm package rooted beside that PATH entry; other shim layouts fail.
  return await fs.realpath(path.join(
    path.dirname(command.entryPath),
    "node_modules",
    "@openai",
    "codex",
  ));
}

async function readOfficialPackage(
  packageRoot: string,
  target: CodexTarget,
): Promise<OfficialCodexPackage> {
  const packageJson = await readJson(path.join(packageRoot, "package.json"));
  if (!isRecord(packageJson) ||
    packageJson.name !== "@openai/codex" ||
    typeof packageJson.version !== "string" ||
    !/^0\.148\.\d+$/u.test(packageJson.version) ||
    !isRecord(packageJson.bin) ||
    packageJson.bin.codex !== "bin/codex.js" ||
    !isRecord(packageJson.optionalDependencies) ||
    packageJson.optionalDependencies[target.packageName] !==
      `npm:@openai/codex@${packageJson.version}-${target.packageVersionSuffix}`
  ) {
    throw new Error("untrusted Codex package");
  }
  return {
    launcher: await fs.realpath(path.join(packageRoot, "bin", "codex.js")),
    version: packageJson.version,
  };
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

async function isNativeExecutable(filePath: string): Promise<boolean> {
  const file = await fs.open(filePath, "r");
  try {
    const signature = Buffer.alloc(4);
    const { bytesRead } = await file.read(signature, 0, signature.length, 0);
    if (bytesRead >= 2 && signature[0] === 0x4d && signature[1] === 0x5a) {
      return true;
    }
    if (bytesRead < 4) return false;
    return new Set([
      "7f454c46",
      "feedface",
      "feedfacf",
      "cefaedfe",
      "cffaedfe",
      "cafebabe",
      "bebafeca",
      "cafebabf",
      "bfbafeca",
    ]).has(signature.toString("hex"));
  } finally {
    await file.close();
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function codexTarget(platform: NodeJS.Platform, arch: string): CodexTarget {
  const architecture = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : undefined;
  if (architecture === undefined) throw new Error("unsupported Codex architecture");
  const platformName = platform === "android" ? "linux" : platform;
  if (platformName !== "linux" && platformName !== "darwin" &&
    platformName !== "win32"
  ) {
    throw new Error("unsupported Codex platform");
  }
  const targetArchitecture = architecture === "x64" ? "x86_64" : "aarch64";
  const targetTriple = platformName === "linux"
    ? `${targetArchitecture}-unknown-linux-musl`
    : platformName === "darwin"
      ? `${targetArchitecture}-apple-darwin`
      : `${targetArchitecture}-pc-windows-msvc`;
  return {
    executableName: platformName === "win32" ? "codex.exe" : "codex",
    packageName: `@openai/codex-${platformName}-${architecture}`,
    packageVersionSuffix: `${platformName}-${architecture}`,
    targetTriple,
  };
}
