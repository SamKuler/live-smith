export interface NamedParameterLike {
  name: string;
}

export function findExactParameterMatch<T extends NamedParameterLike>(
  requestedName: string,
  parameters: T[],
): T | undefined {
  const requested = normalizeParameterName(requestedName);
  const matches = parameters.filter(
    (parameter) => normalizeParameterName(parameter.name) === requested,
  );
  if (matches.length > 1) {
    throw new Error(
      `Found ${matches.length} parameters named "${requestedName}". The host parameter list is ambiguous.`,
    );
  }
  return matches[0];
}

function normalizeParameterName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}
