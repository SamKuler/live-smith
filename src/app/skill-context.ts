import { Buffer } from "node:buffer";

import {
  isSafeSkillId,
  MAX_ACTIVE_SKILL_COUNT,
  type SkillDefinition,
} from "../skills/format.js";
import {
  availableSkillSummaries,
  builtInSkillDefinition,
} from "../skills/builtins.js";
import {
  withSkillCatalogTransaction,
} from "../storage/skills.js";

export const MAX_ACTIVE_SKILL_INSTRUCTION_BYTES = 128 * 1024;

export interface ResolvedSkillContext {
  activeSkillIds: string[];
  instructionBlock: string;
}

export class SkillContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillContextError";
  }
}

export async function resolveSkillContext(input: {
  storageDirectory: string | undefined;
  sessionSkillIds: readonly string[];
  prompt: string;
}): Promise<ResolvedSkillContext> {
  assertSessionSkillIds(input.sessionSkillIds);
  const mentionedCandidates = skillMentionCandidates(input.prompt);
  if (input.sessionSkillIds.length === 0 && mentionedCandidates.length === 0) {
    return { activeSkillIds: [], instructionBlock: "" };
  }

  return withSkillCatalogTransaction(input.storageDirectory, async (catalog) => {
    let installed;
    try {
      installed = await catalog.listInstalledSkills();
    } catch {
      throw new SkillContextError(
        "Installed Skill summaries could not be validated.",
      );
    }

    const installedIds = new Set(installed.map((skill) => skill.id));
    const availableIds = new Set(
      availableSkillSummaries(installed).map((skill) => skill.id),
    );
    for (const skillId of input.sessionSkillIds) {
      if (!availableIds.has(skillId)) {
        throw unavailableSkillError(skillId);
      }
    }

    const activeSkillIds = [...new Set([
      ...input.sessionSkillIds,
      ...mentionedCandidates.filter((skillId) => availableIds.has(skillId)),
    ])].sort();
    if (activeSkillIds.length > MAX_ACTIVE_SKILL_COUNT) {
      throw new SkillContextError(
        `At most ${MAX_ACTIVE_SKILL_COUNT} Skills can guide one request.`,
      );
    }

    const definitions: SkillDefinition[] = [];
    for (const skillId of activeSkillIds) {
      if (installedIds.has(skillId)) {
        try {
          definitions.push(await catalog.readInstalledSkill(skillId));
        } catch {
          throw unavailableSkillError(skillId);
        }
      } else {
        const definition = builtInSkillDefinition(skillId);
        if (definition === undefined) throw unavailableSkillError(skillId);
        definitions.push(definition);
      }
    }

    const instructionBlock = definitions.map(renderSkillInstructions).join("\n\n");
    if (
      Buffer.byteLength(instructionBlock, "utf8") >
        MAX_ACTIVE_SKILL_INSTRUCTION_BYTES
    ) {
      throw new SkillContextError(
        "The selected Skill instructions exceed the per-request byte limit.",
      );
    }
    return { activeSkillIds, instructionBlock };
  });
}

/**
 * Returns lexical candidates only. Catalog existence is intentionally resolved
 * later so unknown tokens remain ordinary prompt text.
 */
export function skillMentionCandidates(prompt: string): string[] {
  const candidates = new Set<string>();
  for (let index = 0; index < prompt.length;) {
    const marker = prompt[index];
    if (marker === "`" || marker === "~") {
      const runLength = delimiterRunLength(prompt, index, marker);
      const fenced = runLength >= 3 &&
        isFenceDelimiterLine(prompt, index, runLength, marker, false);
      if (marker === "~" && !fenced) {
        index += runLength;
        continue;
      }
      const closing = closingCodeRun(
        prompt,
        index + runLength,
        runLength,
        marker,
        fenced,
      );
      index = closing === undefined
        ? fenced ? prompt.length : index + runLength
        : closing.index + closing.length;
      continue;
    }
    if (
      prompt[index] !== "$" ||
      (index !== 0 && !isPromptWhitespace(prompt[index - 1]!))
    ) {
      index += 1;
      continue;
    }

    const candidateStart = index + 1;
    const candidateEnd = skillIdCandidateEnd(prompt, candidateStart);
    const candidate = prompt.slice(candidateStart, candidateEnd);
    if (
      candidate.length > 0 &&
      !isAsciiDigit(candidate[0]!) &&
      isSafeSkillId(candidate) &&
      isMentionRightBoundary(prompt[candidateEnd])
    ) {
      candidates.add(candidate);
    }
    index = Math.max(index + 1, candidateEnd);
  }
  return [...candidates];
}

function assertSessionSkillIds(skillIds: readonly string[]): void {
  if (
    !Array.isArray(skillIds) ||
    skillIds.length > MAX_ACTIVE_SKILL_COUNT ||
    !skillIds.every(isSafeSkillId) ||
    new Set(skillIds).size !== skillIds.length
  ) {
    throw new SkillContextError("Saved Session Skill activation is invalid.");
  }
}

function unavailableSkillError(skillId: string): SkillContextError {
  return new SkillContextError(`Selected Skill ${skillId} is unavailable or invalid.`);
}

function renderSkillInstructions(skill: SkillDefinition): string {
  const id = escapeSkillBoundaryText(skill.id);
  const body = escapeSkillBoundaryText(skill.body);
  const closingPrefix = body.endsWith("\n") ? "" : "\n";
  return `<skill id="${id}">\n${body}${closingPrefix}</skill>`;
}

function escapeSkillBoundaryText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function delimiterRunLength(
  prompt: string,
  start: number,
  marker: "`" | "~",
): number {
  let end = start;
  while (prompt[end] === marker) end += 1;
  return end - start;
}

function closingCodeRun(
  prompt: string,
  start: number,
  runLength: number,
  marker: "`" | "~",
  fenced: boolean,
): { index: number; length: number } | undefined {
  for (let index = prompt.indexOf(marker, start); index !== -1;) {
    const closingLength = delimiterRunLength(prompt, index, marker);
    if (
      (
        fenced
          ? closingLength >= runLength &&
            isFenceDelimiterLine(
              prompt,
              index,
              closingLength,
              marker,
              true,
            )
          : closingLength === runLength
      )
    ) {
      return { index, length: closingLength };
    }
    index = prompt.indexOf(marker, index + closingLength);
  }
  return undefined;
}

function isFenceDelimiterLine(
  prompt: string,
  start: number,
  runLength: number,
  marker: "`" | "~",
  closing: boolean,
): boolean {
  const lineStart = prompt.lastIndexOf("\n", start - 1) + 1;
  const indentation = prompt.slice(lineStart, start);
  if (indentation.length > 3 || !/^ *$/u.test(indentation)) return false;
  if (!closing) {
    const lineEnd = prompt.indexOf("\n", start + runLength);
    const info = prompt.slice(
      start + runLength,
      lineEnd === -1 ? prompt.length : lineEnd,
    );
    return marker === "~" || !info.includes("`");
  }
  const lineEnd = prompt.indexOf("\n", start + runLength);
  const suffix = prompt.slice(
    start + runLength,
    lineEnd === -1 ? prompt.length : lineEnd,
  );
  return /^[ \t\r]*$/u.test(suffix);
}

function skillIdCandidateEnd(prompt: string, start: number): number {
  let index = start;
  let previousHyphen = false;
  while (index < prompt.length) {
    const character = prompt[index]!;
    if (isAsciiLowercaseOrDigit(character)) {
      previousHyphen = false;
      index += 1;
      continue;
    }
    if (character === "-" && index > start && !previousHyphen) {
      previousHyphen = true;
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function isMentionRightBoundary(character: string | undefined): boolean {
  return character === undefined ||
    !/[A-Za-z0-9_@/\\-]/u.test(character);
}

function isPromptWhitespace(character: string): boolean {
  return /\s/u.test(character);
}

function isAsciiDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function isAsciiLowercaseOrDigit(character: string): boolean {
  return (character >= "a" && character <= "z") || isAsciiDigit(character);
}
