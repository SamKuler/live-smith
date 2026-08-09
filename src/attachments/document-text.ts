export const MAX_DOCUMENT_TEXT_CHARACTERS = 100_000;
export const MAX_REQUEST_DOCUMENT_TEXT_CHARACTERS = 200_000;

export interface ExtractedDocumentText {
  text: string;
  truncated: boolean;
}

export class BoundedDocumentTextBuilder {
  readonly #parts: string[] = [];
  #characterCount = 0;
  #truncated = false;

  constructor(
    readonly maxCharacters = MAX_DOCUMENT_TEXT_CHARACTERS,
  ) {
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) {
      throw new TypeError("Document text limit must be a positive safe integer.");
    }
  }

  get characterCount(): number {
    return this.#characterCount;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  append(value: string): boolean {
    if (!value) return !this.#truncated;
    if (this.#truncated) return false;

    const remaining = this.maxCharacters - this.#characterCount;
    const prefix = prefixWithinCodePointLimit(value, remaining);
    if (prefix.end > 0) this.#parts.push(value.slice(0, prefix.end));
    this.#characterCount += prefix.characterCount;
    if (!prefix.complete) this.#truncated = true;
    return prefix.complete;
  }

  appendLine(value = ""): boolean {
    return this.append(value) && this.append("\n");
  }

  finish(): ExtractedDocumentText {
    return {
      text: this.#parts.join(""),
      truncated: this.#truncated,
    };
  }
}

function prefixWithinCodePointLimit(
  value: string,
  limit: number,
): { end: number; characterCount: number; complete: boolean } {
  let end = 0;
  let characterCount = 0;
  while (end < value.length && characterCount < limit) {
    const codePoint = value.codePointAt(end);
    if (codePoint === undefined) break;
    end += codePoint > 0xffff ? 2 : 1;
    characterCount += 1;
  }
  return {
    end,
    characterCount,
    complete: end === value.length,
  };
}
