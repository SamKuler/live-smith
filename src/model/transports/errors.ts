import { throwIfAborted } from "../../runtime/host.js";
import { NetworkProxyError } from "../../runtime/network-proxy-error.js";
import {
  ModelAuthenticationError,
  ModelConnectionError,
  ModelRetryableError,
} from "../connection-error.js";
import {
  profileApiMode,
  profileProvider,
  profileSecrets,
  type ModelConnectionOwner,
} from "../profile.js";

export async function withTransportContext<T>(
  profile: ModelConnectionOwner,
  operation: "request" | "model discovery",
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throwIfAborted(signal);
    if (cause instanceof NetworkProxyError) throw cause;
    const rawMessage = cause instanceof Error ? cause.message : String(cause);
    const message = redactTransportMessage(rawMessage, profileSecrets(profile));
    const apiMode = profileApiMode(profile);
    const context = apiMode
      ? `${profileProvider(profile)}/${apiMode}`
      : `${profileProvider(profile)}/${profile.connection.kind}`;
    const contextualMessage = `${context} ${operation} failed: ${message}`;
    if (cause instanceof ModelConnectionError) {
      throw new ModelConnectionError(contextualMessage);
    }
    if (cause instanceof ModelRetryableError) {
      throw new ModelRetryableError(contextualMessage, cause.retryAfterMs);
    }
    if (cause instanceof ModelAuthenticationError) {
      throw new ModelAuthenticationError(contextualMessage);
    }
    throw new Error(contextualMessage);
  }
}

function redactTransportMessage(message: string, secrets: string[]): string {
  let redacted = message.replace(
    /\bhttps?:\/\/[^\s]+/gi,
    redactTransportUrl,
  );
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
}

function redactTransportUrl(value: string): string {
  const privateSuffix = value.search(/[?#]/);
  const publicUrl = privateSuffix < 0 ? value : value.slice(0, privateSuffix);
  return publicUrl.replace(
    /^(https?:\/\/)[^/\s@]+@/i,
    "$1[redacted]@",
  );
}
