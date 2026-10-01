import { readBoundedProviderErrorJson } from "../../model/transports/provider-error-body.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Only structured diagnostics are public; messages, input/ctx and raw bodies never are. */
export async function sunoErrorDiagnostic(
  response: Response, signal: AbortSignal, secrets: string[], requestBody?: BodyInit | null,
): Promise<string> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return "";
  const value = record(await readBoundedProviderErrorJson(response, "Suno error", signal));
  if (!value) return "";
  const privateStrings = new Set(secrets.filter(Boolean));
  // Even structural fields cannot echo a value submitted in this request.
  if (typeof requestBody === "string") {
    const pending: unknown[] = [JSON.parse(requestBody)];
    while (pending.length) {
      const next = pending.pop();
      if (typeof next === "string" && next) privateStrings.add(next);
      else if (next && typeof next === "object") pending.push(...Object.values(next));
    }
  }
  const redact = (input: string): string => {
    let text = input;
    for (const secret of [...privateStrings].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, "[redacted]");
    return text.slice(0, 480);
  };
  if (Array.isArray(value.detail)) {
    const diagnostics = value.detail.slice(0, 8).flatMap(item => {
      const entry = record(item);
      if (!entry || typeof entry.type !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(entry.type) ||
          !Array.isArray(entry.loc) || entry.loc.length < 1 || entry.loc.length > 8 ||
          entry.loc.some(part => !(typeof part === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(part)) &&
            !(Number.isSafeInteger(part) && part >= 0 && part <= 9999))) return [];
      return [`${entry.loc.join(".")}: ${entry.type}`];
    });
    return redact(diagnostics.join("; "));
  }
  const error = record(value.error) ?? record(value.detail) ?? value;
  return redact(["code", "type"].flatMap(key => {
    const code = error[key];
    return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? [`${key}=${code}`] : [];
  }).join("; "));
}
