import { createHash } from "node:crypto";
import { readSunoMusicService } from "../audio-services/suno-catalog.js";
import { throwIfAborted, waitForPromiseWithSignal } from "../runtime/host.js";
import { withStorageTransaction } from "../storage/persistence.js";
import { loadAgentSettings } from "../storage/settings.js";
import { SunoSessions } from "../storage/suno-sessions.js";
import { isIntegrationConnectionForProvider } from "../plugins/integration-connections.js";
import type { SunoModelCatalogView } from "../ui/chat-state.js";
import { ChatBridgeConflictError } from "./chat-bridge.js";
import { persistRotatedSunoSession } from "./suno-session-manager.js";

/** One dialog-owned catalog. Neither credentials nor catalog results are persisted. */
export class SunoModelCatalog {
  private entry: { serviceId: string; fingerprint: string; models?: SunoModelCatalogView["models"] } | undefined;

  constructor(
    private readonly storageDirectory: string | undefined,
    private readonly providerFetch: typeof fetch,
    private readonly read: typeof readSunoMusicService = readSunoMusicService,
  ) {}

  // Authentication invalidates only its owner, including same-Cookie reimports.
  clear(serviceId?: string): void {
    if (serviceId === undefined || this.entry?.serviceId === serviceId) this.entry = undefined;
  }

  async load(serviceId: string, signal: AbortSignal): Promise<void> {
    this.clear();
    throwIfAborted(signal);
    const owner = await this.owner(serviceId);
    throwIfAborted(signal);
    const entry: NonNullable<SunoModelCatalog["entry"]> = { serviceId, fingerprint: owner.fingerprint };
    this.entry = entry;
    try {
      const catalog = await waitForPromiseWithSignal(
        this.read(owner.session, { query: "catalog" }, signal, this.providerFetch,
          (previous, next, refreshSignal) => persistRotatedSunoSession(
            this.storageDirectory, serviceId, owner.session.accountId, previous, next, refreshSignal,
          )), signal,
      );
      throwIfAborted(signal);
      const current = await this.owner(serviceId);
      throwIfAborted(signal);
      if (this.entry !== entry || current.fingerprint !== entry.fingerprint) {
        throw new ChatBridgeConflictError("The saved Suno connection changed. Load its models again.");
      }
      if (catalog.query !== "catalog" || catalog.models.length > 100) {
        throw new Error("Suno.com audio service: invalid model catalog.");
      }
      entry.models = catalog.models.map(({ id, name, canUse, isDefault }) => ({
        id, name,
        ...(typeof canUse === "boolean" ? { canUse } : {}),
        ...(typeof isDefault === "boolean" ? { isDefault } : {}),
      }));
    } catch (error) {
      if (this.entry === entry) this.clear();
      throw error;
    }
  }

  async view(integrationConnectionsRevision: string | undefined): Promise<SunoModelCatalogView | undefined> {
    const entry = this.entry;
    if (!entry?.models) return undefined;
    try {
      const current = await this.owner(entry.serviceId);
      if (this.entry === entry && current.fingerprint === entry.fingerprint) {
        // A settings read begun before a concurrent save cannot publish the new
        // revision. Keep the valid account catalog for the next fresh snapshot.
        if (current.revision !== integrationConnectionsRevision) return undefined;
        return { serviceId: entry.serviceId, accountId: current.session.accountId,
          integrationConnectionsRevision: current.revision, models: entry.models };
      }
    } catch {
      // Missing or unreadable private ownership must not break ordinary chat state.
    }
    if (this.entry === entry) this.clear();
    return undefined;
  }

  private async owner(serviceId: string) {
    if (!this.storageDirectory) throw new ChatBridgeConflictError("Save a Suno connection and import its session before loading models.");
    return withStorageTransaction(this.storageDirectory, async (transaction) => {
      const settings = await loadAgentSettings(this.storageDirectory);
      const connection = settings.integrationConnections?.connections.find((entry) => entry.id === serviceId);
      if (!connection || !isIntegrationConnectionForProvider(connection, "suno")) {
        throw new ChatBridgeConflictError("Save this Suno connection before loading its models.");
      }
      // Listing supports disabled connections; it never changes saved enablement.
      const session = await new SunoSessions(this.storageDirectory).load(serviceId, transaction);
      if (!session) throw new ChatBridgeConflictError("Import a Suno session for this connection before loading models.");
      const revision = settings.integrationConnections!.revision;
      // Automatic Clerk rotation is not a new catalog owner. Explicit auth
      // commands still clear the dialog catalog before changing this record.
      const fingerprint = createHash("sha256").update(JSON.stringify([
        connection.id, connection.pluginId, session.accountId,
      ])).digest("hex");
      return { session, revision, fingerprint };
    });
  }
}
