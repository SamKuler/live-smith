import { TextDecoder } from "node:util";
import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import { assertDocumentAttachmentBytesWithinLimit, AttachmentProcessingError, MAX_DOCUMENT_ATTACHMENT_BYTES } from "./contracts.js";

const FREE = 0xffffffff;
const END = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;
const DIFAT_SECTOR = 0xfffffffc;
const MAX_DIRECTORY_ENTRIES = 4096;
const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export interface CompoundDocument {
  streams: ReadonlyMap<string, Uint8Array>;
  entryNames: readonly string[];
}
interface DirectoryEntry { name: string; type: number; left: number; right: number; child: number; start: number; size: number }

export function isCompoundDocument(bytes: Uint8Array): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

/** Reads MS-CFB sector chains with file-size, cycle and allocation bounds. */
export async function openCompoundDocument(bytes: Uint8Array, signal?: AbortSignal): Promise<CompoundDocument> {
  assertDocumentAttachmentBytesWithinLimit(bytes);
  throwIfAborted(signal);
  if (!isCompoundDocument(bytes) || bytes.byteLength < 512) throw invalid("Compound document header is invalid.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = view.getUint16(26, true);
  const shift = view.getUint16(30, true);
  if (view.getUint16(28, true) !== 0xfffe || view.getUint16(32, true) !== 6 ||
      !((major === 3 && shift === 9) || (major === 4 && shift === 12)) ||
      view.getUint32(56, true) !== 4096) throw invalid("Compound document version or sector size is unsupported.");
  const sectorBytes = 2 ** shift;
  if (bytes.byteLength < sectorBytes || bytes.byteLength % sectorBytes !== 0) throw invalid("Compound document sector data is truncated.");
  const sectorCount = bytes.byteLength / sectorBytes - 1;
  const sector = (id: number): Uint8Array => {
    if (!Number.isInteger(id) || id < 0 || id >= sectorCount) throw invalid("Compound document sector reference is invalid.");
    return bytes.subarray((id + 1) * sectorBytes, (id + 2) * sectorBytes);
  };
  const claimed = new Set<number>();
  const claim = (id: number): void => {
    sector(id);
    if (claimed.has(id)) throw invalid("Compound document sector chains overlap or contain a cycle.");
    claimed.add(id);
  };
  const fatCount = view.getUint32(44, true);
  const difatCount = view.getUint32(72, true);
  if (fatCount === 0 || fatCount > sectorCount || difatCount > sectorCount) throw invalid("Compound document allocation-table counts are invalid.");
  const fatIds: number[] = [];
  const addFatId = (id: number): void => {
    if (id === FREE) return;
    claim(id); fatIds.push(id);
    if (fatIds.length > fatCount) throw invalid("Compound document FAT count disagrees with its header.");
  };
  for (let offset = 76; offset < 512; offset += 4) addFatId(view.getUint32(offset, true));
  let nextDifat = view.getUint32(68, true);
  const difatIds: number[] = [];
  for (let index = 0; index < difatCount; index += 1) {
    claim(nextDifat); difatIds.push(nextDifat);
    const data = sector(nextDifat);
    const table = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let offset = 0; offset < sectorBytes - 4; offset += 4) addFatId(table.getUint32(offset, true));
    nextDifat = table.getUint32(sectorBytes - 4, true);
    if (index % 128 === 0) await yieldToHost(signal);
  }
  if (fatIds.length !== fatCount || (nextDifat !== END && nextDifat !== FREE)) throw invalid("Compound document DIFAT chain is invalid.");
  const fat = new Uint32Array(fatIds.length * (sectorBytes / 4));
  for (let index = 0; index < fatIds.length; index += 1) {
    const data = sector(fatIds[index]!);
    const table = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let offset = 0; offset < sectorBytes; offset += 4) fat[index * sectorBytes / 4 + offset / 4] = table.getUint32(offset, true);
  }
  if (fat.length < sectorCount || fatIds.some((id) => fat[id] !== FAT_SECTOR) || difatIds.some((id) => fat[id] !== DIFAT_SECTOR)) throw invalid("Compound document FAT markers are invalid.");

  const readChain = async (start: number, expectedSize?: number, limit = MAX_DOCUMENT_ATTACHMENT_BYTES): Promise<Uint8Array> => {
    const ids: number[] = [];
    let current = start;
    while (current !== END) {
      claim(current); ids.push(current);
      if (ids.length * sectorBytes > Math.ceil(limit / sectorBytes) * sectorBytes) throw tooLarge("Compound document stream exceeds the safe extraction limit.");
      current = fat[current]!;
      if (ids.length % 128 === 0) await yieldToHost(signal);
    }
    const capacity = ids.length * sectorBytes;
    if (expectedSize !== undefined && (expectedSize > capacity || (expectedSize === 0 ? capacity !== 0 : capacity - expectedSize >= sectorBytes))) throw invalid("Compound document stream length disagrees with its sector chain.");
    const size = expectedSize ?? capacity;
    if (size > limit) throw tooLarge("Compound document stream exceeds the safe extraction limit.");
    const data = new Uint8Array(size);
    for (let index = 0; index < ids.length; index += 1) data.set(sector(ids[index]!).subarray(0, Math.min(sectorBytes, size - index * sectorBytes)), index * sectorBytes);
    return data;
  };
  const directoryBytes = await readChain(view.getUint32(48, true), undefined, MAX_DIRECTORY_ENTRIES * 128);
  if (major === 4 && view.getUint32(40, true) !== directoryBytes.byteLength / sectorBytes) throw invalid("Compound document directory-sector count is invalid.");
  if (major === 3 && view.getUint32(40, true) !== 0) throw invalid("Compound document directory-sector count is invalid.");
  const directories: DirectoryEntry[] = [];
  for (let offset = 0; offset < directoryBytes.byteLength; offset += 128) {
    if (offset % (128 * 128) === 0) await yieldToHost(signal);
    const entry = new DataView(directoryBytes.buffer, directoryBytes.byteOffset + offset, 128);
    const type = entry.getUint8(66);
    if (![0, 1, 2, 5].includes(type)) throw invalid("Compound document directory type is invalid.");
    let name = "";
    if (type !== 0) {
      const nameBytes = entry.getUint16(64, true);
      if (nameBytes < 2 || nameBytes > 64 || nameBytes % 2 !== 0 || entry.getUint16(nameBytes - 2, true) !== 0) throw invalid("Compound document directory name is malformed.");
      try { name = new TextDecoder("utf-16le", { fatal: true }).decode(directoryBytes.subarray(offset, offset + nameBytes - 2)); }
      catch { throw invalid("Compound document directory name encoding is invalid."); }
      if (!name || /[\u0000/\\]/u.test(name)) throw invalid("Compound document directory name is unsafe.");
    }
    const size64 = entry.getBigUint64(120, true);
    if (size64 > BigInt(MAX_DOCUMENT_ATTACHMENT_BYTES)) throw tooLarge("Compound document stream length exceeds the safe limit.");
    if (major === 3 && entry.getUint32(124, true) !== 0) throw invalid("Compound document version-3 stream length is invalid.");
    directories.push({ name, type, left: entry.getUint32(68, true), right: entry.getUint32(72, true), child: entry.getUint32(76, true), start: entry.getUint32(116, true), size: Number(size64) });
  }
  const root = directories[0];
  if (!root || root.type !== 5 || directories.slice(1).some((entry) => entry.type === 5)) throw invalid("Compound document root directory is invalid.");
  const miniStream = await readChain(root.size === 0 ? END : root.start, root.size);
  const miniFatCount = view.getUint32(64, true);
  if (miniFatCount > sectorCount) throw invalid("Compound document mini-FAT count is invalid.");
  const miniFatData = await readChain(miniFatCount === 0 ? END : view.getUint32(60, true), miniFatCount * sectorBytes);
  const miniFatView = new DataView(miniFatData.buffer, miniFatData.byteOffset, miniFatData.byteLength);
  const miniClaimed = new Set<number>();
  const readMiniChain = async (entry: DirectoryEntry): Promise<Uint8Array> => {
    const data = new Uint8Array(entry.size);
    let current = entry.size === 0 ? END : entry.start;
    let count = 0;
    while (current !== END) {
      if (current >= miniFatData.byteLength / 4 || current >= miniStream.byteLength / 64 || miniClaimed.has(current)) throw invalid("Compound document mini-sector chain is invalid or cyclic.");
      miniClaimed.add(current);
      if (count * 64 >= entry.size) throw invalid("Compound document mini-sector chain exceeds its stream length.");
      data.set(miniStream.subarray(current * 64, current * 64 + Math.min(64, entry.size - count * 64)), count * 64);
      count += 1; current = miniFatView.getUint32(current * 4, true);
      if (count % 128 === 0) await yieldToHost(signal);
    }
    if (count !== Math.ceil(entry.size / 64)) throw invalid("Compound document mini-stream is truncated.");
    return data;
  };
  const streams = new Map<string, Uint8Array>();
  const entryNames: string[] = [];
  const visited = new Set<number>([0]);
  const paths = new Set<string>();
  const pending = [{ id: root.child, parent: "", depth: 0 }];
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (item.id === FREE) continue;
    const entry = directories[item.id];
    if (!entry || entry.type === 0 || entry.type === 5 || visited.has(item.id) || item.depth > 256) throw invalid("Compound document directory links are invalid or cyclic.");
    visited.add(item.id);
    const path = `${item.parent}${entry.name}`;
    if (paths.has(path.toLowerCase())) throw invalid("Compound document contains duplicate stream paths.");
    paths.add(path.toLowerCase()); entryNames.push(path);
    pending.push({ id: entry.left, parent: item.parent, depth: item.depth }, { id: entry.right, parent: item.parent, depth: item.depth });
    if (entry.type === 1) pending.push({ id: entry.child, parent: `${path}/`, depth: item.depth + 1 });
    else {
      if (entry.child !== FREE) throw invalid("Compound document stream contains a child directory.");
      streams.set(path, entry.size < 4096 ? await readMiniChain(entry) : await readChain(entry.start, entry.size));
    }
    if (visited.size % 128 === 0) await yieldToHost(signal);
  }
  if (directories.some((entry, index) => entry.type !== 0 && !visited.has(index))) throw invalid("Compound document contains unreachable directory entries.");
  throwIfAborted(signal);
  return { streams, entryNames };
}

function invalid(message: string): AttachmentProcessingError { return new AttachmentProcessingError("invalid_document", message); }
function tooLarge(message: string): AttachmentProcessingError { return new AttachmentProcessingError("archive_limit", message); }
