import { Buffer } from "node:buffer";
import { URL } from "node:url";

import type { ModelCitation } from "./contracts.js";

export const MAX_MODEL_CITATION_COUNT = 20;
export const MAX_MODEL_CITATION_URL_BYTES = 2_048;
export const MAX_MODEL_CITATION_TITLE_CODE_POINTS = 256;

export function normalizeModelCitations(
  candidates: readonly unknown[],
): ModelCitation[] {
  const citations: ModelCitation[] = [];
  const seenUrls = new Set<string>();
  for (const candidate of candidates) {
    if (citations.length >= MAX_MODEL_CITATION_COUNT) break;
    const citation = normalizeModelCitation(candidate);
    if (!citation || seenUrls.has(citation.url)) continue;
    seenUrls.add(citation.url);
    citations.push(citation);
  }
  return citations;
}

export function isModelCitation(value: unknown): value is ModelCitation {
  const citation = normalizeModelCitation(value);
  return citation !== undefined &&
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.url === citation.url &&
    value.title === citation.title;
}

function normalizeModelCitation(value: unknown): ModelCitation | undefined {
  if (!isRecord(value) || typeof value.url !== "string") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value.url);
  } catch {
    return undefined;
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    Buffer.byteLength(parsed.href, "utf8") > MAX_MODEL_CITATION_URL_BYTES
  ) return undefined;

  const suppliedTitle = typeof value.title === "string"
    ? value.title.trim()
    : "";
  const title = suppliedTitle || parsed.hostname;
  if (
    !title ||
    [...title].length > MAX_MODEL_CITATION_TITLE_CODE_POINTS ||
    /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(title)
  ) return undefined;
  return { url: parsed.href, title };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
