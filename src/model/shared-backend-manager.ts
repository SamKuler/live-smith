import {
  ModelBackendManager,
  type ModelBackendManagerOptions,
} from "./backend-registry.js";
import {
  throwIfAborted,
  waitForPromiseWithSignal,
} from "../runtime/host.js";
import { canonicalStorageDirectory } from "../storage/scope.js";

export interface SharedModelBackendManagerLease {
  readonly manager: ModelBackendManager;
  release(): Promise<void>;
}

interface SharedManagerEntry {
  readonly manager: ModelBackendManager;
  refs: number;
  closePromise?: Promise<void>;
}

const managersByStorageDirectory = new Map<string, SharedManagerEntry>();

export async function acquireSharedModelBackendManager(
  storageDirectory: string | undefined,
  options: ModelBackendManagerOptions = {},
  signal?: AbortSignal,
): Promise<SharedModelBackendManagerLease> {
  throwIfAborted(signal);
  if (storageDirectory === undefined) {
    return isolatedLease(new ModelBackendManager(undefined, options));
  }

  const storageKey = await waitForPromiseWithSignal(
    canonicalStorageDirectory(storageDirectory),
    signal,
  );
  for (;;) {
    throwIfAborted(signal);
    const existing = managersByStorageDirectory.get(storageKey);
    if (!existing) {
      const entry = createEntry(storageKey, options);
      managersByStorageDirectory.set(storageKey, entry);
      return sharedLease(entry, storageKey);
    }
    if (existing.closePromise) {
      await waitForPromiseWithSignal(existing.closePromise, signal);
      continue;
    }
    existing.refs += 1;
    return sharedLease(existing, storageKey);
  }
}

function createEntry(
  storageDirectory: string,
  options: ModelBackendManagerOptions,
): SharedManagerEntry {
  const manager = new ModelBackendManager(storageDirectory, options);
  const entry = { manager, refs: 1 };
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
    if (managersByStorageDirectory.get(storageKey) === entry) {
      managersByStorageDirectory.delete(storageKey);
    }
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error("The shared model backend manager could not be stopped.");
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
