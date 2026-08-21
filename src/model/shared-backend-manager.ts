import { realpath } from "node:fs/promises";
import * as path from "node:path";

import {
  ModelBackendManager,
  type ModelBackendManagerOptions,
} from "./backend-registry.js";

export interface SharedModelBackendManagerLease {
  readonly manager: ModelBackendManager;
  release(): Promise<void>;
}

interface SharedManagerEntry {
  readonly manager: ModelBackendManager;
  refs: number;
  closePromise?: Promise<void>;
  poisonError?: Error;
}

const managersByStorageDirectory = new Map<string, SharedManagerEntry>();

export async function acquireSharedModelBackendManager(
  storageDirectory: string | undefined,
  options: ModelBackendManagerOptions = {},
): Promise<SharedModelBackendManagerLease> {
  if (storageDirectory === undefined) {
    return isolatedLease(new ModelBackendManager(undefined, options));
  }

  const storageKey = await canonicalModelStorageKey(storageDirectory);
  for (;;) {
    const existing = managersByStorageDirectory.get(storageKey);
    if (!existing) {
      const entry = createEntry(storageKey, options);
      managersByStorageDirectory.set(storageKey, entry);
      return sharedLease(entry, storageKey);
    }
    if (existing.closePromise) {
      await existing.closePromise;
      continue;
    }
    if (existing.poisonError) throw existing.poisonError;
    existing.refs += 1;
    return sharedLease(existing, storageKey);
  }
}

export async function canonicalModelStorageKey(
  storageDirectory: string,
): Promise<string> {
  let candidate = path.resolve(storageDirectory);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const canonicalAncestor = await realpath(candidate);
      return path.join(canonicalAncestor, ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function createEntry(
  storageDirectory: string,
  options: ModelBackendManagerOptions,
): SharedManagerEntry {
  const { onPoison, ...managerOptions } = options;
  let entry!: SharedManagerEntry;
  const manager = new ModelBackendManager(storageDirectory, {
    ...managerOptions,
    onPoison(error) {
      entry.poisonError ??= error;
      onPoison?.(error);
    },
  });
  entry = { manager, refs: 1 };
  return entry;
}

function sharedLease(
  entry: SharedManagerEntry,
  storageKey: string,
): SharedModelBackendManagerLease {
  let releasePromise: Promise<void> | undefined;
  return {
    manager: entry.manager,
    release() {
      releasePromise ??= releaseSharedEntry(entry, storageKey);
      return releasePromise;
    },
  };
}

async function releaseSharedEntry(
  entry: SharedManagerEntry,
  storageKey: string,
): Promise<void> {
  entry.refs -= 1;
  if (entry.refs > 0) return;
  if (entry.closePromise) return entry.closePromise;

  const closePromise = closeSharedEntry(entry, storageKey);
  entry.closePromise = closePromise;
  return closePromise;
}

async function closeSharedEntry(
  entry: SharedManagerEntry,
  storageKey: string,
): Promise<void> {
  try {
    await entry.manager.close();
    if (entry.poisonError) throw entry.poisonError;
    if (managersByStorageDirectory.get(storageKey) === entry) {
      managersByStorageDirectory.delete(storageKey);
    }
  } catch (error) {
    entry.poisonError ??= error instanceof Error
      ? error
      : new Error("The shared model backend manager could not be stopped.");
    throw entry.poisonError;
  }
}

function isolatedLease(
  manager: ModelBackendManager,
): SharedModelBackendManagerLease {
  let releasePromise: Promise<void> | undefined;
  return {
    manager,
    release() {
      releasePromise ??= manager.close();
      return releasePromise;
    },
  };
}
