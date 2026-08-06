import { randomUUID } from "node:crypto";

let fallbackCounter = 0;

const safeStorageIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function createStorageId(prefix: string): string {
  try {
    return `${prefix}_${randomUUID()}`;
  } catch {
    fallbackCounter += 1;
    return `${prefix}_${Date.now().toString(36)}_${fallbackCounter.toString(36)}`;
  }
}

export function isSafeStorageId(value: unknown): value is string {
  return typeof value === "string" && safeStorageIdPattern.test(value);
}

export function requireSafeStorageId(value: string, label: string): string {
  if (!isSafeStorageId(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export function hasUniqueStorageIds(
  values: readonly { readonly id: string }[],
): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
  }
  return true;
}
