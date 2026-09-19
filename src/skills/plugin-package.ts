import { TextDecoder } from "node:util";

import { openPluginArchive } from "../plugins/archive.js";
import type { InstalledPluginPackage } from "../storage/plugins.js";
import {
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_FILE_BYTES,
  isSafeSkillId,
  SkillFormatError,
  type SkillDefinition,
} from "./format.js";

export interface PluginSkillDefinition extends SkillDefinition {
  pluginId: string;
  localId: string;
}

const forbiddenScalarPrefixes = new Set(["|", ">", "&", "*", "!", "[", "]", "{", "}", "\"", "'", "#"]);

export async function pluginSkillsFromArchive(pluginId: string, bytes: Uint8Array): Promise<PluginSkillDefinition[]> {
  const archive = await openPluginArchive(bytes);
  if (archive.manifest.id !== pluginId) throw new Error("Plugin Skill package identity does not match its manifest.");
  const directory = archive.manifest.components.skillsDirectory;
  if (!directory) return [];
  const prefix = `${directory}/`;
  const definitions: PluginSkillDefinition[] = [];
  for (const [path, source] of archive.files) {
    if (!path.startsWith(prefix) || !path.endsWith("/SKILL.md")) continue;
    const relative = path.slice(prefix.length);
    const segments = relative.split("/");
    if (segments.length !== 2 || segments[1] !== "SKILL.md") continue;
    const localId = segments[0]!;
    try {
      if (!isSafeSkillId(localId)) throw new SkillFormatError(1, "the Skill directory name is invalid");
      const definition = parsePluginSkillMarkdown(source, localId);
      if (definition.id !== localId) throw new SkillFormatError(2, "the name does not match the Skill directory");
      definitions.push({ ...definition, id: `${pluginId}:${localId}`, pluginId, localId });
    } catch (error) {
      if (!(error instanceof SkillFormatError)) throw error;
    }
  }
  definitions.sort((left, right) => left.id.localeCompare(right.id));
  return definitions;
}

export async function pluginSkillsFromPackages(
  packages: readonly InstalledPluginPackage[],
): Promise<PluginSkillDefinition[]> {
  const definitions = (await Promise.all(packages.map((entry) =>
    pluginSkillsFromArchive(entry.plugin.id, entry.bytes)))).flat();
  definitions.sort((left, right) => left.id.localeCompare(right.id));
  if (definitions.some((definition, index) => index > 0 && definitions[index - 1]!.id === definition.id)) {
    throw new Error("Enabled Plugins expose duplicate Skill identities.");
  }
  return definitions;
}

export function parsePluginSkillMarkdown(bytes: Uint8Array, fallbackId: string): SkillDefinition {
  if (!bytes.byteLength) throw new SkillFormatError(1, "the file is empty");
  if (bytes.byteLength > MAX_SKILL_FILE_BYTES) throw new SkillFormatError(1, "the file exceeds the byte limit");
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new SkillFormatError(1, "the file is not valid UTF-8"); }
  assertSafeText(source);
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") throw new SkillFormatError(1, "the opening delimiter is missing");
  const closing = lines.indexOf("---", 1);
  if (closing < 2 || closing > 64) throw new SkillFormatError(1, "the frontmatter delimiter is invalid");
  const fields = new Map<string, { value: string; line: number }>();
  for (let index = 1; index < closing; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):(.*)$/u.exec(lines[index]!);
    if (!match) throw new SkillFormatError(index + 1, "frontmatter contains an invalid field");
    const key = match[1]!;
    if (fields.has(key)) throw new SkillFormatError(index + 1, "frontmatter contains a duplicate field");
    const value = match[2]!.trim();
    if (!value || forbiddenScalarPrefixes.has(value[0]!) || /^[-?:](?:$|\s)/u.test(value)) {
      throw new SkillFormatError(index + 1, "frontmatter must use a non-empty plain scalar");
    }
    fields.set(key, { value, line: index + 1 });
  }
  const id = fields.get("name")?.value ?? fallbackId;
  if (!isSafeSkillId(id)) throw new SkillFormatError(fields.get("name")?.line ?? 2, "the name is invalid");
  const description = fields.get("description");
  if (!description) throw new SkillFormatError(closing + 1, "frontmatter must contain description");
  if ([...description.value].length > MAX_SKILL_DESCRIPTION_LENGTH) {
    throw new SkillFormatError(description.line, "the description exceeds the character limit");
  }
  const body = lines.slice(closing + 1).join("\n");
  if (!body.trim()) throw new SkillFormatError(closing + 2, "the Markdown body is empty");
  return { id, description: description.value, body };
}

function assertSafeText(source: string): void {
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      throw new SkillFormatError(lineAt(source, index), "the file contains a forbidden control character");
    }
    if (code === 0xfeff) throw new SkillFormatError(lineAt(source, index), "the file contains a byte-order mark");
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
      throw new SkillFormatError(lineAt(source, index), "the file contains a bidirectional control character");
    }
    if (code === 0x0d && source.charCodeAt(index + 1) !== 0x0a) {
      throw new SkillFormatError(lineAt(source, index), "line endings must use LF or CRLF");
    }
  }
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source.charCodeAt(index) === 0x0a) line += 1;
  return line;
}
