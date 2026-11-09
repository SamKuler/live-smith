import { sha256 } from "@noble/hashes/sha2.js";

async function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsArrayBuffer(blob);
  });
}

/** Incremental hashing keeps upload reconciliation independent of file size. */
export async function hashFileContent(file: Blob, signal?: AbortSignal): Promise<string | null> {
  const hash = sha256.create();
  try {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || typeof file.slice !== "function") return null;
    for (let offset = 0; offset < file.size; offset += 256 * 1024) {
      if (signal?.aborted) return null;
      hash.update(new Uint8Array(await readBlob(file.slice(offset, Math.min(file.size, offset + 256 * 1024)))));
      if (offset % (4 * 1024 * 1024) === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (signal?.aborted) return null;
    return [...hash.digest()].map(byte => byte.toString(16).padStart(2, "0")).join("");
  } catch { return null; }
  finally { hash.destroy(); }
}
