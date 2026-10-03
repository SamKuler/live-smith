/** Serialized SDK bigint identity. Existence is checked against observed Live objects. */
export function isLiveObjectId(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|-?[1-9][0-9]*)$/u.test(value);
}
