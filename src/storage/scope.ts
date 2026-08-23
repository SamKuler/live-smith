import { lstat, readlink, realpath } from "node:fs/promises";
import * as path from "node:path";

const memoryStorageScopeKey = Symbol("live-smith-memory-storage");

export type StorageScopeKey = string | typeof memoryStorageScopeKey;

export function canonicalStorageDirectory(
  storageDirectory: undefined,
): Promise<undefined>;
export function canonicalStorageDirectory(
  storageDirectory: string,
): Promise<string>;
export async function canonicalStorageDirectory(
  storageDirectory: string | undefined,
): Promise<string | undefined> {
  if (storageDirectory === undefined) return undefined;

  let candidate = path.resolve(storageDirectory);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const canonicalAncestor = await realpath(candidate);
      return path.join(canonicalAncestor, ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let metadata: Awaited<ReturnType<typeof lstat>> | undefined;
      try {
        metadata = await lstat(candidate);
      } catch (lstatError) {
        if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw lstatError;
        }
      }
      if (metadata?.isSymbolicLink()) {
        candidate = path.resolve(
          path.dirname(candidate),
          await readlink(candidate),
        );
        continue;
      }
      if (metadata !== undefined) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

export function storageScopeKey(
  storageDirectory: string | undefined,
): StorageScopeKey {
  return storageDirectory === undefined
    ? memoryStorageScopeKey
    : path.resolve(storageDirectory);
}
