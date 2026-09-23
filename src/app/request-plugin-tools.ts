import { PluginRegistry, type PluginToolset } from "../plugins/registry.js";
import { isDeepStrictEqual } from "node:util";
import type { AgentExternalToolResult } from "../agent/loop.js";
import type { ModelToolCall } from "../model/contracts.js";
import type { PluginPackage, PluginToolDefinition, PluginToolIssue } from "../plugins/contracts.js";
import { createMcpPluginPackage } from "../plugins/mcp/package.js";
import { pluginMcpConfigFromArchive, PluginMcpConfigError } from "../plugins/mcp/config.js";
import { mcpCredentialFields } from "../plugins/mcp/credentials.js";
import type { IntegrationConnection } from "../plugins/integration-connections.js";
import { loadAgentSettings } from "../storage/settings.js";
import { callPluginToolWithArtifacts } from "../plugins/artifacts.js";
import { throwIfAborted } from "../runtime/host.js";
import { inspectMidiArtifacts, type MidiArtifact } from "../storage/midi-artifacts.js";
import { canonicalStorageDirectory, storageScopeKey, type StorageScopeKey } from "../storage/scope.js";
import {
  listInstalledPlugins,
  preparePluginRuntime,
  type InstalledPlugin,
  type PreparedPluginRuntime,
} from "../storage/plugins.js";

export interface RequestPluginTools extends PluginToolset {
  toolsets: readonly PluginToolset[];
  issues: readonly PluginToolIssue[];
  unavailableMidiArtifacts: number;
  midiArtifacts(): readonly MidiArtifact[];
  close(): Promise<void>;
}

export type PluginExecutionAuthorization = <T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
) => Promise<T>;

interface ManagedPluginPackage {
  plugin: PluginPackage;
  connectionId?: string;
  close(): Promise<void>;
}

interface PluginRoute {
  definition: PluginToolDefinition;
  plugin: PluginPackage;
  runtime: PreparedPluginRuntime;
  connection?: IntegrationConnection;
}

const activePackages = new Map<StorageScopeKey, Map<string, Set<ManagedPluginPackage>>>();

export async function closeActivePluginConnections(
  storageDirectory: string | undefined,
  pluginId: string,
  connectionId?: string,
): Promise<void> {
  const canonical = storageDirectory === undefined
    ? undefined
    : await canonicalStorageDirectory(storageDirectory);
  const active = activePackages.get(storageScopeKey(canonical))?.get(pluginId);
  if (!active) return;
  await Promise.all([...active].filter((entry) =>
    connectionId === undefined || entry.connectionId === connectionId).map((entry) => entry.close()));
}

function managePluginPackage(
  storageDirectory: string,
  pluginId: string,
  plugin: PluginPackage,
  connectionId?: string,
): ManagedPluginPackage {
  const key = storageScopeKey(storageDirectory);
  let byPlugin = activePackages.get(key);
  if (!byPlugin) {
    byPlugin = new Map();
    activePackages.set(key, byPlugin);
  }
  let entries = byPlugin.get(pluginId);
  if (!entries) {
    entries = new Set();
    byPlugin.set(pluginId, entries);
  }
  let closing: Promise<void> | undefined;
  const managed: ManagedPluginPackage = {
    plugin,
    ...(connectionId === undefined ? {} : { connectionId }),
    close() {
      if (!closing) {
        closing = Promise.resolve().then(() => plugin.close()).finally(() => {
          entries!.delete(managed);
          if (!entries!.size) byPlugin!.delete(pluginId);
          if (!byPlugin!.size) activePackages.delete(key);
        });
      }
      return closing;
    },
  };
  entries.add(managed);
  return managed;
}

export async function createRequestPluginTools(input: {
  storageDirectory: string | undefined;
  sessionId: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  temporaryDirectory?: string;
  withAuthorization?: PluginExecutionAuthorization;
  createPackage?: typeof createMcpPluginPackage;
}): Promise<RequestPluginTools> {
  const packages: ManagedPluginPackage[] = [];
  const toolsets: PluginToolset[] = [];
  const issues: PluginToolIssue[] = [];
  let hasArtifactTool = false;
  const artifactListing = await inspectMidiArtifacts(
    input.storageDirectory,
    input.sessionId,
  );
  const midiArtifacts = new Map(artifactListing.artifacts.map((artifact) => [artifact.id, artifact]));
  const registryDirectory = input.storageDirectory === undefined
    ? undefined
    : await canonicalStorageDirectory(input.storageDirectory);
  try {
    if (registryDirectory) {
      const installed = await listInstalledPlugins(input.storageDirectory);
      for (const metadata of installed.filter((plugin) => plugin.enabled &&
        (plugin.components.mcpConfigPath !== undefined || plugin.components.mcpManifestPath !== undefined))) {
        throwIfAborted(input.signal);
        const opened: ManagedPluginPackage[] = [];
        try {
          const admit = async () => {
            const runtime = await preparePluginRuntime(input.storageDirectory, metadata.id);
            let config;
            try { config = pluginMcpConfigFromArchive(runtime.archive); }
            catch (error) {
              if (!(error instanceof PluginMcpConfigError)) throw error;
            }
            const connections = (await loadAgentSettings(input.storageDirectory)).integrationConnections?.connections
              .filter((connection) => connection.enabled && connection.pluginId === metadata.id &&
                connection.configuration.pluginDigest === runtime.plugin.sha256) ?? [];
            const unboundIds = config?.servers.filter((server) =>
              !mcpCredentialFields(server).some((field) => field.required)).map((server) => server.id) ?? [];
            const selections: Array<{
              serverIds: string[];
              connection?: IntegrationConnection;
            }> = [{ serverIds: unboundIds }];
            for (const connection of connections) {
              const serverId = connection.configuration.serverId;
              const server = config?.servers.find((entry) => entry.id === serverId);
              if (!server || mcpCredentialFields(server).length === 0) continue;
              selections.push({ serverIds: [server.id], connection });
            }
            const selectedIds = new Set(selections.flatMap((selection) => selection.serverIds));
            for (const server of config?.servers ?? []) {
              if (!selectedIds.has(server.id) && mcpCredentialFields(server).some((field) => field.required)) {
                issues.push({ pluginId: metadata.id, serverId: server.id,
                  code: "invalid_configuration", message: "MCP server requires an enabled named connection." });
              }
            }
            return { runtime, selections: selections.map((selection) => {
              const plugin = (input.createPackage ?? createMcpPluginPackage)(runtime, {
                ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
                serverIds: selection.serverIds,
                ...(selection.connection ? { connection: {
                  id: selection.connection.id,
                  name: selection.connection.name,
                  serverId: selection.connection.configuration.serverId!,
                  secrets: selection.connection.secrets,
                } } : {}),
              });
              const managed = managePluginPackage(registryDirectory, runtime.plugin.id, plugin, selection.connection?.id);
              packages.push(managed);
              opened.push(managed);
              return { managed, connection: selection.connection };
            }) };
          };
          const admitted = input.withAuthorization
            ? await input.withAuthorization(input.signal, admit)
            : await admit();
          const { runtime } = admitted;
          const admission = runtime.plugin;
          const routes = new Map<string, PluginRoute>();
          for (const { managed, connection } of admitted.selections) {
            const discovery = await managed.plugin.tools({ sessionId: input.sessionId, signal: input.signal });
            throwIfAborted(input.signal);
            issues.push(...discovery.issues);
            for (const definition of discovery.tools) {
              if (definition.artifactContract) hasArtifactTool = true;
              if ((definition.artifactContract?.inputs.length &&
                  !admission.approvedArtifactInputServerIds.includes(definition.serverId)) ||
                  (definition.artifactContract?.outputs.length &&
                  !admission.approvedArtifactOutputServerIds.includes(definition.serverId))) {
                issues.push({
                  pluginId: definition.pluginId,
                  serverId: definition.serverId,
                  code: "artifact_permission_required",
                  message: "Plugin artifact tool requires separate input or output approval.",
                });
                continue;
              }
              const callName = definition.tool.function.name;
              if (routes.has(callName)) {
                issues.push({
                  pluginId: definition.pluginId,
                  serverId: definition.serverId,
                  code: "invalid_tool",
                  message: "Plugin tool identity conflicts with another installed tool.",
                });
                continue;
              }
              routes.set(callName, { definition, plugin: managed.plugin, runtime,
                ...(connection ? { connection } : {}) });
            }
          }
          toolsets.push({
            pluginId: admission.id,
            tools: () => [...routes.values()].map(({ definition }) => definition.tool),
            callTool: (call) => callInstalledPluginTool(
              routes,
              call,
              input,
              admission,
              midiArtifacts,
            ),
            close: async () => { await Promise.allSettled(opened.map((entry) => entry.close())); },
          });
        } catch {
          await Promise.allSettled(opened.map((entry) => entry.close()));
          throwIfAborted(input.signal);
          issues.push({
            pluginId: metadata.id,
            code: "invalid_configuration",
            message: "Plugin tools could not be loaded.",
          });
        }
      }
    }
    if (midiArtifacts.size || artifactListing.unavailableCount || hasArtifactTool) {
      toolsets.unshift(sessionArtifactToolset(input, midiArtifacts));
    }
    const registry = new PluginRegistry(toolsets);
    return {
      pluginId: "installed.mcp",
      toolsets,
      issues,
      unavailableMidiArtifacts: artifactListing.unavailableCount,
      midiArtifacts: () => [...midiArtifacts.values()].map((artifact) => ({ ...artifact })),
      tools: () => registry.tools(),
      callTool: (call) => registry.callTool(call),
      async close() {
        await Promise.allSettled(packages.map((plugin) => plugin.close()));
      },
    };
  } catch (error) {
    await Promise.allSettled(packages.map((plugin) => plugin.close()));
    throw error;
  }
}

async function callInstalledPluginTool(
  routes: ReadonlyMap<string, PluginRoute>,
  call: ModelToolCall,
  input: {
    storageDirectory: string | undefined;
    temporaryDirectory?: string;
    sessionId: string;
    signal: AbortSignal;
    withAuthorization?: PluginExecutionAuthorization;
  },
  admission: InstalledPlugin,
  midiArtifacts: Map<string, MidiArtifact>,
): Promise<AgentExternalToolResult> {
  const route = routes.get(call.name);
  if (!route) return { content: "Plugin tool is unavailable.", failed: true, invalidArguments: true };
  const { plugin, definition, runtime, connection } = route;
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(call.arguments || "{}");
  } catch {
    return { content: "Plugin tool arguments are not valid JSON.", failed: true, invalidArguments: true };
  }
  try {
    if (!input.withAuthorization) throw new Error("Plugin execution authorization is unavailable.");
    const execution = await input.withAuthorization(input.signal, async () => {
      await assertPluginAdmission(input.storageDirectory, admission, definition, connection);
      if (!definition.artifactContract) {
        return {
          result: await plugin.callTool(
            definition.serverId,
            definition.name,
            argumentsValue,
            { sessionId: input.sessionId, signal: input.signal },
          ),
          artifacts: [] as MidiArtifact[],
        };
      }
      return callPluginToolWithArtifacts({
        contract: definition.artifactContract,
        argumentsValue,
        storageDirectory: input.storageDirectory,
        temporaryDirectory: input.temporaryDirectory,
        sessionId: input.sessionId,
        pluginId: admission.id,
        serverId: definition.serverId,
        toolName: definition.name,
        signal: input.signal,
        forbiddenPaths: [runtime.pluginRoot, runtime.pluginData, input.storageDirectory ?? ""],
        call: (stagedArguments) => plugin.callTool(
          definition.serverId,
          definition.name,
          stagedArguments,
          { sessionId: input.sessionId, signal: input.signal },
        ),
      });
    });
    for (const artifact of execution.artifacts) midiArtifacts.set(artifact.id, artifact);
    return {
      content: JSON.stringify({
        notice: "Untrusted Plugin tool result.",
        content: execution.result.content,
        ...(execution.result.structuredContent === undefined ? {} : {
          structuredContent: execution.result.structuredContent,
        }),
        ...(execution.artifacts.length ? {
          artifacts: execution.artifacts.map(midiArtifactView),
        } : {}),
      }),
      ...(execution.result.isError ? { failed: true } : {}),
    };
  } catch {
    throwIfAborted(input.signal);
    return {
      content: "Plugin tool could not complete. Check the Plugin and MCP server status before retrying.",
      failed: true,
      stop: true,
    };
  }
}

function sessionArtifactToolset(
  input: { storageDirectory: string | undefined; sessionId: string },
  artifacts: Map<string, MidiArtifact>,
): PluginToolset {
  return {
    pluginId: "live-smith.artifacts",
    tools: () => [{
      type: "function",
      function: {
        name: "list_session_artifacts",
        description: "List validated non-audio artifacts saved in this Session. If saved MIDI data is unavailable, the result includes an unavailableCount and warning; do not use those missing artifacts. Use an exact listed MIDI artifactRef with create_midi_clip_from_artifact when that action is available. This reads local metadata only and does not run a Plugin or change Live.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    }],
    async callTool(call) {
      if (call.name !== "list_session_artifacts") return invalidArguments();
      try {
        const value: unknown = JSON.parse(call.arguments || "{}");
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) {
          return invalidArguments();
        }
        const listing = await inspectMidiArtifacts(input.storageDirectory, input.sessionId);
        artifacts.clear();
        for (const artifact of listing.artifacts) artifacts.set(artifact.id, artifact);
        const current = listing.artifacts.map(midiArtifactView);
        return {
          content: JSON.stringify(listing.unavailableCount
            ? { artifacts: current, unavailableCount: listing.unavailableCount,
                warning: "One or more saved MIDI artifacts are unavailable. Their metadata was preserved." }
            : current),
          progressKey: JSON.stringify([
            listing.artifacts.map((artifact) => [artifact.id, artifact.sha256]),
            listing.unavailableCount,
          ]),
        };
      } catch {
        return invalidArguments();
      }
    },
  };
}

async function assertPluginAdmission(
  storageDirectory: string | undefined,
  expected: InstalledPlugin,
  route: PluginToolDefinition,
  connection?: IntegrationConnection,
): Promise<void> {
  const current = (await listInstalledPlugins(storageDirectory)).find((plugin) => plugin.id === expected.id);
  if (!current || !current.enabled || current.sha256 !== expected.sha256 ||
      !current.approvedMcpServerIds.includes(route.serverId) ||
      (route.artifactContract?.inputs.length && !current.approvedArtifactInputServerIds.includes(route.serverId)) ||
      (route.artifactContract?.outputs.length && !current.approvedArtifactOutputServerIds.includes(route.serverId))) {
    throw new Error("Plugin admission changed before tool execution.");
  }
  if (connection) {
    const saved = (await loadAgentSettings(storageDirectory)).integrationConnections?.connections.find((entry) =>
      entry.id === connection.id);
    if (!saved?.enabled || saved.pluginId !== expected.id ||
        saved.configuration.serverId !== route.serverId ||
        saved.configuration.pluginDigest !== expected.sha256 ||
        !isDeepStrictEqual(saved, connection)) {
      throw new Error("MCP Integration Connection changed before tool execution.");
    }
  }
}

function midiArtifactView(artifact: MidiArtifact) {
  return {
    kind: "midi" as const,
    artifactRef: artifact.id,
    label: artifact.label,
    format: artifact.format,
    trackCount: artifact.trackCount,
    noteCount: artifact.noteCount,
    durationBeats: artifact.durationBeats,
    createdAt: artifact.createdAt,
  };
}

function invalidArguments(): AgentExternalToolResult {
  return { content: "Invalid Plugin tool arguments.", failed: true, invalidArguments: true };
}
