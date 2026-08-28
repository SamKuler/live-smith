import { storageScopeKey } from "../storage/scope.js";

const claimsByStorage = new Map<
  string | symbol,
  Map<string, Set<symbol>>
>();

export function claimSession(
  storageDirectory: string | undefined,
  sessionId: string,
  owner: symbol,
): void {
  const storageKey = storageScopeKey(storageDirectory);
  const claims = claimsByStorage.get(storageKey) ?? new Map();
  const owners = claims.get(sessionId) ?? new Set();
  owners.add(owner);
  claims.set(sessionId, owners);
  claimsByStorage.set(storageKey, claims);
}

export function sessionIsClaimedByAnotherOwner(
  storageDirectory: string | undefined,
  sessionId: string,
  owner: symbol,
): boolean {
  const owners = claimsByStorage.get(storageScopeKey(storageDirectory))?.get(
    sessionId,
  );
  return owners !== undefined && [...owners].some((candidate) => candidate !== owner);
}

export function releaseSessionClaims(
  storageDirectory: string | undefined,
  owner: symbol,
): void {
  const storageKey = storageScopeKey(storageDirectory);
  const claims = claimsByStorage.get(storageKey);
  if (!claims) return;
  for (const [sessionId, owners] of claims) {
    owners.delete(owner);
    if (owners.size === 0) claims.delete(sessionId);
  }
  if (claims.size === 0) claimsByStorage.delete(storageKey);
}
