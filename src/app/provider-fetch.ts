import { createProxyAwareFetch } from "../runtime/proxy-fetch.js";
import { storageScopeKey, type StorageScopeKey } from "../storage/scope.js";
import { loadAgentSettings } from "../storage/settings.js";

const providerFetches = new Map<StorageScopeKey, typeof fetch>();

/** One dynamic network boundary per storage scope, shared by Direct API and OAuth. */
export function providerFetchForStorage(
  storageDirectory: string | undefined,
): typeof fetch {
  const key = storageScopeKey(storageDirectory);
  const existing = providerFetches.get(key);
  if (existing) return existing;
  const providerFetch = createProxyAwareFetch(async () =>
    (await loadAgentSettings(storageDirectory)).networkProxy
  );
  providerFetches.set(key, providerFetch);
  return providerFetch;
}
