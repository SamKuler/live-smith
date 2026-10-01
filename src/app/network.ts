import { createProxyAwareWebSocket, type OpenProviderWebSocket } from "../runtime/proxy-websocket.js";
import { createProxyAwareFetch } from "../runtime/proxy-fetch.js";
import { storageScopeKey, type StorageScopeKey } from "../storage/scope.js";
import { loadAgentSettings } from "../storage/settings.js";

const providerFetches = new Map<StorageScopeKey, typeof fetch>();

/** One dynamic network boundary per storage scope, shared by model and audio providers. */
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

const providerWebSockets = new Map<StorageScopeKey, OpenProviderWebSocket>();

/** One dynamic WebSocket network boundary per storage scope. */
export function providerWebSocketForStorage(
  storageDirectory: string | undefined,
): OpenProviderWebSocket {
  const key = storageScopeKey(storageDirectory);
  const existing = providerWebSockets.get(key);
  if (existing) return existing;
  const open = createProxyAwareWebSocket(async () =>
    (await loadAgentSettings(storageDirectory)).networkProxy
  );
  providerWebSockets.set(key, open);
  return open;
}
