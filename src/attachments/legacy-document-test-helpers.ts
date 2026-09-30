import { Buffer } from "node:buffer";

const FREE = 0xffffffff;
const END = 0xfffffffe;
export function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.byteLength; } return output;
}
export function dataView(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

export function compoundBytes(streamInput: Record<string, Uint8Array>): Uint8Array {
  const streams = Object.entries(streamInput).sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const directorySectors = Math.ceil((streams.length + 1) * 128 / 512);
  const miniCount = streams.reduce((sum, [, bytes]) => sum + (bytes.length < 4096 ? Math.ceil(bytes.length / 64) : 0), 0);
  const miniFatSectors = Math.ceil(miniCount / 128);
  const miniStreamSectors = Math.ceil(miniCount * 64 / 512);
  const regularSectors = streams.reduce((sum, [, bytes]) => sum + (bytes.length >= 4096 ? Math.ceil(bytes.length / 512) : 0), 0);
  const nonFatSectors = directorySectors + miniFatSectors + miniStreamSectors + regularSectors;
  let fatSectors = Math.ceil(nonFatSectors / 128);
  while (Math.ceil((nonFatSectors + fatSectors) / 128) !== fatSectors) fatSectors += 1;
  if (fatSectors > 109) throw new Error("Fixture exceeds header DIFAT capacity.");
  const bytes = new Uint8Array((1 + nonFatSectors + fatSectors) * 512);
  const header = dataView(bytes);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  header.setUint16(24, 0x003e, true); header.setUint16(26, 3, true); header.setUint16(28, 0xfffe, true); header.setUint16(30, 9, true); header.setUint16(32, 6, true);
  header.setUint32(44, fatSectors, true); header.setUint32(48, 0, true); header.setUint32(56, 4096, true);
  header.setUint32(60, miniFatSectors ? directorySectors : END, true); header.setUint32(64, miniFatSectors, true); header.setUint32(68, END, true);
  for (let index = 0; index < 109; index += 1) header.setUint32(76 + index * 4, index < fatSectors ? nonFatSectors + index : FREE, true);
  const fat = new Uint32Array(fatSectors * 128).fill(FREE);
  const chain = (start: number, count: number): void => { for (let index = 0; index < count; index += 1) fat[start + index] = index + 1 < count ? start + index + 1 : END; };
  chain(0, directorySectors); chain(directorySectors, miniFatSectors); chain(directorySectors + miniFatSectors, miniStreamSectors);
  const miniFat = new Uint32Array(miniFatSectors * 128).fill(FREE);
  const miniStart = directorySectors + miniFatSectors;
  const writeDirectory = (id: number, name: string, type: number, start: number, size: number): DataView => {
    const offset = 512 + id * 128;
    bytes.set(Buffer.from(`${name}\0`, "utf16le"), offset);
    const entry = new DataView(bytes.buffer, offset, 128);
    entry.setUint16(64, (name.length + 1) * 2, true); entry.setUint8(66, type); entry.setUint8(67, 1);
    entry.setUint32(68, FREE, true); entry.setUint32(72, FREE, true); entry.setUint32(76, FREE, true); entry.setUint32(116, start, true); entry.setBigUint64(120, BigInt(size), true);
    return entry;
  };
  const root = writeDirectory(0, "Root Entry", 5, miniStreamSectors ? miniStart : END, miniCount * 64);
  let miniCursor = 0; let sectorCursor = miniStart + miniStreamSectors;
  const directories: DataView[] = [];
  for (let index = 0; index < streams.length; index += 1) {
    const [name, value] = streams[index]!;
    let start: number;
    if (value.length < 4096) {
      start = value.length ? miniCursor : END;
      bytes.set(value, (miniStart + 1) * 512 + miniCursor * 64);
      const count = Math.ceil(value.length / 64);
      for (let item = 0; item < count; item += 1) miniFat[miniCursor + item] = item + 1 < count ? miniCursor + item + 1 : END;
      miniCursor += count;
    } else {
      start = sectorCursor; const count = Math.ceil(value.length / 512);
      chain(start, count); bytes.set(value, (start + 1) * 512); sectorCursor += count;
    }
    directories.push(writeDirectory(index + 1, name, 2, start, value.length));
  }
  const siblingTree = (start: number, end: number): number => {
    if (start >= end) return FREE;
    const middle = Math.floor((start + end) / 2);
    directories[middle]!.setUint32(68, siblingTree(start, middle), true);
    directories[middle]!.setUint32(72, siblingTree(middle + 1, end), true);
    return middle + 1;
  };
  root.setUint32(76, siblingTree(0, streams.length), true);
  for (let index = 0; index < miniFat.length; index += 1) header.setUint32((directorySectors + 1) * 512 + index * 4, miniFat[index]!, true);
  for (let index = 0; index < fatSectors; index += 1) fat[nonFatSectors + index] = 0xfffffffd;
  for (let index = 0; index < fat.length; index += 1) header.setUint32((nonFatSectors + 1) * 512 + index * 4, fat[index]!, true);
  return bytes;
}

export function wordStreams(text: string, compressed = false): Record<string, Uint8Array> {
  const raw = Buffer.from(text, compressed ? "latin1" : "utf16le");
  const word = new Uint8Array(Math.max(4096, 1024 + raw.length));
  const view = dataView(word);
  view.setUint16(0, 0xa5ec, true); view.setUint16(2, 0x00c1, true); view.setUint16(32, 14, true); view.setUint16(62, 22, true);
  view.setUint32(76, text.length, true); view.setUint16(152, 93, true); view.setUint32(418, 0, true); view.setUint32(422, 21, true);
  word.set(raw, 1024);
  const table = new Uint8Array(21); const tableView = dataView(table);
  table[0] = 2; tableView.setUint32(1, 16, true); tableView.setUint32(9, text.length, true); tableView.setUint32(15, compressed ? 0x40000800 : 1024, true);
  return { WordDocument: word, "0Table": table };
}

export function biffRecord(type: number, data: Uint8Array = new Uint8Array()): Uint8Array {
  const header = new Uint8Array(4); dataView(header).setUint16(0, type, true); dataView(header).setUint16(2, data.length, true); return joinBytes(header, data);
}
export function biffBof(kind: number, version = 0x600): Uint8Array {
  const data = new Uint8Array(16); dataView(data).setUint16(0, version, true); dataView(data).setUint16(2, kind, true); return biffRecord(0x809, data);
}
export function unicodeBiffString(text: string): Uint8Array {
  const header = new Uint8Array(3); dataView(header).setUint16(0, text.length, true); header[2] = 1; return joinBytes(header, Buffer.from(text, "utf16le"));
}
export function workbookBytes(sheetRecords: Uint8Array[], globals: Uint8Array[] = [], name = "Main"): Uint8Array {
  const sheetName = Buffer.from(name, "utf16le"); const bound = new Uint8Array(8 + sheetName.length);
  bound[6] = name.length; bound[7] = 1; bound.set(sheetName, 8);
  const prefix = joinBytes(biffBof(5), ...globals, biffRecord(0x85, bound), biffRecord(0x0a));
  dataView(prefix).setUint32(prefix.length - bound.length - 4, prefix.length, true);
  return joinBytes(prefix, biffBof(0x10), biffRecord(0x81, new Uint8Array(2)), ...sheetRecords, biffRecord(0x0a));
}

export function multiSheetWorkbookBytes(
  sheets: readonly { name: string; records: readonly Uint8Array[]; kind?: 0x10 | 0x20 }[],
  physicalOrder = sheets.map((_, index) => index),
): Uint8Array {
  const bounds = sheets.map((sheet) => {
    const name = Buffer.from(sheet.name, "utf16le");
    const data = new Uint8Array(8 + name.length);
    data[5] = sheet.kind === 0x20 ? 2 : 0; data[6] = sheet.name.length; data[7] = 1; data.set(name, 8);
    return data;
  });
  const headerLength = biffBof(5).length + bounds.reduce((sum, bound) => sum + bound.length + 4, 0) + 4;
  let offset = headerLength;
  const body = physicalOrder.map((index) => {
    const sheet = sheets[index]!;
    const records = joinBytes(biffBof(sheet.kind ?? 0x10), ...(sheet.kind === 0x20 ? [] : [biffRecord(0x81, new Uint8Array(2))]), ...sheet.records, biffRecord(0x0a));
    dataView(bounds[index]!).setUint32(0, offset, true); offset += records.length;
    return records;
  });
  return joinBytes(biffBof(5), ...bounds.map((bound) => biffRecord(0x85, bound)), biffRecord(0x0a), ...body);
}
export function biffCell(type: number, row: number, column: number, value: Uint8Array): Uint8Array {
  const header = new Uint8Array(6); dataView(header).setUint16(0, row, true); dataView(header).setUint16(2, column, true); return biffRecord(type, joinBytes(header, value));
}

export function pptRecord(type: number, data: Uint8Array = new Uint8Array(), version = 0, instance = 0): Uint8Array {
  const header = new Uint8Array(8); const view = dataView(header);
  view.setUint16(0, version | instance << 4, true); view.setUint16(2, type, true); view.setUint32(4, data.length, true); return joinBytes(header, data);
}
export function pptStreams(includeNotes = false): Record<string, Uint8Array> {
  const persist = (id: number): Uint8Array => { const data = new Uint8Array(20); dataView(data).setUint32(0, id, true); return pptRecord(1011, data); };
  const list = pptRecord(4080, joinBytes(persist(3), pptRecord(4000, Buffer.from("音乐 🎵", "utf16le")), persist(2), pptRecord(4008, Buffer.from("Second"))), 15);
  const notesReference = new Uint8Array(20);
  dataView(notesReference).setUint32(0, 4, true); dataView(notesReference).setUint32(12, 96, true);
  const notesList = includeNotes ? pptRecord(4080, pptRecord(1011, notesReference), 15, 2) : new Uint8Array();
  const main = pptRecord(1000, joinBytes(list, notesList), 15);
  const stale = pptRecord(4008, Buffer.from("STALE SECRET"));
  const slide1 = pptRecord(1006, pptRecord(1007, new Uint8Array(24), 2), 15);
  const slideAtom = new Uint8Array(24); if (includeNotes) dataView(slideAtom).setUint32(16, 96, true);
  const textBox = includeNotes ? pptRecord(0xf00d, pptRecord(4008, Buffer.from("Text box"))) : new Uint8Array();
  const slide2 = pptRecord(1006, joinBytes(pptRecord(1007, slideAtom, 2), textBox), 15);
  const notes = includeNotes ? pptRecord(1008, pptRecord(4008, Buffer.from("Speaker notes")), 15) : new Uint8Array();
  const directoryData = new Uint8Array(includeNotes ? 20 : 16); const directoryView = dataView(directoryData);
  directoryView.setUint32(0, (includeNotes ? 4 : 3) << 20 | 1, true); directoryView.setUint32(4, stale.length, true);
  directoryView.setUint32(8, stale.length + main.length, true); directoryView.setUint32(12, stale.length + main.length + slide1.length, true);
  if (includeNotes) directoryView.setUint32(16, stale.length + main.length + slide1.length + slide2.length, true);
  const directory = pptRecord(6002, directoryData);
  const editData = new Uint8Array(28); const editView = dataView(editData);
  editView.setUint32(12, stale.length + main.length + slide1.length + slide2.length + notes.length, true); editView.setUint32(16, 1, true); editView.setUint32(20, includeNotes ? 5 : 4, true);
  const edit = pptRecord(4085, editData);
  const ppt = joinBytes(stale, main, slide1, slide2, notes, directory, edit);
  const currentData = new Uint8Array(20); const currentView = dataView(currentData);
  currentView.setUint32(4, 0xe391c05f, true); currentView.setUint32(8, ppt.length - edit.length, true);
  return { "PowerPoint Document": ppt, "Current User": pptRecord(4086, currentData) };
}
