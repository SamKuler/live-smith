import { TextDecoder } from "node:util";

export const MAX_SKILL_FILE_BYTES = 64 * 1024;
export const MAX_SKILL_ID_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 240;

export interface SkillDefinition {
  id: string;
  description: string;
  body: string;
}

export interface SkillSummary {
  id: string;
  description: string;
}

const skillIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const allowedFrontmatterKeys = new Set(["name", "description"]);
const forbiddenScalarPrefixes = new Set([
  "|",
  ">",
  "&",
  "*",
  "!",
  "[",
  "]",
  "{",
  "}",
  "\"",
  "'",
  "#",
]);

export class SkillFormatError extends Error {
  constructor(line: number, reason: string) {
    super(`Invalid SKILL.md at line ${line}: ${reason}.`);
    this.name = "SkillFormatError";
  }
}

export function parseSkillMarkdown(bytes: Uint8Array): SkillDefinition {
  if (bytes.byteLength === 0) {
    throw new SkillFormatError(1, "the file is empty");
  }
  if (bytes.byteLength > MAX_SKILL_FILE_BYTES) {
    throw new SkillFormatError(1, "the file exceeds the byte limit");
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(bytes);
  } catch {
    throw new SkillFormatError(1, "the file is not valid UTF-8");
  }

  const invalidControlIndex = firstForbiddenControlIndex(source);
  if (invalidControlIndex >= 0) {
    throw new SkillFormatError(
      lineNumberAt(source, invalidControlIndex),
      "the file contains a forbidden control character",
    );
  }
  const byteOrderMarkIndex = source.indexOf("\ufeff");
  if (byteOrderMarkIndex >= 0) {
    throw new SkillFormatError(
      lineNumberAt(source, byteOrderMarkIndex),
      "the file contains a byte-order mark",
    );
  }

  const bidiControlIndex = firstBidiControlIndex(source);
  if (bidiControlIndex >= 0) {
    throw new SkillFormatError(
      lineNumberAt(source, bidiControlIndex),
      "the file contains a bidirectional control character",
    );
  }

  const loneCarriageReturnIndex = firstLoneCarriageReturnIndex(source);
  if (loneCarriageReturnIndex >= 0) {
    throw new SkillFormatError(
      lineNumberAt(source, loneCarriageReturnIndex),
      "line endings must use LF or CRLF",
    );
  }

  const normalized = source.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    throw new SkillFormatError(1, "the opening delimiter is missing");
  }

  const closingDelimiterIndex = 3;
  if (lines[closingDelimiterIndex] !== "---") {
    throw new SkillFormatError(
      Math.min(closingDelimiterIndex + 1, Math.max(1, lines.length)),
      "frontmatter must contain exactly two field lines",
    );
  }

  const values = new Map<string, string>();
  for (let index = 1; index < closingDelimiterIndex; index += 1) {
    const line = lines[index]!;
    const match = /^([A-Za-z][A-Za-z0-9-]*):(.*)$/.exec(line);
    if (!match) {
      throw new SkillFormatError(index + 1, "frontmatter contains an invalid field");
    }
    const key = match[1]!;
    if (!allowedFrontmatterKeys.has(key)) {
      throw new SkillFormatError(index + 1, "frontmatter contains an unknown field");
    }
    if (values.has(key)) {
      throw new SkillFormatError(index + 1, "frontmatter contains a duplicate field");
    }
    const value = match[2]!.trim();
    if (value.length === 0) {
      throw new SkillFormatError(index + 1, "frontmatter contains an empty value");
    }
    if (forbiddenScalarPrefixes.has(value[0]!)) {
      throw new SkillFormatError(index + 1, "frontmatter must use a plain scalar");
    }
    if (/^[-?:](?:$|\s)/u.test(value)) {
      throw new SkillFormatError(index + 1, "frontmatter must use a plain scalar");
    }
    if (/[\u0085\u2028\u2029]/u.test(value)) {
      throw new SkillFormatError(index + 1, "frontmatter must use one physical line");
    }
    values.set(key, value);
  }

  if (values.size !== allowedFrontmatterKeys.size) {
    throw new SkillFormatError(
      closingDelimiterIndex + 1,
      "frontmatter must contain name and description",
    );
  }

  const id = values.get("name")!;
  if (
    id.length > MAX_SKILL_ID_LENGTH ||
    !skillIdPattern.test(id)
  ) {
    throw new SkillFormatError(fieldLine(lines, closingDelimiterIndex, "name"), "the name is invalid");
  }

  const description = values.get("description")!;
  if ([...description].length > MAX_SKILL_DESCRIPTION_LENGTH) {
    throw new SkillFormatError(
      fieldLine(lines, closingDelimiterIndex, "description"),
      "the description exceeds the character limit",
    );
  }

  const body = lines.slice(closingDelimiterIndex + 1).join("\n");
  if (body.trim().length === 0) {
    throw new SkillFormatError(closingDelimiterIndex + 2, "the Markdown body is empty");
  }

  return { id, description, body };
}

export function summarizeSkill(skill: SkillDefinition): SkillSummary {
  return {
    id: skill.id,
    description: skill.description,
  };
}

export function isSafeSkillId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= MAX_SKILL_ID_LENGTH &&
    skillIdPattern.test(value);
}

function firstForbiddenControlIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return index;
    }
  }
  return -1;
}

function firstBidiControlIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return index;
    }
  }
  return -1;
}

function firstLoneCarriageReturnIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (
      value.charCodeAt(index) === 0x0d &&
      value.charCodeAt(index + 1) !== 0x0a
    ) {
      return index;
    }
  }
  return -1;
}

function lineNumberAt(value: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (value.charCodeAt(cursor) === 0x0a) line += 1;
  }
  return line;
}

function fieldLine(
  lines: readonly string[],
  closingDelimiterIndex: number,
  key: "name" | "description",
): number {
  for (let index = 1; index < closingDelimiterIndex; index += 1) {
    if (lines[index]?.startsWith(`${key}:`)) return index + 1;
  }
  return closingDelimiterIndex + 1;
}
