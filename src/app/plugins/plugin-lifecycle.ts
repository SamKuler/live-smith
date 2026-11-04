import { createHash } from "node:crypto";
import { uiMessage, type UiMessageDescriptor } from "../../i18n/ui-message.js";
import { openPluginArchive, PluginArchiveError } from "../../plugins/archive.js";
import { PluginConfigConflictError, PluginConfigError } from "../../plugins/user-config.js";
import { previewPluginArchive } from "../../plugins/view.js";
import { throwIfAborted } from "../../runtime/host.js";
import {
  isStorageCommitOutcomeUnknownError,
  withStorageTransaction,
} from "../../storage/persistence.js";
import {
  deletePluginInTransaction,
  installPlugin,
  listInstalledPlugins,
  listInstalledPluginsInTransaction,
  PluginStorageCorruptionError,
  savePluginConfigInTransaction,
  setPluginArtifactPermissionApprovedInTransaction,
  setPluginEnabledInTransaction,
  setPluginMcpServerApprovedInTransaction,
  type InstalledPlugin,
} from "../../storage/plugins.js";
import { listSessionsInTransaction, updateSessionInTransaction } from "../../storage/sessions.js";
import { loadAgentSettings } from "../../storage/settings.js";
import type { GlobalStateInvalidation } from "../session/session-state-events.js";
import { ChatBridgeRequestValidationError } from "../chat/chat-bridge-http.js";
import {
  ChatBridgeCommandOutcomeUnknownError,
  ChatBridgeConflictError,
  ChatBridgePluginValidationError,
  ChatBridgeResourceNotFoundError,
  type ChatBridgeCommandInput,
  type ChatBridgePluginInspectResult,
  type ChatBridgePluginInstallInput,
} from "../chat/chat-bridge.js";
import { closeActivePluginConnections, pluginToolsEnabled } from "./request-plugin-tools.js";

export type PluginLifecycleCommand = Extract<ChatBridgeCommandInput, {
  kind: "set_plugin_enabled" | "set_plugin_mcp_server_approved" | "set_plugin_artifact_permission" | "delete_plugin";
}>;

interface PluginLifecycleOptions {
  storageDirectory: string | undefined;
  withRequestConfiguration<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T>;
  notifyGlobalStateChanged(change?: Pick<GlobalStateInvalidation, "target">): void;
  notifySessionStateChanged(sessionId: string): void;
  updateSessionInTransaction?: typeof updateSessionInTransaction;
}

export const inspectPluginPackage = async (
  input: { bytes: Uint8Array },
  signal: AbortSignal,
): Promise<ChatBridgePluginInspectResult> => {
  throwIfAborted(signal);
  try {
    return { preview: await previewPluginArchive(input.bytes, signal) };
  } catch (error) {
    if (error instanceof PluginArchiveError) {
      throw new ChatBridgePluginValidationError(error.message);
    }
    throwIfAborted(signal);
    throw new ChatBridgePluginValidationError("The uploaded Plugin package is invalid.");
  }
};

/** Owns package mutation, permission revocation and dependent Session cleanup. */
export function createPluginLifecycle(dependencies: PluginLifecycleOptions) {
  const { storageDirectory, withRequestConfiguration, notifyGlobalStateChanged, notifySessionStateChanged } = dependencies;
  const install = async (
    input: ChatBridgePluginInstallInput,
    signal: AbortSignal,
  ): Promise<{ id: string; sha256: string }> => {
    throwIfAborted(signal);
    const bytes = Uint8Array.from(input.bytes);
    let opened;
    try {
      opened = await openPluginArchive(bytes, signal);
    } catch (error) {
      if (error instanceof PluginArchiveError) throw new ChatBridgePluginValidationError(error.message);
      throw new ChatBridgePluginValidationError("The uploaded Plugin package is invalid.");
    }
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    let installed: InstalledPlugin | undefined;
    let catalogChanged = false;
    await withRequestConfiguration(signal, async () => {
      let invalidationPublished = false;
      const publishInvalidation = () => {
        if (invalidationPublished) return;
        invalidationPublished = true;
        notifyGlobalStateChanged();
      };
      try {
        const existing = (await listInstalledPlugins(storageDirectory)).find(
          (plugin) => plugin.id === opened.manifest.id,
        );
        if (existing?.sha256 === expectedSha256) {
          installed = existing;
          return;
        }
        if (existing?.enabled) {
          throw new ChatBridgeConflictError("Disable this Plugin before replacing it.");
        }
        if (existing && !input.replace) {
          throw new ChatBridgeConflictError(
            `Plugin ${opened.manifest.id} is already installed. Confirm replacement to change it.`,
          );
        }
        throwIfAborted(signal);
        installed = await installPlugin(storageDirectory, bytes, { replace: Boolean(existing) });
        catalogChanged = true;
      } catch (error) {
        if (isStorageCommitOutcomeUnknownError(error)) {
          publishInvalidation();
          try {
            installed = (await listInstalledPlugins(storageDirectory)).find((plugin) =>
              plugin.id === opened.manifest.id && plugin.sha256 === expectedSha256);
          } catch {
            installed = undefined;
          }
          if (!installed) {
            throw new ChatBridgeCommandOutcomeUnknownError(
              "The Plugin may have been installed, but its final state could not be confirmed.",
              { cause: error },
            );
          }
        } else if (error instanceof ChatBridgeConflictError || error instanceof ChatBridgePluginValidationError) {
          throw error;
        } else if (error instanceof PluginStorageCorruptionError) {
          throw new ChatBridgePluginValidationError("Installed Plugin storage is invalid and was not changed.");
        } else {
          throwIfAborted(signal);
          throw new ChatBridgePluginValidationError("The Plugin could not be installed or replaced.");
        }
      }
      if (catalogChanged) publishInvalidation();
    });
    if (!installed) throw new ChatBridgePluginValidationError("The Plugin installation could not be confirmed.");
    return { id: installed.id, sha256: installed.sha256 };
  };
  const saveConfiguration = async (
    commandInput: Extract<ChatBridgeCommandInput, { kind: "set_plugin_user_config" }>,
    signal: AbortSignal,
  ): Promise<void> => {
    let toolCatalogChanged = false;
    try {
      await withRequestConfiguration(signal, async () => {
        await withStorageTransaction(storageDirectory, async (transaction) => {
          const plugin = (await listInstalledPluginsInTransaction(transaction, storageDirectory)).find(entry => entry.id === commandInput.pluginId);
          toolCatalogChanged = plugin !== undefined && pluginToolsEnabled(plugin);
          await savePluginConfigInTransaction(transaction, storageDirectory, commandInput);
        });
        await closeActivePluginConnections(storageDirectory, commandInput.pluginId);
      });
    } catch (error) {
      if (error instanceof PluginConfigConflictError) throw new ChatBridgeConflictError(error.message);
      if (error instanceof PluginConfigError) throw new ChatBridgeRequestValidationError(error.message);
      if (isStorageCommitOutcomeUnknownError(error)) notifyGlobalStateChanged(toolCatalogChanged ? { target: "all" } : undefined);
      throw error;
    }
    notifyGlobalStateChanged(toolCatalogChanged ? { target: "all" } : undefined);
  };
  const change = async (
    commandInput: PluginLifecycleCommand,
    signal: AbortSignal,
  ): Promise<UiMessageDescriptor> => {
    let changed = false;
    let toolCatalogChanged = false;
    let sessionCleanupPending = false;
    let privateCleanupPending = false;
    try {
      await withRequestConfiguration(signal,
        async () => {
          let closeConnections = commandInput.kind === "delete_plugin" ||
            commandInput.kind === "set_plugin_enabled" && !commandInput.enabled;
          try {
            await withStorageTransaction(storageDirectory, async (transaction) => {
              throwIfAborted(signal);
              const plugins = await listInstalledPluginsInTransaction(transaction, storageDirectory);
              const plugin = plugins.find((candidate) => candidate.id === commandInput.pluginId);
              if (!plugin) throw new ChatBridgeResourceNotFoundError("That Plugin is not installed.");
              toolCatalogChanged = pluginToolsEnabled(plugin) || commandInput.kind === "set_plugin_enabled" &&
                pluginToolsEnabled({ ...plugin, enabled: commandInput.enabled });
              if (commandInput.kind === "set_plugin_mcp_server_approved" ||
                commandInput.kind === "set_plugin_artifact_permission") {
                if (plugin.sha256 !== commandInput.sha256) {
                  throw new ChatBridgeConflictError("Plugin package changed. Review its permissions and try again.");
                }
                closeConnections = !commandInput.approved;
              }
              const removeSessionSelections = async () => {
                const prefix = `${plugin.id}:`;
                for (const session of await listSessionsInTransaction(transaction, storageDirectory)) {
                  const current = session.activeSkillIds ?? [];
                  const retained = current.filter((skillId) => !skillId.startsWith(prefix));
                  if (retained.length === current.length) continue;
                  await (dependencies.updateSessionInTransaction ?? updateSessionInTransaction)(
                    transaction, storageDirectory, session.id, { activeSkillIds: retained },
                  );
                  notifySessionStateChanged(session.id);
                }
              };
              if (commandInput.kind === "set_plugin_enabled") {
                if (commandInput.enabled) {
                  if (plugin.enabled) return;
                  await removeSessionSelections();
                  await setPluginEnabledInTransaction(transaction, storageDirectory, plugin.id, true);
                  changed = true;
                  return;
                }
                if (plugin.enabled) {
                  await setPluginEnabledInTransaction(transaction, storageDirectory, plugin.id, false);
                  changed = true;
                }
                try {
                  await removeSessionSelections();
                } catch {
                  throwIfAborted(signal);
                  sessionCleanupPending = true;
                }
                return;
              }
              if (commandInput.kind === "set_plugin_mcp_server_approved") {
                if (plugin.approvedMcpServerIds.includes(commandInput.serverId) === commandInput.approved) return;
                await setPluginMcpServerApprovedInTransaction(
                  transaction,
                  storageDirectory,
                  plugin.id,
                  commandInput.serverId,
                  commandInput.approved,
                );
                changed = true;
                return;
              }
              if (commandInput.kind === "set_plugin_artifact_permission") {
                const current = commandInput.permission === "input"
                  ? plugin.approvedArtifactInputServerIds
                  : plugin.approvedArtifactOutputServerIds;
                if (current.includes(commandInput.serverId) === commandInput.approved) return;
                await setPluginArtifactPermissionApprovedInTransaction(
                  transaction,
                  storageDirectory,
                  plugin.id,
                  commandInput.serverId,
                  commandInput.permission,
                  commandInput.approved,
                );
                changed = true;
                return;
              }
              if (plugin.enabled) {
                throw new ChatBridgeConflictError("Disable this Plugin before deleting it.");
              }
              const settings = await loadAgentSettings(storageDirectory);
              if (settings.integrationConnections?.connections.some((connection) =>
                connection.pluginId === plugin.id)) {
                throw new ChatBridgeConflictError("Remove this Plugin's Integration Connections before deleting it.");
              }
              await removeSessionSelections();
              privateCleanupPending = !(await deletePluginInTransaction(transaction, storageDirectory, plugin.id));
              changed = true;
            });
          } finally {
            if (closeConnections) {
              await closeActivePluginConnections(storageDirectory, commandInput.pluginId);
            }
          }
        },
      );
    } catch (error) {
      if (error instanceof PluginConfigError) throw new ChatBridgeRequestValidationError(error.message);
      if (error instanceof PluginStorageCorruptionError) {
        throw new ChatBridgePluginValidationError("Installed Plugin storage is invalid and was not changed.");
      }
      if (isStorageCommitOutcomeUnknownError(error)) notifyGlobalStateChanged(toolCatalogChanged ? { target: "all" } : undefined);
      throw error;
    } finally {
      if (changed) notifyGlobalStateChanged(toolCatalogChanged ? { target: "all" } : undefined);
    }
    const { pluginId } = commandInput;
    if (commandInput.kind === "delete_plugin") {
      return uiMessage(privateCleanupPending
        ? "Plugin {pluginId} removed; private data cleanup will retry if it has not completed."
        : "Plugin {pluginId} deleted.", { pluginId });
    }
    if (commandInput.kind === "set_plugin_enabled") {
      return uiMessage(sessionCleanupPending
        ? "Plugin {pluginId} disabled; Session Skill cleanup is pending."
        : commandInput.enabled ? "Plugin {pluginId} enabled." : "Plugin {pluginId} disabled.", { pluginId });
    }
    const { serverId, approved } = commandInput;
    if (commandInput.kind === "set_plugin_artifact_permission") {
      const permission = uiMessage(commandInput.permission === "input" ? "artifact input" : "artifact output");
      return uiMessage(approved
        ? "Plugin {pluginId} MCP server {serverId} {permission} approved."
        : "Plugin {pluginId} MCP server {serverId} {permission} revoked.", { pluginId, serverId, permission });
    }
    return uiMessage(approved
      ? "Plugin {pluginId} MCP server {serverId} approved."
      : "Plugin {pluginId} MCP server {serverId} revoked.", { pluginId, serverId });
  };
  return { install, saveConfiguration, change };
}
