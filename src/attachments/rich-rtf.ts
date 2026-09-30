import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import { AttachmentProcessingError } from "./contracts.js";
import { BoundedDocumentTextBuilder, type ExtractedDocumentText } from "./document-text.js";

const omittedDestinations = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "objdata",
  "filetbl", "datastore", "listtable", "listoverridetable", "revtbl", "rsidtbl",
  "xmlnstbl", "fldinst", "generator", "themedata", "colorschememapping",
  "nonshppict", "shppict", "shpinst", "shprslt", "annotation",
]);
const characterControls: Readonly<Record<string, string>> = {
  par: "\n", line: "\n", page: "\n", sect: "\n", row: "\n", nestrow: "\n",
  tab: "\t", cell: "\t", nestcell: "\t", emdash: "—", endash: "–",
  bullet: "•", lquote: "‘", rquote: "’", ldblquote: "“", rdblquote: "”",
  enspace: " ", emspace: " ", qmspace: " ",
};

interface RtfState {
  omitted: boolean;
  hidden: boolean;
  fallbackLength: number;
  defaultEncoding: string;
  currentFont: number | undefined;
  defaultFont: number | undefined;
  fontTable: boolean;
  fontDefinition: RtfFontDefinition | undefined;
  ignorable: boolean;
  unicodeAlternative: boolean;
  alternateChildren: number;
}
interface RtfFontDefinition { charset: number | undefined; codePage: number | undefined }

export async function extractRtfText(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<ExtractedDocumentText> {
  throwIfAborted(signal);
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  if (!/^\{\\rtf1(?:[^\d]|$)/.test(source)) throw invalidRtf();
  const builder = new BoundedDocumentTextBuilder();
  const stack: RtfState[] = [];
  const fonts = new Map<number, RtfFontDefinition>();
  let state: RtfState = {
    omitted: false, hidden: false, fallbackLength: 1, defaultEncoding: "windows-1252",
    currentFont: undefined, defaultFont: undefined, fontTable: false, fontDefinition: undefined,
    ignorable: false, unicodeAlternative: false, alternateChildren: 0,
  };
  let pendingBytes: number[] = [];
  let ansiDecoder: TextDecoder | undefined;
  let highSurrogate: number | undefined;
  let fallbackRemaining = 0;
  let cursor = 0;
  let nextYield = 64 * 1024;
  let closed = false;

  const append = (value: string): void => {
    if (highSurrogate !== undefined) throw invalidRtf();
    if (!state.omitted && !state.hidden) builder.append(value);
  };
  const currentEncoding = (): string => {
    const selected = state.currentFont ?? state.defaultFont;
    if (selected === undefined) return state.defaultEncoding;
    const font = fonts.get(selected);
    if (!font) throw invalidRtf();
    return font.codePage === undefined ? rtfFontCharset(font.charset ?? 0) : rtfCodePage(font.codePage);
  };
  const flush = (complete = true): void => {
    if (pendingBytes.length === 0 && ansiDecoder === undefined) return;
    let decoded: string;
    try {
      ansiDecoder ??= new TextDecoder(currentEncoding(), { fatal: true });
      decoded = ansiDecoder.decode(Uint8Array.from(pendingBytes), { stream: !complete });
    } catch {
      throw invalidRtf();
    }
    pendingBytes = [];
    if (complete) ansiDecoder = undefined;
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(decoded)) throw invalidRtf();
    append(decoded);
  };
  const ansi = (value: number): void => {
    if (fallbackRemaining > 0) { fallbackRemaining -= 1; return; }
    if (state.omitted || state.hidden) return;
    pendingBytes.push(value);
    if (pendingBytes.length >= 64 * 1024) flush(false);
  };

  while (cursor < source.length) {
    if (cursor >= nextYield) {
      await yieldToHost(signal);
      nextYield = cursor + 64 * 1024;
    }
    if (closed) {
      if (!/[\t\r\n ]/.test(source[cursor]!)) throw invalidRtf();
      cursor += 1;
      continue;
    }
    const character = source[cursor++]!;
    if (character === "{" || character === "}") {
      flush();
      fallbackRemaining = 0;
      if (character === "{") {
        if (stack.length >= 256) throw archiveLimit("RTF nesting exceeds the safe limit.");
        state.alternateChildren += 1;
        stack.push(state);
        state = {
          ...state,
          omitted: state.omitted || (state.unicodeAlternative && state.alternateChildren === 1),
          ignorable: false, unicodeAlternative: false, alternateChildren: 0,
        };
      } else {
        const parent = stack.pop();
        if (!parent) throw invalidRtf();
        state = parent;
        if (stack.length === 0) closed = true;
      }
      continue;
    }
    if (character !== "\\") {
      if (character === "\r" || character === "\n") continue;
      if (character.charCodeAt(0) < 32 && character !== "\t") throw invalidRtf();
      if (state.fontTable && character === ";") state.fontDefinition = undefined;
      ansi(character.charCodeAt(0));
      continue;
    }
    if (cursor >= source.length) throw invalidRtf();
    const symbol = source[cursor]!;
    if (!/[a-zA-Z]/.test(symbol)) {
      cursor += 1;
      if (symbol === "'") {
        const hex = source.slice(cursor, cursor + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw invalidRtf();
        cursor += 2;
        ansi(Number.parseInt(hex, 16));
      } else if (symbol === "\\" || symbol === "{" || symbol === "}") {
        ansi(symbol.charCodeAt(0));
      } else if (symbol === "*") {
        flush();
        state.ignorable = true;
      } else if (symbol === "~" || symbol === "-" || symbol === "_") {
        flush();
        if (fallbackRemaining > 0) fallbackRemaining -= 1;
        else append(symbol === "~" ? " " : symbol === "_" ? "‑" : "­");
      } else if (symbol !== "\r" && symbol !== "\n") throw invalidRtf();
      continue;
    }
    flush();
    const start = cursor;
    while (cursor < source.length && /[a-zA-Z]/.test(source[cursor]!)) cursor += 1;
    if (cursor - start > 32) throw invalidRtf();
    const word = source.slice(start, cursor);
    const numberStart = cursor;
    if (source[cursor] === "-") cursor += 1;
    const digitsStart = cursor;
    while (cursor < source.length && /\d/.test(source[cursor]!)) cursor += 1;
    if (cursor - digitsStart > 10 || (digitsStart > numberStart && digitsStart === cursor)) throw invalidRtf();
    const parameter = cursor > digitsStart ? Number(source.slice(numberStart, cursor)) : undefined;
    if (source[cursor] === " ") cursor += 1;

    if (state.ignorable) {
      if (word !== "ud") {
        state.omitted = true; state.fontTable = false; state.fontDefinition = undefined;
      }
      state.ignorable = false;
    }
    if (word === "fonttbl") {
      if (!state.omitted) state.fontTable = true;
      state.omitted = true;
    } else if (omittedDestinations.has(word)) {
      state.omitted = true; state.fontTable = false; state.fontDefinition = undefined;
    }
    if (word === "bin") {
      if (parameter === undefined || parameter < 0 || parameter > source.length - cursor) throw invalidRtf();
      cursor += parameter;
    } else if (word === "ansicpg") {
      if (parameter === undefined) throw invalidRtf();
      state.defaultEncoding = rtfCodePage(parameter);
    } else if (word === "mac") state.defaultEncoding = "macintosh";
    else if (word === "f" && (state.fontTable || !state.omitted)) {
      if (parameter === undefined || parameter < 0) throw invalidRtf();
      if (state.fontTable) {
        if (fonts.has(parameter)) throw invalidRtf();
        if (fonts.size >= 4096) throw archiveLimit("RTF font count exceeds the safe limit.");
        state.fontDefinition = { charset: undefined, codePage: undefined };
        fonts.set(parameter, state.fontDefinition);
      } else state.currentFont = parameter;
    } else if (word === "deff" && !state.omitted) {
      if (parameter === undefined || parameter < 0) throw invalidRtf();
      state.defaultFont = parameter;
    } else if ((word === "fcharset" || word === "cpg") && state.fontTable) {
      if (!state.fontDefinition || parameter === undefined || parameter < 0 || word === "fcharset" && parameter > 255) throw invalidRtf();
      if (word === "fcharset") state.fontDefinition.charset = parameter;
      else state.fontDefinition.codePage = parameter;
    }
    else if (word === "uc") {
      if (parameter === undefined || parameter < 0 || parameter > 255) throw invalidRtf();
      state.fallbackLength = parameter;
    } else if (word === "u") {
      if (parameter === undefined || parameter < -32768 || parameter > 65535) throw invalidRtf();
      if (!state.omitted && !state.hidden) {
        const unit = parameter < 0 ? parameter + 65536 : parameter;
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (highSurrogate !== undefined) throw invalidRtf();
          highSurrogate = unit;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          if (highSurrogate === undefined) throw invalidRtf();
          builder.append(String.fromCharCode(highSurrogate, unit));
          highSurrogate = undefined;
        } else {
          if ((unit < 32 && unit !== 9 && unit !== 10 && unit !== 13) || (unit >= 127 && unit <= 159)) throw invalidRtf();
          append(String.fromCharCode(unit));
        }
      }
      fallbackRemaining = state.fallbackLength;
    } else if (word === "v") state.hidden = parameter !== 0;
    else if (word === "plain") { state.hidden = false; state.currentFont = undefined; }
    else if (word === "upr") state.unicodeAlternative = true;
    else if (characterControls[word] !== undefined) {
      if (fallbackRemaining > 0) fallbackRemaining -= 1;
      else append(characterControls[word]!);
    }
  }
  flush();
  if (!closed || stack.length !== 0 || highSurrogate !== undefined) throw invalidRtf();
  throwIfAborted(signal);
  return builder.finish();
}

function rtfCodePage(value: number): string {
  const labels: Readonly<Record<number, string>> = {
    65001: "utf-8", 932: "shift_jis", 936: "gbk", 949: "euc-kr", 950: "big5",
    874: "windows-874", 10000: "macintosh",
  };
  const encoding = value >= 1250 && value <= 1258 ? `windows-${value}` : labels[value];
  if (!encoding) throw invalidRtf();
  return encoding;
}

function rtfFontCharset(value: number): string {
  // RTF fcharset uses the Windows CharacterSet identifiers. Locale-dependent
  // Default/OEM, Symbol glyphs and unavailable encodings require an explicit cpg.
  const codePages: Readonly<Record<number, number>> = {
    0: 1252, 77: 10000, 128: 932, 129: 949, 130: 1361, 134: 936, 136: 950,
    161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257,
    204: 1251, 222: 874, 238: 1250,
  };
  const codePage = codePages[value];
  if (codePage === undefined) throw invalidRtf();
  return rtfCodePage(codePage);
}

function invalidRtf(): AttachmentProcessingError {
  return new AttachmentProcessingError("invalid_document", "The RTF document is malformed or uses an unsupported encoding.");
}
function archiveLimit(message: string): AttachmentProcessingError {
  return new AttachmentProcessingError("archive_limit", message);
}
