import type { UiMessage } from "../../../i18n/ui-message.js";

export function wireField(value: unknown, key: string): unknown { return isWireRecord(value) ? value[key] : undefined; }

export function isWireArray(value: unknown): value is unknown[] { return Array.isArray(value); }

export function isInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value); }

export function isSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value); }

export function isFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }

export function includes<T>(values: readonly T[], value: unknown): value is T { return values.some(entry => entry === value); }

export function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function sameJsonData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (isWireArray(left) || isWireArray(right)) {
    return isWireArray(left) && isWireArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameJsonData(entry, right[index]));
  }
  if (
    !isWireRecord(left) || !isWireRecord(right)
  ) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && sameJsonData(left[key], right[key])
    );
}

export function isDecimalRevision(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

export function compareDecimalRevisions(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function isWireRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !isWireArray(value);
}

type WireKeys<T> = T extends unknown ? keyof T : never;

export function hasOnlyWireKeys<T = Record<string, unknown>>(value: Record<string, unknown>, allowedKeys: readonly WireKeys<T>[]): boolean {
  const allowed = new Set<unknown>(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isWireStorageId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

export function isWireCorrelationId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export function wireUtf8ByteLength(value: string): number {
  let byteLength = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    byteLength += codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
          ? 3
          : 4;
  }
  return byteLength;
}

export function isWireUiMessage(value: unknown, depth = 0): value is UiMessage {
  if (typeof value === "string") return true;
  return depth < 16 && isWireRecord(value) &&
    hasOnlyWireKeys(value, ["source", "values"]) &&
    typeof value.source === "string" && Boolean(value.source) &&
    isWireRecord(value.values) && Object.keys(value.values).length <= 64 &&
    Object.values(value.values).every((parameter) =>
      typeof parameter === "boolean" ||
      typeof parameter === "number" && isFiniteNumber(parameter) ||
      isWireUiMessage(parameter, depth + 1));
}

export function wireCodePointLengthAtMost(value: string, maximum: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}
