export function shouldOpenSettingsForAgentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return isConfigurationError(message);
}

export function sessionErrorMessage(
  error: unknown,
  secrets: string[] = [],
): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(
      /(api[-_ ]?key|authorization)(\s*[=:]\s*)[^\s,;]+/gi,
      "$1$2[redacted]",
    );
}

function isConfigurationError(message: string): boolean {
  return /api key|active profile|model profile|profile validation|settings/i.test(message);
}
