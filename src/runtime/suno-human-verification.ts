import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { normalizeNetworkProxySettings, type NetworkProxySettings } from "../model/profile.js";
import { isSunoVerificationFailureCode, readSunoVerificationProof, SunoVerificationError,
  type SunoCaptchaVersion, type SunoVerificationProof } from "../audio-services/suno-verification.js";
import { buildSunoVerificationScript } from "../ui/native/suno-verification.js";
import { createNativeVerificationDirectProxy } from "./native-verification-proxy.js";

declare const __LIVE_SMITH_NATIVE_VERIFIER_CAPSULE__: string;
declare const __LIVE_SMITH_SUNO_VERIFICATION_STYLES__: string;

export interface NativeSunoVerificationOptions {
  captchaVersion: SunoCaptchaVersion;
  signal: AbortSignal;
  interfaceLanguage: string;
  networkProxy: NetworkProxySettings;
  connectionName: string;
}
interface NativeCommandOptions {
  signal: AbortSignal;
  timeout: number;
  maxBuffer: number;
  encoding: "utf8";
  env: Record<string, string>;
}
type NativeRunner = (executable: string, input: string, options: NativeCommandOptions) => Promise<string>;
interface VerifierOptions {
  platform?: NodeJS.Platform;
  capsule?: string;
  styles?: string;
  run?: NativeRunner;
}
const appPaths = ["Contents/MacOS/SunoVerification", "Contents/Info.plist", "Contents/_CodeSignature/CodeResources"];
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function active(signal: AbortSignal) { if (signal.aborted) throw new SunoVerificationError("cancelled"); }

export function createSunoHumanVerifier(options: VerifierOptions = {}) {
  const platform = options.platform ?? process.platform;
  const capsule = options.capsule ?? (typeof __LIVE_SMITH_NATIVE_VERIFIER_CAPSULE__ === "string" ? __LIVE_SMITH_NATIVE_VERIFIER_CAPSULE__ : "");
  const styles = options.styles ?? (typeof __LIVE_SMITH_SUNO_VERIFICATION_STYLES__ === "string" ? __LIVE_SMITH_SUNO_VERIFICATION_STYLES__ : "");
  const run = options.run ?? runNativeCommand;
  return async (request: NativeSunoVerificationOptions): Promise<SunoVerificationProof> => {
    let directory: string | undefined;
    let direct: Awaited<ReturnType<typeof createNativeVerificationDirectProxy>> | undefined;
    try {
      active(request.signal);
      if (platform !== "darwin") throw new SunoVerificationError("unsupported-platform");
      if (request.captchaVersion !== 1 && request.captchaVersion !== 2) throw new SunoVerificationError("invalid-request");
      const networkProxy = normalizeNetworkProxySettings(request.networkProxy);
      const data = JSON.parse(capsule) as { version: unknown; files: Array<{ path: string; base64: string; sha256: string }> };
      if (data.version !== 1 || !Array.isArray(data.files) || data.files.length !== appPaths.length) throw new SunoVerificationError("setup-error");
      const files = data.files.map((file, index) => {
        if (!file || file.path !== appPaths[index] || typeof file.base64 !== "string" || file.base64.length > 2_000_000) throw new SunoVerificationError("setup-error");
        const bytes = Buffer.from(file.base64, "base64");
        if (digest(bytes) !== file.sha256) throw new SunoVerificationError("setup-error");
        return { path: file.path, bytes };
      });
      directory = await fs.mkdtemp(path.join(tmpdir(), "live-smith-verification-"));
      await fs.chmod(directory, 0o700);
      const app = path.join(directory, "SunoVerification.app");
      for (const [index, file] of files.entries()) {
        const target = path.join(app, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, file.bytes, { mode: index === 0 ? 0o700 : 0o600, flag: "wx" });
      }
      if (networkProxy.mode === "none") direct = await createNativeVerificationDirectProxy(request.signal);
      active(request.signal);
      const input = JSON.stringify({ protocol: 1, captchaVersion: request.captchaVersion,
        script: buildSunoVerificationScript(request.captchaVersion, request.interfaceLanguage, styles),
        networkProxy: direct ? { mode: "manual", url: direct.url, username: direct.username, password: direct.password } : networkProxy,
        connectionName: String(request.connectionName).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 100),
      });
      const output = await run(path.join(app, appPaths[0]!), input, {
        signal: request.signal, timeout: 10 * 60_000, maxBuffer: 65_536, encoding: "utf8", env: {},
      });
      active(request.signal);
      if (Buffer.byteLength(output) > 65_536) throw new SunoVerificationError("invalid-result");
      const result = JSON.parse(output) as Record<string, unknown>;
      if (!result || Array.isArray(result) || typeof result !== "object") throw new SunoVerificationError("invalid-result");
      if (result.type === "cancelled" && Object.keys(result).length === 1) throw new SunoVerificationError("cancelled");
      if (result.type === "failed" && Object.keys(result).length === 2 && isSunoVerificationFailureCode(result.code)) {
        throw new SunoVerificationError(result.code);
      }
      if (result.type !== "verified" || Object.keys(result).length !== 4) throw new SunoVerificationError("invalid-result");
      try { return readSunoVerificationProof({ captchaVersion: result.captchaVersion, token: result.token,
        issuedAtMs: result.issuedAtMs }, request.captchaVersion); }
      catch { throw new SunoVerificationError("invalid-result"); }
    } catch (error) {
      active(request.signal);
      if (error instanceof SunoVerificationError) throw error;
      throw new SunoVerificationError("setup-error");
    } finally {
      await direct?.close();
      if (directory) {
        try { await fs.rm(directory, { recursive: true, force: true }); }
        catch { /* Only our credential-free capsule is staged; no token is on disk. */ }
      }
    }
  };
}

function runNativeCommand(executable: string, input: string, options: NativeCommandOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, [], options, (error, stdout) => {
      // exec errors can contain stdout (the proof) and stderr; never forward them.
      if (error) reject(new SunoVerificationError(options.signal.aborted ? "cancelled"
        : error.killed ? "verification-timeout" : "setup-error"));
      else resolve(stdout);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

export const runSunoHumanVerification = createSunoHumanVerifier();
