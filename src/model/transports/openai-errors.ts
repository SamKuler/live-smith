import { ModelRetryableError } from "../connection-error.js";

export interface OpenAIErrorDiagnostic {
  code?: string;
  type?: string;
}

interface OpenAIProviderFailureOptions {
  retryAfterMs?: number;
  unknownIsRetryable?: boolean;
}

const retryableCategories = new Set([
  "provider_failure",
  "rate_limit_error",
  "rate_limit_exceeded",
  "request_timeout",
  "server_error",
  "server_is_overloaded",
  "slow_down",
  "timeout",
]);

const usageLimitCategories = new Set([
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

const rejectedRequestCategories = new Set([
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
  const diagnostic = openAIErrorDiagnostic(value);
  const categories = [diagnostic.code, diagnostic.type].filter(
    (category): category is string => category !== undefined,
  );
  const fields = [
    ...(diagnostic.code ? [`code=${diagnostic.code}`] : []),
    ...(diagnostic.type ? [`type=${diagnostic.type}`] : []),
  ];
  const message = (summary: string): string => fields.length === 0
    ? summary
    : `${summary} [${fields.join("; ")}]`;
  if (categories.includes("context_length_exceeded")) {
    return new Error(message(`${label} context window was exceeded.`));
  }
  if (categories.includes("usage_not_included")) {
    return new Error(message(`${label} usage is not included for this account.`));
  }
  if (categories.some((category) => usageLimitCategories.has(category))) {
    return new Error(message(`${label} account usage limit was reached.`));
  }
  if (categories.some((category) => rejectedRequestCategories.has(category))) {
    return new Error(message(`${label} rejected the request.`));
  }
  if (categories.some((category) => retryableCategories.has(category))) {
    return new ModelRetryableError(
      message(`${label} reported a retryable failure.`),
      options.retryAfterMs,
    );
  }
  if (options.unknownIsRetryable) {
    return new ModelRetryableError(
      message(`${label} reported a retryable failure.`),
      options.retryAfterMs,
    );
  }
  return new Error(message(`${label} failed.`));
}

export function openAIErrorDiagnostic(value: unknown): OpenAIErrorDiagnostic {
  const record = isRecord(value) ? value : undefined;
  const error = isRecord(record?.error) ? record.error : record;
  const code = openAICanonicalErrorCode(error?.code);
  const type = error?.type === "error"
    ? undefined
    : openAICanonicalErrorCode(error?.type);
  return {
    ...(code === undefined ? {} : { code }),
    ...(type === undefined ? {} : { type }),
  };
}

function openAICanonicalErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
