export interface SafeAnthropicError {
  type?: string;
  errorCode?: string;
}

const maximumAnthropicErrorIdentifierLength = 64;
const retryableAnthropicErrorTypes = new Set([
  "api_error",
  "overloaded_error",
  "rate_limit_error",
  "timeout_error",
]);

export function safeAnthropicErrorObject(value: unknown): SafeAnthropicError {
  if (!isRecord(value) || typeof value.message !== "string") return {};
  const type = safeAnthropicIdentifier(value.type);
  const details = isRecord(value.details) ? value.details : undefined;
  const errorCode = safeAnthropicIdentifier(details?.error_code);
  return {
    ...(type ? { type } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

export function anthropicErrorDiagnostic(error: SafeAnthropicError): string {
  const fields = [
    ...(error.type ? [`type=${error.type}`] : []),
    ...(error.errorCode ? [`error_code=${error.errorCode}`] : []),
  ];
  return fields.length ? ` [${fields.join("; ")}]` : "";
}

export function isAnthropicSpendLimitError(error: SafeAnthropicError): boolean {
  return error.type === "rate_limit_error" &&
    error.errorCode === "enforced_spend_limit_reached";
}

export function isAnthropicRetryableError(error: SafeAnthropicError): boolean {
  return error.type !== undefined && retryableAnthropicErrorTypes.has(error.type) &&
    !isAnthropicSpendLimitError(error);
}

export function safeAnthropicIdentifier(value: unknown): string | undefined {
  return typeof value === "string" &&
      value.length <= maximumAnthropicErrorIdentifierLength &&
      /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
