/** Session-owned musical intent; the current Live state remains observational data. */
export const MAX_CREATIVE_BRIEF_CODE_POINTS = 8_000;

export function isCreativeBrief(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let length = 0;
  for (const _character of value) {
    if (++length > MAX_CREATIVE_BRIEF_CODE_POINTS) return false;
  }
  return true;
}

export function requireCreativeBrief(value: unknown): string {
  if (!isCreativeBrief(value)) {
    throw new Error(`Creative brief must be text of at most ${MAX_CREATIVE_BRIEF_CODE_POINTS} characters.`);
  }
  return value;
}

export interface CreativeBriefProposal {
  creativeBrief: string;
  expectedCreativeBrief: string;
  saved: false;
}

export function isCreativeBriefProposal(value: unknown): value is CreativeBriefProposal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 && record.saved === false &&
    isCreativeBrief(record.creativeBrief) && isCreativeBrief(record.expectedCreativeBrief);
}
