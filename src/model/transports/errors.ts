import type { DraftProfile, SavedProfile } from "../profile.js";

export async function withTransportContext<T>(
  profile: DraftProfile | SavedProfile,
  operation: "request" | "model discovery",
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const rawMessage = cause instanceof Error ? cause.message : String(cause);
    const message = redactTransportMessage(rawMessage, profile.apiKey);
    throw new Error(
      `${profile.apiFamily}/${profile.apiMode} ${operation} failed: ${message}`,
    );
  }
}

function redactTransportMessage(message: string, apiKey: string): string {
  const withoutUrlCredentials = message.replace(
    /\b(https?:\/\/)[^/\s@]+@/gi,
    "$1[redacted]@",
  );
  const withoutKey = apiKey
    ? withoutUrlCredentials.replaceAll(apiKey, "[redacted]")
    : withoutUrlCredentials;
  return withoutKey.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
}
