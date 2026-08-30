import { ModelRetryableError } from "../connection-error.js";

interface OpenAIProviderFailureOptions {
  retryAfterMs?: number;
  unknownIsRetryable?: boolean;
}

const retryableCodes = new Set([
  "provider_failure",
  "rate_limit_exceeded",
  "request_timeout",
  "server_error",
  "server_is_overloaded",
  "slow_down",
  "timeout",
]);

const usageLimitCodes = new Set([
  "billing_error",
  "billing_hard_limit_reached",
  "billing_not_active",
  "credit_balance_too_low",
  "credit_balance_exhausted",
  "credits_exhausted",
  "insufficient_quota",
  "organization_quota_exceeded",
  "organization_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "project_spend_limit_exceeded",
  "quota_exceeded",
  "spend_limit_reached",
  "usage_limit_reached",
]);

const rejectedRequestCodes = new Set([
  "authentication_error",
  "bio_policy",
  "content_policy_violation",
  "cyber_policy",
  "invalid_prompt",
  "invalid_request_error",
  "misalignment_policy_violation",
  "permission_error",
]);

export function openAIProviderFailure(
  value: unknown,
  label: string,
  options: OpenAIProviderFailureOptions = {},
): Error {
  const code = openAIErrorCode(value);
  if (code === "context_length_exceeded") {
    return new Error(`${label} context window was exceeded.`);
  }
  if (code === "usage_not_included") {
    return new Error(`${label} usage is not included for this account.`);
  }
  if (code && usageLimitCodes.has(code)) {
    return new Error(`${label} account usage limit was reached.`);
  }
  if (code && rejectedRequestCodes.has(code)) {
    return new Error(`${label} rejected the request.`);
  }
  if (code && retryableCodes.has(code)) {
    return new ModelRetryableError(
      `${label} reported a retryable failure.`,
      options.retryAfterMs,
    );
  }
  if (options.unknownIsRetryable) {
    return new ModelRetryableError(
      `${label} reported a retryable failure.`,
      options.retryAfterMs,
    );
  }
  return new Error(`${label} failed.`);
}

export function openAIErrorCode(value: unknown): string | undefined {
  const record = isRecord(value) ? value : undefined;
  const error = isRecord(record?.error) ? record.error : record;
  return typeof error?.code === "string"
    ? error.code
    : typeof error?.type === "string" && error.type !== "error"
      ? error.type
      : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
