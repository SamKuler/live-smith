import { PluginRegistry, type PluginToolset } from "../plugins/registry.js";
import type { AgentExternalToolResult } from "../agent/loop.js";
import type { ModelToolCall } from "../model/contracts.js";
import type { PluginPackage, PluginToolDefinition, PluginToolIssue } from "../plugins/contracts.js";
import { createMcpPluginPackage } from "../plugins/mcp/package.js";
import { callPluginToolWithArtifacts } from "../plugins/artifacts.js";
import { throwIfAborted } from "../runtime/host.js";
import { listMidiArtifacts, type MidiArtifact } from "../storage/midi-artifacts.js";
import {
  listInstalledPlugins,
  preparePluginRuntime,
  type InstalledPlugin,
  type PreparedPluginRuntime,
} from "../storage/plugins.js";

export interface RequestPluginTools extends PluginToolset {
  toolsets: readonly PluginToolset[];
  issues: readonly PluginToolIssue[];
  midiArtifacts(): readonly MidiArtifact[];
  close(): Promise<void>;
}

export type PluginExecutionAuthorization = <T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
) => Promise<T>;

export async function createRequestPluginTools(input: {
  storageDirectory: string | undefined;
  sessionId: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  temporaryDirectory?: string;
  withAuthorization?: PluginExecutionAuthorization;
}): Promise<RequestPluginTools> {
  const packages: PluginPackage[] = [];
  const toolsets: PluginToolset[] = [];
  const issues: PluginToolIssue[] = [];
  let hasArtifactTool = false;
  const midiArtifacts = new Map((await listMidiArtifacts(
    input.storageDirectory,
    input.sessionId,
  )).map((artifact) => [artifact.id, artifact]));
  if (input.storageDirectory) {
    const installed = await listInstalledPlugins(input.storageDirectory);
    for (const metadata of installed.filter((plugin) => plugin.enabled &&
      (plugin.components.mcpConfigPath !== undefined || plugin.components.mcpManifestPath !== undefined))) {
      throwIfAborted(input.signal);
      try {
        const runtime = await preparePluginRuntime(input.storageDirectory, metadata.id);
        const plugin = createMcpPluginPackage(runtime, {
          ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
        });
        const packageIndex = packages.push(plugin) - 1;
        const discovery = await plugin.tools({ sessionId: input.sessionId, signal: input.signal });
        issues.push(...discovery.issues);
        const routes = new Map<string, PluginToolDefinition>();
        for (const definition of discovery.tools) {
          if (definition.artifactContract) hasArtifactTool = true;
          if ((definition.artifactContract?.inputs.length &&
              !metadata.approvedArtifactInputServerIds.includes(definition.serverId)) ||
              (definition.artifactContract?.outputs.length &&
              !metadata.approvedArtifactOutputServerIds.includes(definition.serverId))) {
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
          routes.set(callName, definition);
        }
        toolsets.push({
          pluginId: metadata.id,
          tools: () => [...routes.values()].map((definition) => definition.tool),
          callTool: (call) => callInstalledPluginTool(
            packages[packageIndex]!,
            routes,
            call,
            input,
            metadata,
            runtime,
            midiArtifacts,
          ),
          close: () => packages[packageIndex]!.close(),
        });
      } catch {
        issues.push({
          pluginId: metadata.id,
          code: "invalid_configuration",
          message: "Plugin tools could not be loaded.",
        });
      }
    }
  }
  if (midiArtifacts.size || hasArtifactTool) {
    toolsets.unshift(sessionArtifactToolset(input, midiArtifacts));
  }
  const registry = new PluginRegistry(toolsets);
  return {
    pluginId: "installed.mcp",
    toolsets,
    issues,
    midiArtifacts: () => [...midiArtifacts.values()].map((artifact) => ({ ...artifact })),
    tools: () => registry.tools(),
    callTool: (call) => registry.callTool(call),
    async close() {
      await Promise.allSettled(packages.map((plugin) => plugin.close()));
    },
  };
}

async function callInstalledPluginTool(
  plugin: PluginPackage,
  routes: ReadonlyMap<string, PluginToolDefinition>,
  call: ModelToolCall,
  input: {
    storageDirectory: string | undefined;
    temporaryDirectory?: string;
    sessionId: string;
    signal: AbortSignal;
    withAuthorization?: PluginExecutionAuthorization;
  },
  admission: InstalledPlugin,
  runtime: PreparedPluginRuntime,
  midiArtifacts: Map<string, MidiArtifact>,
): Promise<AgentExternalToolResult> {
  const route = routes.get(call.name);
  if (!route) return { content: "Plugin tool is unavailable.", failed: true, invalidArguments: true };
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(call.arguments || "{}");
  } catch {
    return { content: "Plugin tool arguments are not valid JSON.", failed: true, invalidArguments: true };
  }
  try {
    if (!input.withAuthorization) throw new Error("Plugin execution authorization is unavailable.");
    const execution = await input.withAuthorization(input.signal, async () => {
      await assertPluginAdmission(input.storageDirectory, admission, route);
      if (!route.artifactContract) {
        return {
          result: await plugin.callTool(
            route.serverId,
            route.name,
            argumentsValue,
            { sessionId: input.sessionId, signal: input.signal },
          ),
          artifacts: [] as MidiArtifact[],
        };
      }
      return callPluginToolWithArtifacts({
        contract: route.artifactContract,
        argumentsValue,
        storageDirectory: input.storageDirectory,
        temporaryDirectory: input.temporaryDirectory,
        sessionId: input.sessionId,
        pluginId: admission.id,
        serverId: route.serverId,
        toolName: route.name,
        signal: input.signal,
        forbiddenPaths: [runtime.pluginRoot, runtime.pluginData, input.storageDirectory ?? ""],
        call: (stagedArguments) => plugin.callTool(
          route.serverId,
          route.name,
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
        description: "List validated non-audio artifacts saved in this Session. Use an exact MIDI artifactRef with create_midi_clip_from_artifact when that action is available. This reads local metadata only and does not run a Plugin or change Live.",
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
        const current = await listMidiArtifacts(input.storageDirectory, input.sessionId);
        artifacts.clear();
        for (const artifact of current) artifacts.set(artifact.id, artifact);
        return {
          content: JSON.stringify(current.map(midiArtifactView)),
          progressKey: JSON.stringify(current.map((artifact) => [artifact.id, artifact.sha256])),
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
): Promise<void> {
  const current = (await listInstalledPlugins(storageDirectory)).find((plugin) => plugin.id === expected.id);
  if (!current || !current.enabled || current.sha256 !== expected.sha256 ||
      !current.approvedMcpServerIds.includes(route.serverId) ||
      (route.artifactContract?.inputs.length && !current.approvedArtifactInputServerIds.includes(route.serverId)) ||
      (route.artifactContract?.outputs.length && !current.approvedArtifactOutputServerIds.includes(route.serverId))) {
    throw new Error("Plugin admission changed before tool execution.");
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
