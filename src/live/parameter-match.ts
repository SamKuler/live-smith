export interface NamedParameterLike {
  name: string;
}

export interface RangedParameterLike extends NamedParameterLike {
  min: number;
  max: number;
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

export function assertParameterValueInObservedRange(
  value: number,
  parameter: RangedParameterLike,
  targetLabel: string,
): void {
  if (!Number.isFinite(parameter.min) || !Number.isFinite(parameter.max)) {
    throw new Error(
      `Could not verify the observed range for parameter "${parameter.name}" ${targetLabel}.`,
    );
  }
  if (value < parameter.min || value > parameter.max) {
    throw new Error(
      `Value ${value} for parameter "${parameter.name}" ${targetLabel} is outside observed range ${parameter.min}-${parameter.max}. Inspect the target again and use a value inside that range.`,
    );
  }
}

function normalizeParameterName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}
