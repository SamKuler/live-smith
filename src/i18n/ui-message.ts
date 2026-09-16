/** Strings are raw data. Only explicit descriptors contain app-authored copy. */
export type UiMessage = string | UiMessageDescriptor;
export type UiMessageValues = Record<string, UiMessage | number | boolean>;
export interface UiMessageDescriptor {
  source: string;
  values: UiMessageValues;
}

export function uiMessage(source: string, values: UiMessageValues = {}): UiMessageDescriptor {
  return { source, values: { ...values } };
}

/** English fallback for non-localized consumers; never translates raw strings. */
export function formatUiMessage(value: UiMessage | number | boolean): string {
  if (typeof value !== "object") return String(value);
  return value.source.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (field, key: string) => {
    if (!Object.hasOwn(value.values, key)) return field;
    return formatUiMessage(value.values[key]!);
  });
}

export function isUiMessage(value: unknown, depth = 0): value is UiMessage {
  if (typeof value === "string") return true;
  if (depth >= 16 || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (Object.keys(message).some(key => key !== "source" && key !== "values") ||
    typeof message.source !== "string" || !message.source || !message.values ||
    typeof message.values !== "object" || Array.isArray(message.values)) return false;
  const parameters = Object.values(message.values);
  return parameters.length <= 64 && parameters.every(parameter =>
    typeof parameter === "boolean" || typeof parameter === "number" && Number.isFinite(parameter) ||
    isUiMessage(parameter, depth + 1));
}
