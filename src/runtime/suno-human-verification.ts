import { stageNativeApp } from "./native-app.js";
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import process from "node:process";
import { normalizeNetworkProxySettings, type NetworkProxySettings } from "../model/profile.js";
import { isSunoVerificationFailureCode, readSunoVerificationProof, SunoVerificationError,
  type SunoCaptchaVersion, type SunoVerificationProof } from "../audio-services/suno/suno-verification.js";
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
  temporaryDirectory?: string;
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
function active(signal: AbortSignal) { if (signal.aborted) throw new SunoVerificationError("cancelled"); }

export function createSunoHumanVerifier(options: VerifierOptions = {}) {
  const platform = options.platform ?? process.platform;
  const capsule = options.capsule ?? (typeof __LIVE_SMITH_NATIVE_VERIFIER_CAPSULE__ === "string" ? __LIVE_SMITH_NATIVE_VERIFIER_CAPSULE__ : "");
  const styles = options.styles ?? (typeof __LIVE_SMITH_SUNO_VERIFICATION_STYLES__ === "string" ? __LIVE_SMITH_SUNO_VERIFICATION_STYLES__ : "");
  const run = options.run ?? runNativeCommand;
  return async (request: NativeSunoVerificationOptions): Promise<SunoVerificationProof> => {
    let app: Awaited<ReturnType<typeof stageNativeApp>> | undefined;
    let direct: Awaited<ReturnType<typeof createNativeVerificationDirectProxy>> | undefined;
    try {
      active(request.signal);
      if (platform !== "darwin") throw new SunoVerificationError("unsupported-platform");
      if (request.captchaVersion !== 1 && request.captchaVersion !== 2) throw new SunoVerificationError("invalid-request");
      const networkProxy = normalizeNetworkProxySettings(request.networkProxy);
      app = await stageNativeApp(capsule, "SunoVerification", "live-smith-verification-", request.temporaryDirectory);
      if (networkProxy.mode === "none") direct = await createNativeVerificationDirectProxy(request.signal);
      active(request.signal);
      const input = JSON.stringify({ protocol: 1, captchaVersion: request.captchaVersion,
        script: buildSunoVerificationScript(request.captchaVersion, request.interfaceLanguage, styles),
        networkProxy: direct ? { mode: "manual", url: direct.url, username: direct.username, password: direct.password } : networkProxy,
        connectionName: String(request.connectionName).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 100),
      });
      const output = await run(app.executable, input, {
        signal: request.signal, timeout: 10 * 60_000, maxBuffer: 65_536, encoding: "utf8",
        env: request.temporaryDirectory === undefined ? {} : { LIVE_SMITH_VERIFIER_TEMP_ROOT: request.temporaryDirectory },
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
      await app?.dispose().catch(() => {});
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
