import type { OpenProviderWebSocket } from "../runtime/proxy-websocket.js";
import { createProxyAwareWebSocket } from "../runtime/proxy-websocket.js";
import { storageScopeKey, type StorageScopeKey } from "../storage/scope.js";
import { loadAgentSettings } from "../storage/settings.js";

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
