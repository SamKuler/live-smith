export interface NamedParameterLike {
  name: string;
}

export function findBestParameterMatch<T extends NamedParameterLike>(
  requestedName: string,
  parameters: T[],
): T | undefined {
  const requested = normalizeParameterName(requestedName);
  const exact = parameters.find((parameter) => normalizeParameterName(parameter.name) === requested);
  if (exact) return exact;

  const requestedTokens = tokenSet(requested);
  return parameters.find((parameter) => {
    const candidate = normalizeParameterName(parameter.name);
    const candidateTokens = tokenSet(candidate);
    return (
      requested.includes(candidate) ||
      candidate.includes(requested) ||
      isSubset(candidateTokens, requestedTokens)
    );
  });
}

function normalizeParameterName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bosc\b/g, "oscillator")
    .replace(/\b(on|off|enabled|enable|active)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenSet(value: string): Set<string> {
  return new Set(value.split(" ").filter(Boolean));
}

function isSubset(left: Set<string>, right: Set<string>): boolean {
  if (!left.size) return false;
  for (const token of left) {
    if (!right.has(token)) return false;
  }
  return true;
}
