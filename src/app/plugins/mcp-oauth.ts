import { randomBytes, randomUUID } from "node:crypto";
import { URL } from "node:url";
import { clearTimeout, setTimeout } from "node:timers";
import {
  auth, extractWWWAuthenticateParams, RegistrationRejectedError,
  type FetchLike, type AuthProvider, type OAuthClientProvider, type OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import { createHostAbortController, combineHostAbortSignals, throwIfAborted } from "../../runtime/host.js";
import { startOAuthLoopbackCallback } from "../../runtime/oauth-loopback.js";
import { createSystemBrowserOpener } from "../../runtime/system-browser.js";
import { canonicalStorageDirectory } from "../../storage/scope.js";
import { withStorageTransaction, type StorageTransactionContext, isStorageCommitOutcomeUnknownError } from "../../storage/persistence.js";
import { readMcpOAuthCredentialInTransaction, saveMcpOAuthCredentialInTransaction,
  deleteMcpOAuthCredentialsInTransaction, type McpOAuthCredential } from "../../storage/mcp-oauth.js";
import { loadAgentSettings } from "../../storage/settings.js";
import { McpAuthorizationRequiredError, McpOAuthError, type McpOAuthState, type McpAuthProvider } from "../../plugins/mcp/oauth-contract.js";
import { validateRemoteUrl } from "../../plugins/mcp/config.js";
import { readBoundedText } from "../../model/transports/response-body.js";
import { providerFetchForStorage } from "../network.js";
import { SessionMutationFence } from "../session/session-mutation-fence.js";
import { invalidateGlobalState } from "../session/session-state-events.js";
import { resolveMcpOAuthOwnerInTransaction, type McpOAuthOwner } from "./mcp-oauth-owner.js";

const refreshFence = new SessionMutationFence();
type PendingLogin = { controller: AbortController; owner: string };
const pendingLogins = new Map<string, PendingLogin>();
const changeSource = Symbol("mcp-oauth");
const callbackPath = "/mcp/oauth/callback";
// The SDK propagates fetch TypeErrors instead of treating them as absent optional discovery.
class McpOAuthFetchError extends TypeError {}
const keyFor = (directory: string, id: string) => JSON.stringify([directory, id]);
const notify = (directory: string) => invalidateGlobalState(directory, { source: changeSource });

async function ownedRecord(
  transaction: StorageTransactionContext, directory: string, owner: McpOAuthOwner, generation: string,
): Promise<McpOAuthCredential> {
  const currentOwner = await resolveMcpOAuthOwnerInTransaction(transaction, directory, owner.connectionId);
  const current = await readMcpOAuthCredentialInTransaction(transaction, directory, owner.connectionId);
  if (currentOwner.fingerprint !== owner.fingerprint || current?.owner !== owner.fingerprint || current.generation !== generation) {
    throw new McpOAuthError("This MCP connection or sign-in changed. Sign in again from its current settings.");
  }
  return current;
}

function oauthFetch(fetchImpl: typeof fetch, signal: AbortSignal, assertOwner: () => Promise<unknown>) {
  return async (input: Parameters<FetchLike>[0], init?: RequestInit, headersOnly = false): Promise<Response> => {
    const url = String(input);
    try { validateRemoteUrl(url); } catch { throw new McpOAuthFetchError("MCP OAuth endpoints require HTTPS or loopback HTTP without embedded credentials."); }
    throwIfAborted(signal);
    await assertOwner();
    const controller = createHostAbortController();
    const timer = setTimeout(() => controller.abort(new McpOAuthFetchError("MCP sign-in network request timed out.")), 30_000);
    timer.unref();
    const combined = combineHostAbortSignals([signal, controller.signal, ...(init?.signal ? [init.signal] : [])]);
    try {
      const response = await fetchImpl(input, { ...init, signal: combined, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        throw new McpOAuthFetchError("MCP OAuth endpoint redirects are not supported.");
      }
      if (headersOnly) {
        void response.body?.cancel().catch(() => undefined);
        return response;
      }
      const text = response.body ? await readBoundedText(response.body, 512 * 1024, combined, false,
        () => new McpOAuthFetchError("MCP OAuth response exceeded its byte limit.")) : "";
      throwIfAborted(combined);
      return new Proxy(response, { get(target, property) {
        if (property === "text") return async () => text;
        if (property === "json") return async () => JSON.parse(text);
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      } });
    } finally { clearTimeout(timer); }
  };
}

function sdkProvider(input: {
  directory: string; owner: McpOAuthOwner; generation: string; redirectUri: string; signal: AbortSignal;
  interactive?: { state: string; open(url: string, signal: AbortSignal): Promise<void> };
}): OAuthClientProvider {
  let discovery: OAuthDiscoveryState | undefined;
  let verifier: string | undefined;
  const read = () => withStorageTransaction(input.directory, async (transaction) => {
    throwIfAborted(input.signal);
    return ownedRecord(transaction, input.directory, input.owner, input.generation);
  });
  const update = (modify: (record: McpOAuthCredential) => void) => withStorageTransaction(input.directory, async (transaction) => {
    throwIfAborted(input.signal);
    const record = await ownedRecord(transaction, input.directory, input.owner, input.generation);
    modify(record);
    throwIfAborted(input.signal);
    await saveMcpOAuthCredentialInTransaction(transaction, input.directory, record, input.generation);
  });
  return {
    redirectUrl: input.redirectUri,
    clientMetadata: { client_name: "Live Smith", redirect_uris: [input.redirectUri],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
    state: () => input.interactive?.state ?? "",
    clientInformation: async (context) => {
      const record = await read();
      if (!input.interactive && (!record.tokens || context?.issuer !== record.tokens.issuer)) throw new McpAuthorizationRequiredError();
      if (input.owner.oauth.clientId) return { client_id: input.owner.oauth.clientId, ...(context ? { issuer: context.issuer } : {}) };
      if (!input.interactive && (!record.client || context?.issuer !== record.client.issuer)) throw new McpAuthorizationRequiredError();
      return record.client;
    },
    saveClientInformation: async (client) => {
      if (!input.interactive) throw new McpAuthorizationRequiredError();
      await update((record) => { record.client = client; });
    },
    tokens: async () => (await read()).tokens,
    saveTokens: async (tokens) => {
      await update((record) => { record.tokens = tokens; });
    },
    saveCodeVerifier: (value) => {
      if (!input.interactive) throw new McpAuthorizationRequiredError();
      verifier = value;
    },
    codeVerifier: () => {
      if (!verifier) throw new McpOAuthError("MCP sign-in is no longer pending. Start sign-in again.");
      return verifier;
    },
    redirectToAuthorization: async (url) => {
      if (!input.interactive) throw new McpAuthorizationRequiredError();
      await read();
      validateRemoteUrl(url.href);
      await input.interactive.open(url.href, input.signal);
    },
    saveDiscoveryState: async (state) => {
      if (input.interactive && !input.owner.oauth.clientId && !(await read()).client && !state.authorizationServerMetadata?.registration_endpoint) {
        throw new McpOAuthError("This server does not offer dynamic client registration. Configure a registered public client ID and its callback port.");
      }
      discovery = state;
    },
    discoveryState: () => discovery,
    invalidateCredentials: async (scope) => {
      if (scope === "discovery") { discovery = undefined; return; }
      if (scope === "verifier") { verifier = undefined; return; }
      await update((record) => {
        if (scope === "all" || scope === "tokens") delete record.tokens;
        if (scope === "all" || scope === "client") delete record.client;
      });
      notify(input.directory);
    },
  };
}

function safeOAuthError(error: unknown): Error {
  if (error instanceof McpOAuthFetchError) return new McpOAuthError(error.message);
  if (error instanceof McpOAuthError || error instanceof McpAuthorizationRequiredError || isStorageCommitOutcomeUnknownError(error)) return error;
  if (error instanceof RegistrationRejectedError) return new McpOAuthError("MCP client registration was rejected. Configure a registered public client ID and its callback port.");
  return new McpOAuthError("MCP sign-in failed. Check the server's OAuth configuration and try again.");
}

export function createMcpOAuthAuthProvider(
  storageDirectory: string, connectionId: string, signal: AbortSignal, fetchImpl?: typeof fetch,
): McpAuthProvider {
  const requestTokens = new WeakMap<Response, string>();
  let loaded: Promise<AuthProvider> | undefined;
  let generation: string | undefined;
  const provider = () => loaded ??= loadMcpOAuthAuthProvider(storageDirectory, connectionId, signal,
    (response) => requestTokens.get(response), (value) => { generation = value; }, fetchImpl);
  return { get generation() { return generation; }, token: async () => (await provider()).token(),
    onUnauthorized: async (context) => (await provider()).onUnauthorized!(context),
    recordResponse(response, headers) {
      const entries = Array.isArray(headers) ? headers
        : headers && "entries" in headers && typeof headers.entries === "function" ? [...headers.entries()] : Object.entries(headers ?? {});
      const authorization = entries.find(([name]) => name.toLowerCase() === "authorization")?.[1];
      if (authorization?.startsWith("Bearer ")) requestTokens.set(response, authorization.slice(7));
    },
  };
}

async function loadMcpOAuthAuthProvider(
  storageDirectory: string, connectionId: string, signal: AbortSignal,
  requestToken: (response: Response) => string | undefined, admittedGeneration: (generation: string) => void, fetchImpl?: typeof fetch,
): Promise<AuthProvider> {
  const directory = await canonicalStorageDirectory(storageDirectory);
  const snapshot = await withStorageTransaction(directory, async (transaction) => {
    const owner = await resolveMcpOAuthOwnerInTransaction(transaction, directory, connectionId);
    const record = await readMcpOAuthCredentialInTransaction(transaction, directory, connectionId);
    if (!record?.tokens || record.owner !== owner.fingerprint) throw new McpAuthorizationRequiredError();
    return { owner, record };
  });
  const { owner, record } = snapshot;
  admittedGeneration(record.generation);
  const read = () => withStorageTransaction(directory, (transaction) => ownedRecord(transaction, directory, owner, record.generation));
  return {
    async token() {
      throwIfAborted(signal);
      const current = await read();
      if (!current.tokens) throw new McpAuthorizationRequiredError();
      return current.tokens.access_token;
    },
    async onUnauthorized(context) {
      const rejectedToken = requestToken(context.response);
      if (rejectedToken === undefined) throw new McpAuthorizationRequiredError();
      await refreshFence.run(keyFor(directory, connectionId), signal, async () => {
        try {
          const current = await read();
          if (!current.tokens) throw new McpAuthorizationRequiredError();
          if (current.tokens.access_token !== rejectedToken) return;
          if (!current.tokens.refresh_token) throw new McpAuthorizationRequiredError();
          const provider = sdkProvider({ directory, owner, generation: record.generation, redirectUri: record.redirectUri, signal });
          const challenge = extractWWWAuthenticateParams(context.response);
          await auth(provider, { serverUrl: owner.serverUrl,
            ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
            ...(challenge.scope ? { scope: challenge.scope } : {}),
            fetchFn: oauthFetch(fetchImpl ?? providerFetchForStorage(directory), signal, read),
          });
        } catch (error) {
          throwIfAborted(signal);
          if (error instanceof McpAuthorizationRequiredError) {
            await withStorageTransaction(directory, async (transaction) => {
              const latest = await ownedRecord(transaction, directory, owner, record.generation);
              if (latest.tokens?.access_token === rejectedToken) {
                delete latest.tokens;
                await saveMcpOAuthCredentialInTransaction(transaction, directory, latest, record.generation);
              }
            });
            notify(directory);
          }
          throw safeOAuthError(error);
        }
      });
    },
  };
}

export async function signInMcpOAuth(input: {
  storageDirectory: string; connectionId: string; signal: AbortSignal;
  openBrowser?: (url: string, signal?: AbortSignal) => Promise<void>;
  fetchImpl?: typeof fetch;
  onProgress?: (message: string) => Promise<void> | void;
}): Promise<void> {
  const directory = await canonicalStorageDirectory(input.storageDirectory);
  const key = keyFor(directory, input.connectionId);
  const controller = createHostAbortController();
  const signal = combineHostAbortSignals([input.signal, controller.signal]);
  let pending: PendingLogin | undefined;
  let callback: Awaited<ReturnType<typeof startOAuthLoopbackCallback>> | undefined;
  try {
    const snapshot = await withStorageTransaction(directory, async (transaction) => {
      const owner = await resolveMcpOAuthOwnerInTransaction(transaction, directory, input.connectionId);
      const prior = await readMcpOAuthCredentialInTransaction(transaction, directory, input.connectionId);
      return { owner, prior: prior?.owner === owner.fingerprint ? prior : undefined, expectedGeneration: prior?.generation ?? null };
    });
    const { owner, prior } = snapshot;
    const previous = pendingLogins.get(key);
    if (previous && !previous.controller.signal.aborted && previous.owner === owner.fingerprint) {
      throw new McpOAuthError("Sign-in is already pending for this MCP connection.");
    }
    previous?.controller.abort(new McpOAuthError("The MCP connection changed during sign-in."));
    pending = { controller, owner: owner.fingerprint };
    pendingLogins.set(key, pending);
    const state = randomBytes(32).toString("base64url");
    const port = owner.oauth.callbackPort ?? (prior ? Number(new URL(prior.redirectUri).port) : 0);
    try {
      callback = await startOAuthLoopbackCallback({ port, path: callbackPath, expectedState: state, signal,
        redirectHost: "127.0.0.1", successMessage: "Authorization received. You can return to Live Smith." });
    } catch {
      throwIfAborted(signal);
      throw new McpOAuthError("The MCP OAuth callback port is unavailable. Close the application using it, or sign out to register a new dynamic callback port.");
    }
    void callback.completion.catch(() => undefined);
    const generation = randomUUID();
    await withStorageTransaction(directory, async (transaction) => {
      const current = await resolveMcpOAuthOwnerInTransaction(transaction, directory, input.connectionId);
      if (current.fingerprint !== owner.fingerprint) throw new McpOAuthError("The MCP connection changed before sign-in. Open its current settings and try again.");
      throwIfAborted(signal);
      await saveMcpOAuthCredentialInTransaction(transaction, directory, {
        connectionId: owner.connectionId, owner: owner.fingerprint, generation, redirectUri: callback!.redirectUri,
        ...(owner.pluginId ? { pluginId: owner.pluginId } : {}), ...(owner.serverId ? { serverId: owner.serverId } : {}),
        ...(prior?.client && prior.redirectUri === callback!.redirectUri ? { client: prior.client } : {}),
      }, snapshot.expectedGeneration);
    });
    notify(directory);
    const read = () => withStorageTransaction(directory, (transaction) => ownedRecord(transaction, directory, owner, generation));
    const provider = sdkProvider({ directory, owner, generation, signal, redirectUri: callback.redirectUri,
      interactive: { state, open: input.openBrowser ?? createSystemBrowserOpener({ allowLoopbackHttp: true }) } });
    const fetchFn = oauthFetch(input.fetchImpl ?? providerFetchForStorage(directory), signal, read);
    await input.onProgress?.("Waiting for MCP sign-in in the browser…");
    const challenge = extractWWWAuthenticateParams(await fetchFn(owner.serverUrl, { method: "GET", headers: { ...owner.headers, Accept: "application/json" } }, true));
    const options = { serverUrl: owner.serverUrl, fetchFn,
      ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
      ...(challenge.scope ? { scope: challenge.scope } : {}) };
    const result = await auth(provider, { ...options, forceReauthorization: true });
    if (result !== "REDIRECT") throw new McpOAuthError("The MCP server did not start an interactive authorization flow.");
    const response = await callback.completion;
    await auth(provider, { ...options, authorizationCode: response.code, ...(response.iss === undefined ? {} : { iss: response.iss }) });
    throwIfAborted(signal);
  } catch (error) {
    throwIfAborted(signal);
    throw safeOAuthError(error);
  } finally {
    callback?.cancel();
    if (pending && pendingLogins.get(key) === pending) pendingLogins.delete(key);
    notify(directory);
  }
}

export async function signOutMcpOAuth(storageDirectory: string, connectionId: string): Promise<void> {
  const directory = await canonicalStorageDirectory(storageDirectory);
  pendingLogins.get(keyFor(directory, connectionId))?.controller.abort(new McpOAuthError("MCP sign-in was canceled."));
  await withStorageTransaction(directory, (transaction) => deleteMcpOAuthCredentialsInTransaction(transaction, directory, { connectionId }));
  notify(directory);
}

/** Local projection only: never discovery, refresh, or another network operation. */
export async function mcpOAuthStates(storageDirectory: string | undefined): Promise<McpOAuthState[]> {
  if (!storageDirectory) return [];
  const directory = await canonicalStorageDirectory(storageDirectory);
  return withStorageTransaction(directory, async (transaction) => {
    const connections = (await loadAgentSettings(directory)).integrationConnections?.connections.filter((connection) => connection.oauth) ?? [];
    const states: McpOAuthState[] = [];
    for (const connection of connections) {
      try {
        const owner = await resolveMcpOAuthOwnerInTransaction(transaction, directory, connection.id);
        const record = await readMcpOAuthCredentialInTransaction(transaction, directory, connection.id);
        const matches = record?.owner === owner.fingerprint;
        const pending = pendingLogins.get(keyFor(directory, connection.id));
        states.push({ connectionId: connection.id, generation: matches ? record.generation : "none",
          status: pending?.owner === owner.fingerprint && !pending.controller.signal.aborted ? "signing-in" : matches && record.tokens ? "signed-in" : "signed-out" });
      } catch { states.push({ connectionId: connection.id, status: "unavailable", generation: "none" }); }
    }
    return states;
  });
}
