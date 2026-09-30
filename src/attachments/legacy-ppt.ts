import { TextDecoder } from "node:util";
import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import { AttachmentProcessingError } from "./contracts.js";
import { BoundedDocumentTextBuilder, type ExtractedDocumentText } from "./document-text.js";
import type { CompoundDocument } from "./compound.js";

interface PptRecord { version: number; instance: number; type: number; data: Uint8Array; end: number }
interface SlideText { persistId: number; text: Uint8Array[]; textTypes: number[] }

/** Follows MS-PPT's current edit chain; stale persist objects are never scanned for text. */
export async function extractLegacyPowerPointText(document: CompoundDocument, signal?: AbortSignal): Promise<ExtractedDocumentText> {
  throwIfAborted(signal);
  const bytes = document.streams.get("PowerPoint Document");
  const currentBytes = document.streams.get("Current User");
  if (!bytes || !currentBytes) throw invalid("PowerPoint document or Current User stream is missing.");
  const current = recordAt(currentBytes, 0);
  if (current.type !== 4086 || current.version !== 0 || current.data.byteLength < 20) throw invalid("PowerPoint CurrentUserAtom is invalid.");
  const currentView = viewOf(current.data);
  const token = currentView.getUint32(4, true);
  if (token === 0xf3d1c4df) throw encrypted();
  if (token !== 0xe391c05f) throw invalid("PowerPoint Current User header token is invalid.");
  let editOffset = currentView.getUint32(8, true);
  const edits = new Set<number>();
  const persist = new Map<number, number>();
  let docPersistId: number | undefined;
  do {
    await yieldToHost(signal);
    if (edits.has(editOffset)) throw invalid("PowerPoint edit chain is cyclic.");
    if (edits.size >= 256) throw limit("PowerPoint edit count exceeds the safe limit.");
    edits.add(editOffset);
    const edit = recordAt(bytes, editOffset);
    if (edit.type !== 4085 || edit.version !== 0 || edit.data.byteLength < 28) throw invalid("PowerPoint UserEditAtom is invalid.");
    const editView = viewOf(edit.data);
    if (edit.data.byteLength >= 32 && editView.getUint32(28, true) !== 0) throw encrypted();
    docPersistId ??= editView.getUint32(16, true);
    const directory = recordAt(bytes, editView.getUint32(12, true));
    if (directory.type !== 6002 || directory.version !== 0) throw invalid("PowerPoint persist directory is invalid.");
    const directoryView = viewOf(directory.data);
    const ownIds = new Set<number>();
    for (let offset = 0; offset < directory.data.byteLength;) {
      if (offset + 4 > directory.data.byteLength) throw invalid("PowerPoint persist directory is truncated.");
      const descriptor = directoryView.getUint32(offset, true);
      const start = descriptor & 0xfffff; const count = descriptor >>> 20;
      offset += 4;
      if (start === 0 || count === 0 || start + count > 0x100000 || offset + count * 4 > directory.data.byteLength) throw invalid("PowerPoint persist-directory run is invalid.");
      for (let index = 0; index < count; index += 1) {
        const id = start + index;
        if (ownIds.has(id)) throw invalid("PowerPoint persist directory repeats an object ID.");
        ownIds.add(id);
        const objectOffset = directoryView.getUint32(offset + index * 4, true);
        recordAt(bytes, objectOffset);
        if (!persist.has(id)) persist.set(id, objectOffset);
        if (persist.size > 100_000) throw limit("PowerPoint persist-object count exceeds the safe limit.");
      }
      offset += count * 4;
    }
    editOffset = editView.getUint32(8, true);
  } while (editOffset !== 0);
  const documentOffset = docPersistId === undefined ? undefined : persist.get(docPersistId);
  if (documentOffset === undefined) throw invalid("PowerPoint live DocumentContainer is missing.");
  const main = recordAt(bytes, documentOffset);
  if (main.type !== 1000 || main.version !== 15) throw invalid("PowerPoint live DocumentContainer is invalid.");
  const builder = new BoundedDocumentTextBuilder();
  let visited = 0;
  const children = (data: Uint8Array): PptRecord[] => {
    const result: PptRecord[] = [];
    for (let offset = 0; offset < data.byteLength;) {
      const record = recordAt(data, offset);
      visited += 1;
      if (visited > 100_000) throw limit("PowerPoint record count exceeds the safe limit.");
      result.push(record); offset = record.end;
    }
    return result;
  };
  const mainChildren = children(main.data);
  if (mainChildren.some((record) => record.type === 1023 && record.data.byteLength >= 12 && viewOf(record.data).getUint32(8, true) !== 0)) {
    throw new AttachmentProcessingError("macro_enabled", "Macro-enabled PowerPoint documents are not supported.");
  }
  const lists = mainChildren.filter((record) => record.type === 4080 && record.instance === 0);
  if (lists.length !== 1 || lists[0]!.version !== 15) throw invalid("PowerPoint slide list is missing or ambiguous.");
  const slides: SlideText[] = [];
  const notesById = new Map<number, SlideText>();
  const notesLists = mainChildren.filter((record) => record.type === 4080 && record.instance === 2);
  if (notesLists.length > 1) throw invalid("PowerPoint notes list is ambiguous.");
  for (const list of notesLists) {
    for (const record of children(list.data)) {
      if (record.type !== 1011) continue;
      if (record.data.byteLength !== 20) throw invalid("PowerPoint NotesPersistAtom is invalid.");
      const view = viewOf(record.data);
      const id = view.getUint32(12, true);
      if (id === 0 || notesById.has(id)) throw invalid("PowerPoint notes identifier is invalid or duplicated.");
      notesById.set(id, { persistId: view.getUint32(0, true), text: [], textTypes: [] });
    }
  }
  let slide: SlideText | undefined;
  for (const record of children(lists[0]!.data)) {
    if (record.type === 1011) {
      if (record.data.byteLength < 20) throw invalid("PowerPoint SlidePersistAtom is truncated.");
      slide = { persistId: viewOf(record.data).getUint32(0, true), text: [], textTypes: [] };
      slides.push(slide);
      if (slides.length > 512) throw limit("PowerPoint slide count exceeds the safe limit.");
    } else if (record.type === 4000 || record.type === 4008) {
      if (!slide) throw invalid("PowerPoint slide-list text has no slide.");
      slide.text.push(record.data); slide.textTypes.push(record.type);
    }
  }
  let traversed = 0;
  const walk = async (data: Uint8Array, depth: number): Promise<void> => {
    if (depth > 128) throw limit("PowerPoint record nesting exceeds the safe limit.");
    for (const record of children(data)) {
      traversed += 1;
      if (traversed % 128 === 0) await yieldToHost(signal);
      if (record.type === 12052) throw encrypted();
      if (record.type === 4000 || record.type === 4008) appendText(record.data, record.type, builder);
      else if ((record.version === 15 || record.type === 0xf00d) && record.type !== 1016 && record.type !== 1008) await walk(record.data, depth + 1);
    }
  };
  const slideIds = new Set<number>();
  for (let index = 0; index < slides.length; index += 1) {
    await yieldToHost(signal);
    slide = slides[index]!;
    if (slideIds.has(slide.persistId)) throw invalid("PowerPoint slide list repeats a persist object.");
    slideIds.add(slide.persistId);
    const offset = persist.get(slide.persistId);
    if (offset === undefined) throw invalid("PowerPoint live slide persist object is missing.");
    const live = recordAt(bytes, offset);
    if (live.type !== 1006 || live.version !== 15) throw invalid("PowerPoint live slide record is invalid.");
    builder.appendLine(`Slide ${index + 1}`);
    for (let part = 0; part < slide.text.length; part += 1) appendText(slide.text[part]!, slide.textTypes[part]!, builder);
    await walk(live.data, 0);
    const atom = children(live.data).find((record) => record.type === 1007);
    if (atom && atom.data.byteLength >= 20) {
      const notesId = viewOf(atom.data).getUint32(16, true);
      if (notesId !== 0) {
        const notesReference = notesById.get(notesId);
        const notesOffset = notesReference === undefined ? undefined : persist.get(notesReference.persistId);
        if (notesOffset === undefined) throw invalid("PowerPoint slide notes persist object is missing.");
        const notes = recordAt(bytes, notesOffset);
        if (notes.type !== 1008 || notes.version !== 15) throw invalid("PowerPoint slide notes record is invalid.");
        builder.appendLine("Notes"); await walk(notes.data, 0);
      }
    }
  }
  throwIfAborted(signal);
  return builder.finish();
}

function recordAt(bytes: Uint8Array, offset: number): PptRecord {
  if (offset < 0 || offset + 8 > bytes.byteLength) throw invalid("PowerPoint record header is out of bounds.");
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
  const options = view.getUint16(0, true); const length = view.getUint32(4, true);
  if (length > bytes.byteLength - offset - 8) throw invalid("PowerPoint record payload is out of bounds.");
  return { version: options & 15, instance: options >>> 4, type: view.getUint16(2, true), data: bytes.subarray(offset + 8, offset + 8 + length), end: offset + 8 + length };
}
function appendText(bytes: Uint8Array, type: number, builder: BoundedDocumentTextBuilder): void {
  let text: string;
  if (type === 4000) {
    if (bytes.byteLength % 2 !== 0) throw invalid("PowerPoint UTF-16 text is truncated.");
    try { text = new TextDecoder("utf-16le", { fatal: true }).decode(bytes); }
    catch { throw invalid("PowerPoint text contains malformed Unicode."); }
  } else { text = ""; for (const byte of bytes) text += String.fromCharCode(byte); }
  if (/[\u0000-\u0008\u000c\u000e-\u001f]/u.test(text)) throw invalid("PowerPoint text contains invalid controls.");
  builder.appendLine(text.replace(/\r\n?|\v/g, "\n"));
}
function viewOf(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function invalid(message: string): AttachmentProcessingError { return new AttachmentProcessingError("invalid_document", message); }
function limit(message: string): AttachmentProcessingError { return new AttachmentProcessingError("archive_limit", message); }
function encrypted(): AttachmentProcessingError { return new AttachmentProcessingError("encrypted_document", "Encrypted PowerPoint documents are not supported."); }
