import {
  profileApiMode,
  profileProvider,
  profileSecrets,
  type DraftProfile,
  type SavedProfile,
} from "../profile.js";

export async function withTransportContext<T>(
  profile: DraftProfile | SavedProfile,
  operation: "request" | "model discovery",
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const rawMessage = cause instanceof Error ? cause.message : String(cause);
    const message = redactTransportMessage(rawMessage, profileSecrets(profile));
    const apiMode = profileApiMode(profile);
    const context = apiMode
      ? `${profileProvider(profile)}/${apiMode}`
      : `${profileProvider(profile)}/${profile.connection.kind}`;
    throw new Error(
      `${context} ${operation} failed: ${message}`,
    );
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
