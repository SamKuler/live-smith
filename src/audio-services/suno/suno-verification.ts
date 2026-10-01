export type SunoCaptchaVersion = 1 | 2;

/** Transient private proof, never part of a persisted job or public projection. */
export interface SunoVerificationProof {
  captchaVersion: SunoCaptchaVersion;
  token: string;
  issuedAtMs: number;
}

export type SunoHumanVerificationHandler = (
  captchaVersion: SunoCaptchaVersion, signal: AbortSignal,
) => Promise<SunoVerificationProof>;

const failureMessages = {
  "cancelled": "Verification cancelled. No generation was submitted.",
  "unsupported-platform": "In-app Suno verification requires macOS 14 or later. No generation was submitted.",
  "unsupported-domain": "Suno verification rejected the page hostname. No generation was submitted.",
  "unsupported-environment": "Official verification is unavailable in this environment. No generation was submitted.",
  "network-unavailable": "The verification network route is unavailable. No generation was submitted.",
  "page-load-timeout": "The official verification page timed out. No generation was submitted.",
  "page-load-error": "The official verification page could not be loaded. No generation was submitted.",
  "setup-error": "The in-app verification window could not be opened. No generation was submitted.",
  "invalid-request": "The verification request is invalid. No generation was submitted.",
  "invalid-result": "The verification result is invalid or expired. No generation was submitted.",
  "verification-timeout": "Verification timed out. No generation was submitted.",
} as const;
export type SunoVerificationFailureCode = keyof typeof failureMessages;
export function isSunoVerificationFailureCode(value: unknown): value is SunoVerificationFailureCode {
  return typeof value === "string" && Object.hasOwn(failureMessages, value);
}
/** Only this bounded local message may cross the private broker boundary. */
export class SunoVerificationError extends Error {
  constructor(readonly code: SunoVerificationFailureCode) {
    super(failureMessages[code]);
    this.name = code === "cancelled" ? "AbortError" : "SunoVerificationError";
  }
}

export function readSunoVerificationProof(value: unknown, version: SunoCaptchaVersion): SunoVerificationProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid verification result.");
  const proof = value as Record<string, unknown>;
  if (Object.keys(proof).length !== 3 || proof.captchaVersion !== version ||
      typeof proof.token !== "string" || !proof.token.length || proof.token.length > 16_384 ||
      /[\s\u0000-\u001f\u007f]/u.test(proof.token) ||
      typeof proof.issuedAtMs !== "number" || !Number.isSafeInteger(proof.issuedAtMs)) {
    throw new Error("Invalid verification result.");
  }
  const result = { captchaVersion: version, token: proof.token, issuedAtMs: proof.issuedAtMs };
  assertSunoVerificationFresh(result);
  return Object.freeze(result);
}

export function assertSunoVerificationFresh(proof: SunoVerificationProof): void {
  // hCaptcha defaults to 120s; Turnstile uses 300s. Leave time for dispatch.
  const maximumAge = (proof.captchaVersion === 1 ? 120_000 : 300_000) - 30_000;
  const age = Date.now() - proof.issuedAtMs;
  if (age < 0 || age >= maximumAge) throw new Error("Verification expired. No generation was submitted.");
}
