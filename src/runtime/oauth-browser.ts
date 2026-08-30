import { execFile } from "node:child_process";
import { win32 as windowsPath } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { URL } from "node:url";

import { throwIfAborted } from "./host.js";

const execFileAsync = promisify(execFile);
const oauthAuthorizationHosts = new Set([
  "accounts.google.com",
  "auth.openai.com",
  "claude.ai",
]);

interface OAuthBrowserOpenerOptions {
  platform?: NodeJS.Platform;
  windowsSystemRoot?: string;
  runOpenCommand?: (
    executable: string,
    args: readonly string[],
    signal?: AbortSignal,
  ) => Promise<void>;
}

export function createOAuthBrowserOpener(
  options: OAuthBrowserOpenerOptions = {},
): (target: string, signal?: AbortSignal) => Promise<void> {
  const platform = options.platform ?? process.platform;
  const windowsSystemRoot = normalizeWindowsSystemRoot(
    options.windowsSystemRoot ?? process.env.SystemRoot,
  );
  const runOpenCommand = options.runOpenCommand ??
    (async (executable, args, signal) => {
      await execFileAsync(executable, [...args], { signal, timeout: 10_000 });
    });

  return async (target, signal) => {
    throwIfAborted(signal);
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new Error("OAuth requires a trusted HTTPS authorization URL.");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !oauthAuthorizationHosts.has(url.hostname)
    ) {
      throw new Error("OAuth requires a trusted HTTPS authorization URL.");
    }
    let executable: string;
    let args: string[];
    if (platform === "darwin") {
      executable = "/usr/bin/open";
      args = [url.toString()];
    } else if (platform === "win32") {
      if (!windowsSystemRoot) {
        throw new Error("The Windows system browser command is unavailable.");
      }
      executable = windowsPath.join(
        windowsSystemRoot,
        "System32",
        "rundll32.exe",
      );
      args = ["url.dll,FileProtocolHandler", url.toString()];
    } else {
      throw new Error(
        "Opening the OAuth browser is available only on macOS and Windows.",
      );
    }
    try {
      await runOpenCommand(executable, args, signal);
    } catch {
      throwIfAborted(signal);
      throw new Error("The OAuth browser could not be opened.");
    }
    throwIfAborted(signal);
  };
}

export const openOAuthAuthorizationUrl = createOAuthBrowserOpener();

function normalizeWindowsSystemRoot(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = value.replaceAll("/", "\\").replace(/\\+$/u, "");
  if (!/^[A-Za-z]:\\[^\\]+(?:\\[^\\]+)*$/u.test(candidate)) {
    return undefined;
  }
  const segments = candidate.slice(3).split("\\");
  if (segments.some((segment) =>
    segment === "." ||
    segment === ".." ||
    segment.includes(":") ||
    /[\u0000-\u001f]/u.test(segment) ||
    /[. ]$/u.test(segment)
  )) {
    return undefined;
  }
  const normalized = windowsPath.normalize(candidate);
  return normalized === candidate ? normalized : undefined;
}
