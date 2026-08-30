export function providerRetryAfterMs(
  headers: Headers,
): number | undefined {
  const milliseconds = parseDelay(headers.get("retry-after-ms"), 1);
  if (milliseconds !== undefined) return milliseconds;
  return parseDelay(headers.get("retry-after"), 1_000);
}

function parseDelay(value: string | null, multiplier: number): number | undefined {
  if (value === null || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    return undefined;
  }
  const milliseconds = Math.ceil(Number(value) * multiplier);
  if (!Number.isFinite(milliseconds)) return undefined;
  return milliseconds;
}
