import { audioParameterGroups, parseAudioParameters } from "../../plugins/builtins/parameter-panel.js";
import { appendSessionEvent, loadSessionEvents } from "../../storage/events.js";
import { listAudioJobs } from "../../storage/audio-jobs.js";
import { throwIfAborted } from "../../runtime/host.js";
import { captureIntegrationConnections, integrationConnectionFingerprint } from "../plugins/integration-connections.js";
import { createRequestAudioTools } from "./request-audio-tools.js";
import type { PluginExecutionAuthorization } from "../plugins/request-plugin-tools.js";
import { ChatBridgeConflictError, ChatBridgeRequestValidationError } from "../chat/chat-bridge-http.js";
import { ChatBridgeCommandOutcomeUnknownError } from "../chat/chat-bridge.js";

import { applyAudioParameterSuggestions } from "./audio-parameter-suggestions.js";

type AudioRuntimeInput = Parameters<typeof createRequestAudioTools>[0];

export async function loadAudioParameterGroups(storageDirectory: string | undefined, sessionId: string) {
  const connections = await captureIntegrationConnections(storageDirectory);
  const jobs = storageDirectory ? await listAudioJobs(storageDirectory, sessionId) : [];
  const services = connections.map(({ id, name, pluginId, provider, modelId }) => ({ id, name, pluginId, provider,
    ...(modelId === undefined ? {} : { modelId }) }));
  const groups = audioParameterGroups({ services, hasJobs: jobs.length > 0, identity: (id) => {
    const connection = connections.find((candidate) => candidate.id === id)!;
    return [connection.id, connection.name, connection.pluginId, connection.configuration, connection.secrets,
      integrationConnectionFingerprint(connection)];
  } });
  if (connections.some((connection) => connection.provider === "suno")) {
    applyAudioParameterSuggestions(groups, connections, jobs, await loadSessionEvents(storageDirectory, sessionId));
  }
  return { groups, services };
}

export async function runAudioParameterTool(input: Pick<AudioRuntimeInput,
  "context" | "storageDirectory" | "sessionId" | "target" | "signal" | "onProgress" | "onAssets" |
  "withGenerationAuthorization" | "processing" | "observedMusicClips"> & {
  toolName: string;
  signature: string;
  arguments: Record<string, unknown>;
  withAdmissionAuthorization: PluginExecutionAuthorization;
}): Promise<{ failed: boolean }> {
  const tools = await input.withAdmissionAuthorization(input.signal, async () => {
    const catalog = await loadAudioParameterGroups(input.storageDirectory, input.sessionId);
    const selected = catalog.groups.flatMap((group) => group.tools).find((tool) =>
      tool.audioPanel?.toolName === input.toolName && tool.audioPanel.signature === input.signature);
    if (!selected?.audioPanel) throw new ChatBridgeConflictError("This audio tool or connection changed. Reload tools and open its parameters again.");
    const services = catalog.services.filter((service) => service.id === selected.audioPanel!.connectionId);
    try { await parseAudioParameters({ toolName: input.toolName, arguments: input.arguments, services }); }
    catch (error) { throw new ChatBridgeRequestValidationError(error instanceof Error ? error.message : "Invalid audio parameters."); }
    return createRequestAudioTools({ ...input, requestId: "manual-audio", attachmentRefs: [] });
  });
  throwIfAborted(input.signal);
  await appendSessionEvent(input.storageDirectory, input.sessionId, {
    kind: "tool_call", name: input.toolName, content: JSON.stringify(input.arguments),
  });
  let result;
  try {
    result = await tools.execute({ id: "audio-parameters", name: input.toolName, arguments: JSON.stringify(input.arguments) });
  } catch (cause) {
    await appendSessionEvent(input.storageDirectory, input.sessionId, {
      kind: "tool_result", name: input.toolName,
      content: "The audio tool did not return a confirmed result. Review this Session's tool history and the service before retrying.",
    }).catch(() => undefined);
    throw new ChatBridgeCommandOutcomeUnknownError("The audio tool outcome is unconfirmed. Review tool history and the service before retrying.", { cause });
  }
  try {
    await appendSessionEvent(input.storageDirectory, input.sessionId, {
      kind: "tool_result", name: input.toolName, content: result.content,
    });
  } catch (cause) {
    throw new ChatBridgeCommandOutcomeUnknownError("The audio result could not be recorded. Check the service and saved audio jobs before retrying.", { cause });
  }
  let unknown = false;
  try { unknown = JSON.parse(result.content)?.status === "unknown"; } catch { /* Non-job results may be plain text. */ }
  if (unknown) throw new ChatBridgeCommandOutcomeUnknownError("Audio submission is unconfirmed. Review tool history and the service; do not submit it again automatically.");
  return { failed: result.failed === true };
}
