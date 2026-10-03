import { midiArtifactAuthoringTool } from "../midi/midi-artifact-tools.js";
import { sessionArtifactTools } from "./session-artifact-tools.js";
import { creativeBriefProposalTool } from "../context/creative-brief.js";
import { liveSmithTools } from "../../agent/tool-definitions.js";
import { Buffer } from "node:buffer";
import type { PluginParameterPanel } from "../../plugins/parameter-panel.js";
import type { PluginAppDescriptor } from "../../plugins/mcp/apps.js";
import { inputTransportSupport } from "../../model/input-support.js";
import type { AudioParameterPanel } from "../../plugins/builtins/parameter-panel.js";
import { loadAudioParameterGroups } from "../audio/audio-parameter-tool.js";
import { sessionMediaTools } from "../../plugins/builtins/audio-toolsets.js";
import { throwIfAborted } from "../../runtime/host.js";
import type { ChatDialogState, SessionToolCatalog } from "../../ui/chat-state.js";
import {
  MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH,
  MAX_SESSION_TOOL_CATALOG_ISSUES,
  MAX_SESSION_TOOL_CATALOG_TOOLS,
} from "../../ui/chat-state.js";
import {
  createRequestPluginTools,
  type PluginExecutionAuthorization,
} from "../plugins/request-plugin-tools.js";

type ToolGroup = SessionToolCatalog["groups"][number];

export function sessionToolCatalogOwner(state: ChatDialogState): string {
  return JSON.stringify([
    state.activeSessionId,
    state.activeProfileRevision,
    state.runtimeProfile,
    state.integrationConnections?.revision ?? "0",
    state.plugins,
    state.sunoAccounts ?? [],
    state.mcpOAuthStates ?? [],
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
  let panelBytes = 0;
  const addTool = (group: ToolGroup, name: string, description: string, panel?: PluginParameterPanel, app?: PluginAppDescriptor, audioPanel?: AudioParameterPanel): void => {
    if (projectedTools >= MAX_SESSION_TOOL_CATALOG_TOOLS) {
      truncated = true;
      return;
    }
    const shortened = description.length > MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH;
    if (panel) {
      panelBytes += Buffer.byteLength(JSON.stringify(panel), "utf8");
      if (panelBytes > 256 * 1024) { panel = undefined; truncated = true; }
    }
    if (audioPanel) {
      panelBytes += Buffer.byteLength(JSON.stringify(audioPanel), "utf8");
      if (panelBytes > 256 * 1024) { audioPanel = undefined; truncated = true; }
    }
    group.tools.push({
      name,
      description: shortened
        ? `${description.slice(0, MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH - 1)}…`
        : description,
      ...(panel ? { panel } : {}),
      ...(app ? { app } : {}),
      ...(audioPanel ? { audioPanel } : {}),
    });
    projectedTools += 1;
  };
  const liveGroup: ToolGroup = { kind: "live", tools: [] };
  for (const tool of [...liveSmithTools({ readArrangementAudio: audioInputSupported }), creativeBriefProposalTool]) {
    addTool(liveGroup, tool.function.name, tool.function.description);
  }
  if (input.storageDirectory) {
    for (const tool of [...sessionArtifactTools, midiArtifactAuthoringTool]) {
      addTool(liveGroup, tool.function.name, tool.function.description);
    }
  }
  groups.push(liveGroup);

  const audioCatalog = await loadAudioParameterGroups(input.storageDirectory, input.sessionId);
  for (const audioGroup of audioCatalog.groups) {
    const group: ToolGroup = { ...audioGroup, tools: [] };
    for (const tool of audioGroup.tools) addTool(group, tool.name, tool.description, undefined, undefined, tool.audioPanel);
    if (group.tools.length) groups.push(group);
  }
  const mediaGroup = groups.find((group) => group.pluginId === "live-smith.media");
  if (audioInputSupported && mediaGroup) {
    const listening = sessionMediaTools(true).find((tool) => tool.function.name === "listen_to_audio_asset")!;
    addTool(mediaGroup, listening.function.name, listening.function.description);
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
  if (pluginTools.hasAudioOutputs && !mediaGroup) {
    const group: ToolGroup = { kind: "audio", pluginId: "live-smith.media", tools: [] };
    for (const tool of sessionMediaTools(audioInputSupported)) addTool(group, tool.function.name, tool.function.description);
    groups.push(group);
  }

  try {
    throwIfAborted(input.signal);
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
      addTool(group, tool.name, tool.description, tool.panel, tool.app);
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
