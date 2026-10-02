import type { McpAuthProvider } from "../../plugins/mcp/oauth-contract.js";
import { createMcpOAuthAuthProvider } from "./mcp-oauth.js";
import { ToolRegistry, type Toolset } from "../../plugins/registry.js";
import { isDeepStrictEqual } from "node:util";
import type { AgentExternalToolResult } from "../../agent/loop.js";
import type { ModelToolCall } from "../../model/contracts.js";
import type { McpToolSource, PluginToolDefinition, PluginToolIssue, PluginToolResult } from "../../plugins/contracts.js";
import { appVisibility, pluginAppDescriptor, type PluginAppDescriptor } from "../../plugins/mcp/apps.js";
import { createMcpPluginPackage, createStandaloneMcpConnection } from "../../plugins/mcp/package.js";
import { pluginMcpConfigFromArchive, PluginMcpConfigError } from "../../plugins/mcp/config.js";
import { mcpCredentialFields } from "../../plugins/mcp/credentials.js";
import {
  isPluginIntegrationConnection,
  isStandaloneMcpConnection,
  type PluginIntegrationConnection,
  type StandaloneMcpConnection,
} from "../../plugins/integration-connections.js";
import { loadAgentSettings } from "../../storage/settings.js";
import { callPluginToolWithArtifacts, LIVE_SMITH_ARTIFACT_META_KEY } from "../../plugins/artifacts.js";
import { throwIfAborted } from "../../runtime/host.js";
import { inspectMidiArtifacts, readMidiArtifact, midiArtifactPartSummaries, type MidiArtifact } from "../../storage/midi-artifacts.js";
import { isSafeStorageId } from "../../storage/id.js";
import { canonicalStorageDirectory, storageScopeKey, type StorageScopeKey } from "../../storage/scope.js";
import { pluginParameterPanel, type PluginParameterPanel } from "../../plugins/parameter-panel.js";
import {
  listInstalledPlugins,
  preparePluginRuntime,
  readPluginConfig,
  type InstalledPlugin,
  type PreparedPluginRuntime,
} from "../../storage/plugins.js";

export interface RequestPluginToolResult extends AgentExternalToolResult {
  outcomeUnknown?: boolean;
}

export interface RequestPluginTools extends Toolset {
  callTool(call: ModelToolCall): Promise<RequestPluginToolResult>;
  toolsets: readonly Toolset[];
  catalogTools(): readonly RequestPluginCatalogTool[];
  issues: readonly PluginToolIssue[];
  unavailableMidiArtifacts: number;
  midiArtifacts(): readonly MidiArtifact[];
  close(): Promise<void>;
  appTool(owner: string, name: string): PluginToolDefinition;
  readAppResource(owner: string, uri: string, signal: AbortSignal): Promise<unknown>;
  listAppResources(owner: string, templates: boolean, cursor: string | undefined, signal: AbortSignal): Promise<unknown>;
  callAppTool(owner: string, name: string, argumentsValue: Record<string, unknown>, signal: AbortSignal): Promise<{
    result: PluginToolResult; history: RequestPluginToolResult;
  }>;
}

export interface RequestPluginCatalogTool {
  pluginId?: string;
  serverId: string;
  connectionId?: string;
  connectionName?: string;
  name: string;
  description: string;
  panel?: PluginParameterPanel;
  app?: PluginAppDescriptor;
}

export type PluginExecutionAuthorization = <T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
) => Promise<T>;

interface ManagedMcpSource {
  source: McpToolSource;
  authProvider?: McpAuthProvider;
  pluginId?: string;
  connectionId?: string;
  close(): Promise<void>;
}

type McpRoute = {
  definition: PluginToolDefinition;
  managed: ManagedMcpSource;
  configurationRevision: string;
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
  authProvider?: McpAuthProvider,
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
    ...(authProvider ? { authProvider } : {}),
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
  pluginConfigSnapshots?: Readonly<Record<string, { sha256: string; revision: string }>>;
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
            if (input.pluginConfigSnapshots && (input.pluginConfigSnapshots[metadata.id]?.revision !== (runtime.userConfig?.revision ?? "0") ||
                input.pluginConfigSnapshots[metadata.id]?.sha256 !== runtime.plugin.sha256)) {
              throw new Error("Plugin parameters changed after request admission.");
            }
            let config;
            try { config = pluginMcpConfigFromArchive(runtime.archive); }
            catch (error) {
              if (!(error instanceof PluginMcpConfigError)) throw error;
            }
            const settings = await loadAgentSettings(input.storageDirectory);
            const connections = settings.integrationConnections?.connections
              .filter(isPluginIntegrationConnection)
              .filter((connection) => connection.enabled && connection.pluginId === metadata.id &&
                connection.configuration.pluginDigest === runtime.plugin.sha256) ?? [];
            const unboundIds = config?.servers.filter((server) =>
              !(server.type === "streamable-http" && settings.integrationConnections?.connections.some((connection) => connection.pluginId === metadata.id &&
                connection.configuration?.serverId === server.id && connection.configuration.pluginDigest === runtime.plugin.sha256)) &&
              !mcpCredentialFields(server).some((field) => field.required)).map((server) => server.id) ?? [];
            const selections: Array<{
              serverIds: string[];
              connection?: PluginIntegrationConnection;
            }> = [{ serverIds: unboundIds }];
            for (const connection of connections) {
              const serverId = connection.configuration.serverId;
              const server = config?.servers.find((entry) => entry.id === serverId);
              if (!server || server.type === "stdio" && mcpCredentialFields(server).length === 0) continue;
              selections.push({ serverIds: [server.id], connection });
            }
            const selectedIds = new Set(selections.flatMap((selection) => selection.serverIds));
            for (const server of config?.servers ?? []) {
              if (!selectedIds.has(server.id) && mcpCredentialFields(server).some((field) => field.required)) {
                issues.push({ pluginId: metadata.id, serverId: server.id,
                  code: "invalid_configuration", message: "MCP server requires an enabled named connection." });
              }
            }
            return { runtime, configurationRevision: settings.integrationConnections?.revision ?? "0", selections: selections.map((selection) => {
              const authProvider = selection.connection?.oauth
                ? createMcpOAuthAuthProvider(input.storageDirectory!, selection.connection.id, input.signal, input.fetchImpl) : undefined;
              const plugin = (input.createPackage ?? createMcpPluginPackage)(runtime, {
                ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
                serverIds: selection.serverIds,
                ...(authProvider ? { authProvider } : {}),
                ...(selection.connection ? { connection: {
                  id: selection.connection.id,
                  name: selection.connection.name,
                  serverId: selection.connection.configuration.serverId!,
                  secrets: selection.connection.secrets,
                } } : {}),
              });
              const managed = manageMcpSource(registryDirectory, plugin, runtime.plugin.id, selection.connection?.id, authProvider);
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
              routes.set(callName, { definition, managed, runtime, configurationRevision: admitted.configurationRevision,
                ...(connection ? { connection } : {}) });
            }
          }
          catalogRoutes.push(routes);
          toolsets.push({
            id: admission.id,
            tools: () => [...routes.values()].filter(({ definition }) => appVisibility(definition.app, "model")).map(({ definition }) => definition.tool),
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
      const settings = await loadAgentSettings(input.storageDirectory);
      const connections = settings.integrationConnections?.connections
        .filter(isStandaloneMcpConnection).filter((connection) => connection.enabled) ?? [];
      for (const connection of connections) {
        throwIfAborted(input.signal);
        let managed: ManagedMcpSource | undefined;
        try {
          const admit = async () => {
            await assertStandaloneAdmission(input.storageDirectory, connection);
            const authProvider = connection.oauth
              ? createMcpOAuthAuthProvider(input.storageDirectory!, connection.id, input.signal, input.fetchImpl) : undefined;
            const source = (input.createStandaloneConnection ?? createStandaloneMcpConnection)(connection, {
              ...(authProvider ? { authProvider } : {}),
              ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
            });
            const opened = manageMcpSource(registryDirectory, source, undefined, connection.id, authProvider);
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
            routes.set(callName, { definition, managed, connection, configurationRevision: settings.integrationConnections?.revision ?? "0" });
          }
          catalogRoutes.push(routes);
          toolsets.push({
            id: `mcp:${connection.id}`,
            tools: () => [...routes.values()].filter(({ definition }) => appVisibility(definition.app, "model")).map(({ definition }) => definition.tool),
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
      toolsets.unshift(createSessionMidiArtifactToolset(input, midiArtifacts));
    }
    const registry = new ToolRegistry(toolsets);
    const allRoutes = new Map(catalogRoutes.flatMap((routes) => [...routes]));
    const appRoute = (owner: string, name?: string): McpRoute => {
      const source = allRoutes.get(owner);
      if (!source?.definition.app?.resourceUri) throw new Error("Plugin app is unavailable.");
      if (name === undefined) return source;
      const target = [...allRoutes.values()].find((route) => route.managed === source.managed &&
        route.definition.serverId === source.definition.serverId && route.definition.name === name);
      if (!target || !appVisibility(target.definition.app, "app")) throw new Error("Tool is not available to this Plugin app.");
      return target;
    };
    const withAppResourceRoute = <T>(owner: string, signal: AbortSignal, operation: (route: McpRoute) => Promise<T>): Promise<T> => {
      const route = appRoute(owner);
      if (!input.withAuthorization) throw new Error("Plugin resources are unavailable.");
      return input.withAuthorization(signal, async () => {
        if (route.runtime) await assertPluginAdmission(input.storageDirectory, route.runtime.plugin, route.definition,
          route.connection as PluginIntegrationConnection | undefined, route.runtime.userConfig?.revision ?? "0");
        else await assertStandaloneAdmission(input.storageDirectory, route.connection as StandaloneMcpConnection);
        return operation(route);
      });
    };
    return {
      id: "live-smith.mcp",
      toolsets,
      catalogTools: () => catalogRoutes.flatMap((routes) => [...routes.values()].filter(({ definition }) =>
        appVisibility(definition.app, "model") || definition.app?.resourceUri).map(({ definition, connection, runtime, configurationRevision, managed }) => {
        const identity = {
          packageDigest: runtime?.plugin.sha256,
          connectionId: connection?.id,
          configuration: connection?.configuration ?? connection?.mcp,
          configurationRevision,
          ...(connection?.oauth ? { oauthGeneration: managed.authProvider?.generation } : {}),
          pluginConfigRevision: runtime?.userConfig?.revision ?? "0",
          description: definition.description,
          artifactContract: definition.artifactContract,
          parameters: definition.tool.function.parameters,
        };
        const panel = appVisibility(definition.app, "model")
          ? pluginParameterPanel(definition.tool.function.name, definition.tool.function.parameters, identity) : undefined;
        const app = pluginAppDescriptor(definition.app, definition.tool.function.name, identity);
        return {
          ...(definition.pluginId === undefined ? {} : { pluginId: definition.pluginId }),
          serverId: definition.serverId,
          ...(connection ? { connectionId: connection.id, connectionName: connection.name } : {}),
          name: definition.name,
          description: definition.description,
          ...(panel ? { panel } : {}),
          ...(app ? { app } : {}),
        };
      })),
      issues,
      unavailableMidiArtifacts: artifactListing.unavailableCount,
      midiArtifacts: () => [...midiArtifacts.values()].map((artifact) => ({ ...artifact })),
      tools: () => registry.tools(),
      callTool: (call) => registry.callTool(call),
      appTool: (owner, name) => appRoute(owner, name).definition,
      async readAppResource(owner, uri, signal) {
        return withAppResourceRoute(owner, signal, async (route) => {
          if (!route.managed.source.readResource) throw new Error("Plugin resources are unavailable.");
          return route.managed.source.readResource!(route.definition.serverId, uri, { sessionId: input.sessionId, signal });
        });
      },
      async listAppResources(owner, templates, cursor, signal) {
        return withAppResourceRoute(owner, signal, async (route) => {
          if (!route.managed.source.listResources) throw new Error("Plugin resources are unavailable.");
          return route.managed.source.listResources(route.definition.serverId, templates, cursor, { sessionId: input.sessionId, signal });
        });
      },
      async callAppTool(owner, name, argumentsValue, signal) {
        const route = appRoute(owner, name);
        let result: PluginToolResult | undefined;
        const history = await callMcpTool(allRoutes, { id: "plugin-app", name: route.definition.tool.function.name,
          arguments: JSON.stringify(argumentsValue) }, { ...input, signal }, midiArtifacts, (value) => { result = value; });
        return { history, result: result ?? { content: [{ type: "text", text: history.content }], isError: true } };
      },
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
  onAppResult?: (result: PluginToolResult) => void,
): Promise<RequestPluginToolResult> {
  const route = routes.get(call.name);
  if (!route) return { content: "MCP tool is unavailable.", failed: true, invalidArguments: true };
  const { managed, definition, runtime, connection } = route;
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(call.arguments || "{}");
  } catch {
    return { content: "MCP tool arguments are not valid JSON.", failed: true, invalidArguments: true };
  }
  let invoked = false;
  try {
    if (!input.withAuthorization) throw new Error("MCP execution authorization is unavailable.");
    const execution = await input.withAuthorization(input.signal, async () => {
      try {
        if (runtime) await assertPluginAdmission(input.storageDirectory, runtime.plugin, definition, connection, runtime.userConfig?.revision ?? "0");
        else await assertStandaloneAdmission(input.storageDirectory, connection);
      } catch (error) {
        await managed.close();
        throw error;
      }
      if (!definition.artifactContract) {
        invoked = true;
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
        call: (stagedArguments) => {
          invoked = true;
          return managed.source.callTool(
            definition.serverId,
            definition.name,
            stagedArguments,
            { sessionId: input.sessionId, signal: input.signal },
          );
        },
      });
    });
    for (const artifact of execution.artifacts) midiArtifacts.set(artifact.id, artifact);
    onAppResult?.(appToolResultWithArtifacts(execution.result, execution.artifacts));
    return {
      content: JSON.stringify({
        notice: runtime ? "Untrusted Plugin tool result." : "Untrusted MCP tool result.",
        content: execution.result.content,
        ...(execution.result.isError ? { isError: true } : {}),
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
      content: invoked
        ? "The MCP tool did not return a confirmed result. Check the server state and Session artifacts before retrying."
        : "MCP tool could not start. Check the connection and server status before retrying.",
      ...(invoked ? { outcomeUnknown: true } : {}),
      failed: true,
      stop: true,
    };
  }
}

export function createSessionMidiArtifactToolset(
  input: { storageDirectory: string | undefined; sessionId: string; signal?: AbortSignal },
  artifacts: Map<string, MidiArtifact> = new Map(),
): Toolset {
  return {
    id: "live-smith.artifacts",
    tools: () => [{
      type: "function",
      function: {
        name: "list_session_artifacts",
        description: "List validated non-audio artifacts saved in this Session. If saved MIDI data is unavailable, the result includes an unavailableCount and warning; do not use those missing artifacts. Use an exact listed MIDI artifactRef with create_midi_clip_from_artifact when that action is available. This verifies saved MIDI bytes and returns read-derived source part summaries and timing event counts; it does not run a Plugin or change Live. For multitrack MIDI, select a listed partId per destination or explicitly request mergeParts.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    }, {
      type: "function",
      function: {
        name: "inspect_midi_artifact",
        description: "Read exact saved MIDI notes for one source part from list_session_artifacts. Notes use source-relative quarter-note beats; channel and source track identity remain in the part summary. Returns at most 256 notes with nextOffset for pagination. Reads this Session only; does not change Live or run a generator.",
        parameters: { type: "object", properties: {
          artifactRef: { type: "string" }, partId: { type: "string" }, offset: { type: "integer", minimum: 0 },
        }, required: ["artifactRef", "partId"], additionalProperties: false },
      },
    }],
    async callTool(call) {
      if (call.name !== "list_session_artifacts" && call.name !== "inspect_midi_artifact") return invalidArguments();
      try {
        const value: unknown = JSON.parse(call.arguments || "{}");
        if (call.name === "inspect_midi_artifact") {
          if (!value || typeof value !== "object" || Array.isArray(value)) return invalidArguments();
          const args = value as Record<string, unknown>;
          if (Object.keys(args).some((key) => !["artifactRef", "partId", "offset"].includes(key)) ||
              !isSafeStorageId(args.artifactRef) || typeof args.partId !== "string" ||
              args.offset !== undefined && (!Number.isInteger(args.offset) || (args.offset as number) < 0)) return invalidArguments();
          const { artifact, parsed } = await readMidiArtifact(input.storageDirectory, input.sessionId, args.artifactRef, input.signal);
          const part = parsed.parts.find((part) => part.id === args.partId);
          const offset = args.offset as number ?? 0;
          if (!part || offset > part.notes.length) return invalidArguments();
          return { content: JSON.stringify({ artifactRef: artifact.id, label: artifact.label,
            part: midiArtifactPartSummaries(parsed).find((part) => part.id === args.partId),
            offset, notes: part.notes.slice(offset, offset + 256),
            ...(offset + 256 < part.notes.length ? { nextOffset: offset + 256 } : {}), timing: parsed.timing }),
          progressKey: JSON.stringify([artifact.id, artifact.sha256, part.id, offset]) };
        }
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) {
          return invalidArguments();
        }
        const listing = await inspectMidiArtifacts(input.storageDirectory, input.sessionId);
        artifacts.clear();
        let unavailableCount = listing.unavailableCount;
        const current = [];
        for (const artifact of listing.artifacts) {
          try {
            const { parsed } = await readMidiArtifact(input.storageDirectory, input.sessionId, artifact.id, input.signal);
            current.push({ ...midiArtifactView(artifact), parts: midiArtifactPartSummaries(parsed), timing: parsed.timing });
            artifacts.set(artifact.id, artifact);
          } catch { throwIfAborted(input.signal); unavailableCount += 1; }
        }
        return {
          content: JSON.stringify(unavailableCount
            ? { artifacts: current, unavailableCount,
                warning: "One or more saved MIDI artifacts are unavailable. Their metadata was preserved." }
            : current),
          progressKey: JSON.stringify([
            listing.artifacts.map((artifact) => [artifact.id, artifact.sha256]),
            unavailableCount,
          ]),
        };
      } catch {
        throwIfAborted(input.signal);
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
  configRevision = "0",
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
  if ((await readPluginConfig(storageDirectory, expected.id)).revision !== configRevision) {
    throw new Error("Plugin parameters changed before tool execution.");
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

/** Replaces the reserved result extension with artifacts validated and owned by this host. */
export function appToolResultWithArtifacts(result: PluginToolResult, artifacts: readonly MidiArtifact[]): PluginToolResult {
  return { ...result, _meta: { ...result._meta,
    [LIVE_SMITH_ARTIFACT_META_KEY]: { version: 1, artifacts: artifacts.map(midiArtifactView) },
  } };
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
