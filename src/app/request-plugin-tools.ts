import { ToolRegistry, type Toolset } from "../plugins/registry.js";
import { isDeepStrictEqual } from "node:util";
import type { AgentExternalToolResult } from "../agent/loop.js";
import type { ModelToolCall } from "../model/contracts.js";
import type { McpToolSource, PluginToolDefinition, PluginToolIssue } from "../plugins/contracts.js";
import { createMcpPluginPackage, createStandaloneMcpConnection } from "../plugins/mcp/package.js";
import { pluginMcpConfigFromArchive, PluginMcpConfigError } from "../plugins/mcp/config.js";
import { mcpCredentialFields } from "../plugins/mcp/credentials.js";
import {
  isPluginIntegrationConnection,
  isStandaloneMcpConnection,
  type PluginIntegrationConnection,
  type StandaloneMcpConnection,
} from "../plugins/integration-connections.js";
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

export interface RequestPluginTools extends Toolset {
  toolsets: readonly Toolset[];
  catalogTools(): readonly RequestPluginCatalogTool[];
  issues: readonly PluginToolIssue[];
  unavailableMidiArtifacts: number;
  midiArtifacts(): readonly MidiArtifact[];
  close(): Promise<void>;
}

export interface RequestPluginCatalogTool {
  pluginId?: string;
  serverId: string;
  connectionId?: string;
  connectionName?: string;
  name: string;
  description: string;
}

export type PluginExecutionAuthorization = <T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
) => Promise<T>;

interface ManagedMcpSource {
  source: McpToolSource;
  pluginId?: string;
  connectionId?: string;
  close(): Promise<void>;
}

type McpRoute = {
  definition: PluginToolDefinition;
  managed: ManagedMcpSource;
} & ({
  runtime: PreparedPluginRuntime;
  connection?: PluginIntegrationConnection;
} | {
  runtime?: never;
  connection: StandaloneMcpConnection;
});

const activeSources = new Map<StorageScopeKey, Set<ManagedMcpSource>>();

export async function closeActivePluginConnections(
  storageDirectory: string | undefined,
  pluginId: string,
  connectionId?: string,
): Promise<void> {
  const canonical = storageDirectory === undefined
    ? undefined
    : await canonicalStorageDirectory(storageDirectory);
  const active = activeSources.get(storageScopeKey(canonical));
  if (!active) return;
  await Promise.all([...active].filter((entry) =>
    entry.pluginId === pluginId && (connectionId === undefined || entry.connectionId === connectionId))
    .map((entry) => entry.close()));
}

export async function closeActiveMcpConnection(
  storageDirectory: string | undefined,
  connectionId: string,
): Promise<void> {
  const canonical = storageDirectory === undefined
    ? undefined
    : await canonicalStorageDirectory(storageDirectory);
  const active = activeSources.get(storageScopeKey(canonical));
  if (active) await Promise.all([...active].filter((entry) => entry.connectionId === connectionId)
    .map((entry) => entry.close()));
}

function manageMcpSource(
  storageDirectory: string,
  source: McpToolSource,
  pluginId?: string,
  connectionId?: string,
): ManagedMcpSource {
  const key = storageScopeKey(storageDirectory);
  let entries = activeSources.get(key);
  if (!entries) {
    entries = new Set();
    activeSources.set(key, entries);
  }
  let closing: Promise<void> | undefined;
  const managed: ManagedMcpSource = {
    source,
    ...(pluginId === undefined ? {} : { pluginId }),
    ...(connectionId === undefined ? {} : { connectionId }),
    close() {
      if (!closing) {
        closing = Promise.resolve().then(() => source.close()).finally(() => {
          entries!.delete(managed);
          if (!entries!.size) activeSources.delete(key);
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
  createStandaloneConnection?: typeof createStandaloneMcpConnection;
}): Promise<RequestPluginTools> {
  const packages: ManagedMcpSource[] = [];
  const toolsets: Toolset[] = [];
  const catalogRoutes: Map<string, McpRoute>[] = [];
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
        const opened: ManagedMcpSource[] = [];
        try {
          const admit = async () => {
            const runtime = await preparePluginRuntime(input.storageDirectory, metadata.id);
            let config;
            try { config = pluginMcpConfigFromArchive(runtime.archive); }
            catch (error) {
              if (!(error instanceof PluginMcpConfigError)) throw error;
            }
            const connections = (await loadAgentSettings(input.storageDirectory)).integrationConnections?.connections
              .filter(isPluginIntegrationConnection)
              .filter((connection) => connection.enabled && connection.pluginId === metadata.id &&
                connection.configuration.pluginDigest === runtime.plugin.sha256) ?? [];
            const unboundIds = config?.servers.filter((server) =>
              !mcpCredentialFields(server).some((field) => field.required)).map((server) => server.id) ?? [];
            const selections: Array<{
              serverIds: string[];
              connection?: PluginIntegrationConnection;
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
              const managed = manageMcpSource(registryDirectory, plugin, runtime.plugin.id, selection.connection?.id);
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
          const routes = new Map<string, McpRoute>();
          for (const { managed, connection } of admitted.selections) {
            const discovery = await managed.source.tools({ sessionId: input.sessionId, signal: input.signal });
            throwIfAborted(input.signal);
            issues.push(...discovery.issues);
            for (const definition of discovery.tools) {
              if (definition.artifactContract) hasArtifactTool = true;
              if ((definition.artifactContract?.inputs.length &&
                  !admission.approvedArtifactInputServerIds.includes(definition.serverId)) ||
                  (definition.artifactContract?.outputs.length &&
                  !admission.approvedArtifactOutputServerIds.includes(definition.serverId))) {
                issues.push({
                  pluginId: admission.id,
                  serverId: definition.serverId,
                  code: "artifact_permission_required",
                  message: "Plugin artifact tool requires separate input or output approval.",
                });
                continue;
              }
              const callName = definition.tool.function.name;
              if (routes.has(callName)) {
                issues.push({
                  pluginId: admission.id,
                  serverId: definition.serverId,
                  code: "invalid_tool",
                  message: "Plugin tool identity conflicts with another installed tool.",
                });
                continue;
              }
              routes.set(callName, { definition, managed, runtime,
                ...(connection ? { connection } : {}) });
            }
          }
          catalogRoutes.push(routes);
          toolsets.push({
            id: admission.id,
            tools: () => [...routes.values()].map(({ definition }) => definition.tool),
            callTool: (call) => callMcpTool(
              routes,
              call,
              input,
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
      const connections = (await loadAgentSettings(input.storageDirectory)).integrationConnections?.connections
        .filter(isStandaloneMcpConnection).filter((connection) => connection.enabled) ?? [];
      for (const connection of connections) {
        throwIfAborted(input.signal);
        let managed: ManagedMcpSource | undefined;
        try {
          const admit = async () => {
            await assertStandaloneAdmission(input.storageDirectory, connection);
            const source = (input.createStandaloneConnection ?? createStandaloneMcpConnection)(connection, {
              ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
            });
            const opened = manageMcpSource(registryDirectory, source, undefined, connection.id);
            packages.push(opened);
            return opened;
          };
          managed = input.withAuthorization
            ? await input.withAuthorization(input.signal, admit)
            : await admit();
          const discovery = await managed.source.tools({ sessionId: input.sessionId, signal: input.signal });
          throwIfAborted(input.signal);
          issues.push(...discovery.issues);
          const routes = new Map<string, McpRoute>();
          for (const definition of discovery.tools) {
            if (definition.artifactContract) hasArtifactTool = true;
            if (definition.artifactContract?.inputs.length && !connection.artifactInputApproved ||
                definition.artifactContract?.outputs.length && !connection.artifactOutputApproved) {
              issues.push({ connectionId: connection.id, serverId: definition.serverId,
                code: "artifact_permission_required", message: "MCP artifact tool requires separate input or output approval." });
              continue;
            }
            const callName = definition.tool.function.name;
            if (routes.has(callName)) {
              issues.push({ connectionId: connection.id, serverId: definition.serverId,
                code: "invalid_tool", message: "MCP tool identity conflicts with another tool." });
              continue;
            }
            routes.set(callName, { definition, managed, connection });
          }
          catalogRoutes.push(routes);
          toolsets.push({
            id: `mcp:${connection.id}`,
            tools: () => [...routes.values()].map(({ definition }) => definition.tool),
            callTool: (call) => callMcpTool(routes, call, input, midiArtifacts),
            close: () => managed!.close(),
          });
        } catch {
          await managed?.close();
          throwIfAborted(input.signal);
          issues.push({ connectionId: connection.id, code: "invalid_configuration",
            message: "MCP connection tools could not be loaded." });
        }
      }
    }
    if (midiArtifacts.size || artifactListing.unavailableCount || hasArtifactTool) {
      toolsets.unshift(sessionArtifactToolset(input, midiArtifacts));
    }
    const registry = new ToolRegistry(toolsets);
    return {
      id: "live-smith.mcp",
      toolsets,
      catalogTools: () => catalogRoutes.flatMap((routes) => [...routes.values()].map(({ definition, connection }) => ({
        ...(definition.pluginId === undefined ? {} : { pluginId: definition.pluginId }),
        serverId: definition.serverId,
        ...(connection ? { connectionId: connection.id, connectionName: connection.name } : {}),
        name: definition.name,
        description: definition.description,
      }))),
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

async function callMcpTool(
  routes: ReadonlyMap<string, McpRoute>,
  call: ModelToolCall,
  input: {
    storageDirectory: string | undefined;
    temporaryDirectory?: string;
    sessionId: string;
    signal: AbortSignal;
    withAuthorization?: PluginExecutionAuthorization;
  },
  midiArtifacts: Map<string, MidiArtifact>,
): Promise<AgentExternalToolResult> {
  const route = routes.get(call.name);
  if (!route) return { content: "MCP tool is unavailable.", failed: true, invalidArguments: true };
  const { managed, definition, runtime, connection } = route;
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(call.arguments || "{}");
  } catch {
    return { content: "MCP tool arguments are not valid JSON.", failed: true, invalidArguments: true };
  }
  try {
    if (!input.withAuthorization) throw new Error("MCP execution authorization is unavailable.");
    const execution = await input.withAuthorization(input.signal, async () => {
      try {
        if (runtime) await assertPluginAdmission(input.storageDirectory, runtime.plugin, definition, connection);
        else await assertStandaloneAdmission(input.storageDirectory, connection);
      } catch (error) {
        await managed.close();
        throw error;
      }
      if (!definition.artifactContract) {
        return {
          result: await managed.source.callTool(
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
        ...(runtime ? { pluginId: runtime.plugin.id } : { connectionId: connection.id }),
        serverId: definition.serverId,
        toolName: definition.name,
        signal: input.signal,
        forbiddenPaths: [input.storageDirectory ?? "", ...(runtime ? [runtime.pluginRoot, runtime.pluginData] : [])],
        call: (stagedArguments) => managed.source.callTool(
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
        notice: runtime ? "Untrusted Plugin tool result." : "Untrusted MCP tool result.",
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
      content: "MCP tool could not complete. Check the connection and server status before retrying.",
      failed: true,
      stop: true,
    };
  }
}

function sessionArtifactToolset(
  input: { storageDirectory: string | undefined; sessionId: string },
  artifacts: Map<string, MidiArtifact>,
): Toolset {
  return {
    id: "live-smith.artifacts",
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
  connection?: PluginIntegrationConnection,
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
    if (!saved?.enabled || !isPluginIntegrationConnection(saved) || saved.pluginId !== expected.id ||
        saved.configuration.serverId !== route.serverId ||
        saved.configuration.pluginDigest !== expected.sha256 ||
        !isDeepStrictEqual(saved, connection)) {
      throw new Error("MCP Integration Connection changed before tool execution.");
    }
  }
}

async function assertStandaloneAdmission(
  storageDirectory: string | undefined,
  expected: StandaloneMcpConnection,
): Promise<void> {
  const saved = (await loadAgentSettings(storageDirectory)).integrationConnections?.connections
    .find((entry) => entry.id === expected.id);
  if (!saved?.enabled || !isStandaloneMcpConnection(saved) || !isDeepStrictEqual(saved, expected)) {
    throw new Error("MCP Connection changed before tool execution.");
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
