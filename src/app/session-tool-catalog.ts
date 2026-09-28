import { liveSmithTools } from "../agent/tool-definitions.js";
import { inputTransportSupport } from "../model/input-support.js";
import { createBuiltInAudioToolsets } from "../plugins/builtins/audio-toolsets.js";
import type { Toolset } from "../plugins/registry.js";
import { throwIfAborted } from "../runtime/host.js";
import { listAudioJobs } from "../storage/audio-jobs.js";
import type { ChatDialogState, SessionToolCatalog } from "../ui/chat-state.js";
import {
  MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH,
  MAX_SESSION_TOOL_CATALOG_ISSUES,
  MAX_SESSION_TOOL_CATALOG_TOOLS,
} from "../ui/chat-state.js";
import { availableIntegrationConnections } from "./integration-connections.js";
import {
  createRequestPluginTools,
  type PluginExecutionAuthorization,
} from "./request-plugin-tools.js";

type ToolGroup = SessionToolCatalog["groups"][number];

export function sessionToolCatalogOwner(state: ChatDialogState): string {
  return JSON.stringify([
    state.activeSessionId,
    state.activeProfileRevision,
    state.runtimeProfile,
    state.integrationConnections?.revision ?? "0",
    state.plugins,
    state.sunoAccounts ?? [],
    (state.audioJobs ?? []).map(({ id, status, outputs }) => [id, status, outputs.map(({ id: assetId }) => assetId)]),
    state.events.at(-1)?.id,
  ]);
}

/** Reads local definitions and explicitly discovers MCP tools; never invokes a tool. */
export async function loadSessionToolCatalog(input: {
  storageDirectory: string | undefined;
  sessionId: string;
  state: ChatDialogState;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  withPluginAuthorization?: PluginExecutionAuthorization;
}): Promise<SessionToolCatalog> {
  throwIfAborted(input.signal);
  const runtime = input.state.runtimeProfile;
  const profile = input.state.settings.profiles.find((entry) => entry.id === runtime?.profile.id);
  const modelToolsSupported = runtime?.capabilities.tools === true;
  const audioInputSupported = modelToolsSupported && Boolean(
    profile && inputTransportSupport(profile.connection).audio &&
      runtime?.capabilities.inputs.audio && runtime.inputCapabilityEvidence.audio === "supported",
  );
  const groups: SessionToolCatalog["groups"] = [];
  let projectedTools = 0;
  let truncated = false;
  const addTool = (group: ToolGroup, name: string, description: string): void => {
    if (projectedTools >= MAX_SESSION_TOOL_CATALOG_TOOLS) {
      truncated = true;
      return;
    }
    const shortened = description.length > MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH;
    group.tools.push({
      name,
      description: shortened
        ? `${description.slice(0, MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH - 1)}…`
        : description,
    });
    projectedTools += 1;
  };
  const liveGroup: ToolGroup = { kind: "live", tools: [] };
  for (const tool of liveSmithTools({ readArrangementAudio: audioInputSupported })) {
    addTool(liveGroup, tool.function.name, tool.function.description);
  }
  groups.push(liveGroup);

  const services = await availableIntegrationConnections(input.storageDirectory);
  const jobs = input.storageDirectory
    ? await listAudioJobs(input.storageDirectory, input.sessionId)
    : [];
  if (services.length || jobs.length) {
    for (const toolset of createBuiltInAudioToolsets({
      services,
      includeModelAudioInput: audioInputSupported,
      execute: async () => { throw new Error("Catalog discovery cannot execute an audio tool."); },
    })) {
      addToolset(groups, toolset, addTool);
    }
  }

  const pluginTools = await createRequestPluginTools({
    storageDirectory: input.storageDirectory,
    sessionId: input.sessionId,
    signal: input.signal,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.withPluginAuthorization === undefined ? {} : {
      withAuthorization: input.withPluginAuthorization,
    }),
  });
  try {
    throwIfAborted(input.signal);
    for (const toolset of pluginTools.toolsets) {
      if (toolset.id !== "live-smith.artifacts") continue;
      for (const tool of toolset.tools()) {
        addTool(liveGroup, tool.function.name, tool.function.description);
      }
    }
    const mcpGroups = new Map<string, ToolGroup>();
    for (const tool of pluginTools.catalogTools()) {
      const key = JSON.stringify([tool.pluginId, tool.serverId, tool.connectionId]);
      let group = mcpGroups.get(key);
      if (!group) {
        group = {
          kind: "mcp", serverId: tool.serverId,
          ...(tool.pluginId === undefined ? {} : { pluginId: tool.pluginId }),
          ...(tool.connectionId === undefined ? {} : { connectionId: tool.connectionId }),
          ...(tool.connectionName === undefined ? {} : { connectionName: tool.connectionName }),
          tools: [],
        };
        mcpGroups.set(key, group);
      }
      addTool(group, tool.name, tool.description);
    }
    groups.push(...[...mcpGroups.values()].filter((group) => group.tools.length));
    if (pluginTools.issues.length > MAX_SESSION_TOOL_CATALOG_ISSUES) truncated = true;
    throwIfAborted(input.signal);
    return {
      sessionId: input.sessionId,
      loadedAt: new Date().toISOString(),
      modelToolsSupported,
      truncated,
      groups,
      issues: pluginTools.issues.slice(0, MAX_SESSION_TOOL_CATALOG_ISSUES).map((issue) => ({
        ...issue,
        message: issue.message.slice(0, MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH),
      })),
    };
  } finally {
    await pluginTools.close();
  }
}

function addToolset(
  groups: SessionToolCatalog["groups"],
  toolset: Toolset,
  addTool: (group: ToolGroup, name: string, description: string) => void,
): void {
  const group: ToolGroup = { kind: "audio", pluginId: toolset.id, tools: [] };
  for (const tool of toolset.tools()) addTool(group, tool.function.name, tool.function.description);
  if (group.tools.length) groups.push(group);
}
