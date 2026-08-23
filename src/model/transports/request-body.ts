import { cloneJsonValue } from "../json-clone.js";

const defaultProtectedFields = [
  "model",
  "input",
  "messages",
  "tools",
  "stream",
] as const;

export function mergeExtraBody(
  generated: Record<string, unknown>,
  extraBody: Record<string, unknown> | undefined,
  protectedFields: readonly string[] = defaultProtectedFields,
): Record<string, unknown> {
  const result = cloneJsonValue(generated);
  if (!extraBody) return result;

  for (const key of Object.keys(extraBody)) {
    if (protectedFields.includes(key)) {
      throw new Error(`Extra Body cannot override protected field ${key}.`);
    }
  }
  return deepMerge(result, extraBody);
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = cloneJsonValue(base);
  for (const [key, value] of Object.entries(override)) {
    const previous = Object.hasOwn(result, key) ? result[key] : undefined;
    const merged = isRecord(previous) && isRecord(value)
      ? deepMerge(previous, value)
      : cloneJsonValue(value);
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: merged,
      writable: true,
    });
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
