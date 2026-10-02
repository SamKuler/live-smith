import { creativeBriefProposalTool, proposeCreativeBrief } from "./context/creative-brief.js";
import { ModelInputTooLargeError } from "../model/connection-error.js";
import type { ExtensionContext } from "@ableton-extensions/sdk";
import { uiMessage, type UiMessage } from "../i18n/ui-message.js";

import {
  AgentPartialCompletionError,
  AgentRecoveryResolutionReportingError,
  AgentSteeringBeforeApplyError,
  AgentSteeringInterruptError,
  runAgentLoop,
  webSearchSummary,
  type AgentActionExecutionOutcome,
  type AgentActionPreflightGuard,
  type AgentConfirmationDecision,
  type AgentLoopTraceEvent,
} from "../agent/loop.js";
import { ToolRegistry } from "../plugins/registry.js";
import {
  materializeMidiArtifactActionPlan,
  midiArtifactImportActionSchema,
} from "../plugins/artifacts.js";
import {
  observationRequestForAction,
  type AgentPlan,
} from "../agent/actions.js";
import { liveSmithTools } from "../agent/tool-definitions.js";
import { createRequestAudioTools } from "./audio/request-audio-tools.js";
import {
  createRequestPluginTools,
  type PluginExecutionAuthorization,
} from "./plugins/request-plugin-tools.js";
import { providerFetchForStorage } from "./network.js";
import { audioProcessingAvailable, type AudioProcessingContext } from "./audio/audio-processing.js";
import { addAudioAssetSampleSources, audioAssetSampleSourceInstructions } from "./audio/audio-asset-sources.js";
import {
  assertEditScopesAllow,
  EditScopeDeniedError,
  resolveEditScopes,
  type EditScope,
} from "../agent/edit-scopes.js";
import {
  HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND,
  HOSTED_WEB_SEARCH_REQUEST_MAX_USES,
  modelToolsForProfile,
  supportsAudioInputDelivery,
} from "../model/tools.js";
import type {
  ModelConversationMessage,
  ModelContextUsage,
  ModelHostedWebSearch,
  ModelReasoningStreamUpdate,
  ModelTurn,
} from "../model/contracts.js";
import type { RuntimeProfile } from "../model/provider.js";
import { profileSecrets } from "../model/profile.js";
import {
  AgentPlanExecutionError,
  executeAgentPlanWithProgress,
} from "../live/executor.js";
import type { LiveInteractionContext } from "../live/context.js";
import { observeLive, readArrangementAudio } from "../live/observer.js";
import {
  attachmentRequestQuotaIsWithinLimits,
  AttachmentProcessingError,
  type AttachmentQuotaItem,
} from "../attachments/contracts.js";
import { MAX_REQUEST_DOCUMENT_TEXT_CHARACTERS } from "../attachments/document-text.js";
import {
  captureLiveActionPreflightObservation,
  type LiveActionPreflightObservation,
} from "../live/preflight.js";
import {
  requiredEditScopesForAction,
  requiredEditScopesForPlan,
} from "../live/action-permissions.js";
import {
  assertSameExistingPlanTargets,
  bindAgentPlanTargets,
  boundTrackForAction,
  liveActionIdentityKeys,
  type AgentPlanBindings,
} from "../live/action-bindings.js";
import type { RequestAudioSampleSources } from "../live/sample-source.js";
import { throwIfAborted } from "../runtime/host.js";
import {
  listPendingSessionAttachments,
  sessionAttachmentRefFromStored,
  type AudioSessionAttachmentRef,
  type SessionAttachmentRef,
} from "../storage/attachments.js";
import {
  appendSessionEvent,
  loadSessionEvents,
  SessionSteeringReceiptConflictError,
  sessionSteeringContentSha256,
  type SessionEvent,
  type SessionEventInput,
  type SessionSteeringReceipt,
} from "../storage/events.js";
import {
  isStorageCommitOutcomeUnknownError,
  withStorageTransaction,
} from "../storage/persistence.js";
import {
  listSessions,
  listSessionsInTransaction,
  updateSession,
} from "../storage/sessions.js";
import {
  resolveConversationHistory,
  resolveCurrentAttachmentParts,
} from "./context/attachment-context.js";
import {
  ChatBridgePromptPersistenceUnknownError,
} from "./chat/chat-bridge.js";
import { sessionErrorMessage } from "./chat/error-routing.js";
import {
  buildModelRequest,
  requestModelTurn,
  type ModelTurnRequestInput,
} from "./model/model-request.js";
import {
  requestModelWithReconnect,
  type ModelReconnectWait,
} from "./model/model-reconnect.js";
import {
  createRequestAudioSampleSources,
  mergeRequestAudioImportProgress,
  prepareRequestAudioSampleSources,
  requestAudioSampleSourceInstructions,
  type RequestAudioImportProgress,
} from "./audio/request-audio-sources.js";
import {
  activeRecoveryLedgerFromEvents,
  getOrCreateDefaultSession,
  recoveryContextFromEvents,
  sessionTitleForPrompt,
} from "./context/session-context.js";
import {
  resolveSkillContext,
  type ResolvedSkillContext,
} from "./context/skill-context.js";
import {
  subscribeSessionEditScopesChanges,
  subscribeSessionEditScopesInvalidations,
} from "./session/session-edit-scope-events.js";
import {
  SteeringPersistenceOutcomeUnknownError,
  type SteeringChannel,
} from "./chat/steering.js";
import {
  conversationCheckpointMessage,
  createConversationCheckpoint,
  estimateTransportContextTokens,
  resolveAutoCompactTokenLimit,
} from "./context/context-compaction.js";

type Api = ExtensionContext<"1.0.0">;
const maxConsecutiveInvalidToolCalls = 3;

export async function handleAgentRequest(
  context: Api,
  storageDirectory: string | undefined,
  interaction: LiveInteractionContext,
  prompt: string,
  runtimeProfile: RuntimeProfile,
  projectKey: string,
  sessionId: string | undefined,
  callbacks: AgentRequestCallbacks,
  requestTurn: AgentModelTurnRequester,
  appendUserEvent: typeof appendSessionEvent = appendSessionEvent,
  appendTraceEvent: typeof appendSessionEvent = appendSessionEvent,
  loadEventsForSearchReconciliation: typeof loadSessionEvents = loadSessionEvents,
  waitForReconnectDelay?: ModelReconnectWait,
): Promise<string> {
  const { profile } = runtimeProfile;
  const session = sessionId === undefined
    ? await getOrCreateDefaultSession(
        storageDirectory,
        interaction,
        projectKey,
        undefined,
        callbacks.signal,
      )
    : (await listSessions(storageDirectory, projectKey)).find(
        (entry) => entry.id === sessionId && !entry.archivedAt,
      );
  if (!session) {
    throw new Error("That Session is not available in this Live Set.");
  }
  const supportsArrangementAudioInput = runtimeProfile.capabilities.tools &&
    supportsAudioInputDelivery(runtimeProfile);
  const audioProcessingOnly = runtimeProfile.capabilities.tools &&
    !supportsAudioInputDelivery(runtimeProfile) && await audioProcessingAvailable(storageDirectory);
  let activeEditScopes: EditScope[] | undefined = resolveEditScopes(session.editScopes);
  let editScopesGeneration = 0;
  const currentEditScopes = () => {
    if (!activeEditScopes) throw new EditScopeDeniedError([]);
    return activeEditScopes;
  };
  const readEditScopes = async () => {
    const generation = editScopesGeneration;
    const current = await withStorageTransaction(
      storageDirectory,
      async (transaction) => (await listSessionsInTransaction(
        transaction, storageDirectory, projectKey,
      )).find((candidate) => candidate.id === session.id && !candidate.archivedAt),
    );
    if (!current) throw new Error("That Session is not available in this Live Set.");
    throwIfAborted(callbacks.signal);
    if (generation === editScopesGeneration) {
      activeEditScopes = resolveEditScopes(current.editScopes);
    }
    return [...currentEditScopes()];
  };
  const prepareRequest = async () => {
    const priorEvents = await loadSessionEvents(
      storageDirectory,
      session.id,
    );
    const skillContext = callbacks.skillContextSnapshot ??
      await resolveSkillContext({
        storageDirectory,
        sessionSkillIds: session.activeSkillIds ?? [],
        prompt,
      });
    const attachmentRefs = await resolvePendingAttachmentRefs(
      storageDirectory, session.id, priorEvents, callbacks.attachmentIds,
    );
    const resolvedAttachments = await resolveCurrentAttachmentParts({
      storageDirectory: storageDirectory,
      sessionId: session.id,
      refs: attachmentRefs,
      runtimeProfile,
      audioProcessingOnly,
      signal: callbacks.signal,
    });
    const modelAttachmentRefs = audioProcessingOnly
      ? attachmentRefs.filter((ref) => ref.kind !== "audio") : attachmentRefs;
    const attachmentQuota = modelAttachmentRefs.map(attachmentQuotaItem);
    let documentTextCharacters = resolvedAttachments.documentTextCharacters;
    const history = await resolveConversationHistory({
      storageDirectory: storageDirectory,
      sessionId: session.id,
      events: priorEvents,
      currentAttachmentRefs: modelAttachmentRefs,
      currentDocumentTextCharacters:
        resolvedAttachments.documentTextCharacters,
      runtimeProfile,
      signal: callbacks.signal,
      onAttachmentIncluded: (ref, characters) => {
        attachmentQuota.push(attachmentQuotaItem(ref));
        documentTextCharacters += characters;
      },
    });
    let userEvent: SessionEvent;
    try {
      userEvent = await appendUserEvent(
        storageDirectory,
        session.id,
        {
          kind: "user",
          content: prompt,
          ...(attachmentRefs.length ? { attachments: attachmentRefs } : {}),
        },
      );
    } catch (error) {
      if (isStorageCommitOutcomeUnknownError(error)) {
        await callbacks.onSessionStateInvalidated?.();
        throw new ChatBridgePromptPersistenceUnknownError(
          "Prompt storage commit could not be confirmed.",
          { cause: error },
        );
      }
      throw error;
    }
    // Publish the durable receipt before later initialization can fail or honor
    // Stop; the bridge uses this event to classify prompt persistence.
    await callbacks.onSessionEvent(userEvent);
    return {
      attachmentRefs,
      attachmentParts: resolvedAttachments.parts,
      attachmentQuota,
      documentTextCharacters,
      history,
      initialRecoveryState: activeRecoveryLedgerFromEvents(priorEvents),
      recoveryContext: recoveryContextFromEvents(priorEvents),
      skillContext,
      userEvent,
      priorEventIds: priorEvents.map((event) => event.id),
    };
  };
  const prepared = await (callbacks.withAttachmentMutation
    ? callbacks.withAttachmentMutation(prepareRequest)
    : prepareRequest());
  let activeHistory = prepared.history;
  let activePrompt = prompt;
  let activeAttachmentParts = prepared.attachmentParts;
  let compactedAgentMessageCount = 0;
  let latestAcceptedContextUsage: ModelContextUsage | undefined;
  let latestAcceptedProjectionTokens: number | undefined;
  let pendingAcceptedProjectionTokens: number | undefined;
  let interruptedModelTurnPendingReset = false;
  const requestAudioAttachmentRefs = prepared.attachmentRefs.filter(
    (ref): ref is AudioSessionAttachmentRef => ref.kind === "audio",
  );
  const requestAudioSources = new Map(createRequestAudioSampleSources({
    context,
    storageDirectory,
    sessionId: session.id,
    requestId: prepared.userEvent.id,
    refs: requestAudioAttachmentRefs,
    signal: callbacks.signal,
  }));
  let audioSampleSourceInstructions = requestAudioSampleSourceInstructions(requestAudioSources);
  const requestAttachmentQuota = prepared.attachmentQuota;
  let requestDocumentTextCharacters = prepared.documentTextCharacters;
  const audioTools = await createRequestAudioTools({
    context, storageDirectory, sessionId: session.id, requestId: prepared.userEvent.id,
    attachmentRefs: requestAudioAttachmentRefs,
    target: interaction.target, signal: callbacks.signal, onProgress: callbacks.onProgress,
    ...(callbacks.withGenerationAuthorization ? { withGenerationAuthorization: callbacks.withGenerationAuthorization } : {}),
    ...(callbacks.audioProcessing ? { processing: callbacks.audioProcessing } : {}),
    ...(supportsArrangementAudioInput ? { modelAudioInput: {
      canAccept: (byteLength: number) => attachmentRequestQuotaIsWithinLimits([
        ...requestAttachmentQuota,
        { kind: "audio", byteLength },
      ]),
    } } : {}),
    onAssets: async (assets) => {
      await addAudioAssetSampleSources({ context, storageDirectory, sessionId: session.id, signal: callbacks.signal }, requestAudioSources, assets);
      audioSampleSourceInstructions = [
        requestAudioSampleSourceInstructions(requestAudioSources),
        audioAssetSampleSourceInstructions(requestAudioSources),
      ].filter(Boolean).join("\n\n");
    },
  });
  const pluginTools = await createRequestPluginTools({
    storageDirectory,
    pluginConfigSnapshots: prepared.skillContext.pluginConfigSnapshots ?? {},
    ...(context.environment?.tempDirectory === undefined
      ? {}
      : { temporaryDirectory: context.environment.tempDirectory }),
    sessionId: session.id,
    signal: callbacks.signal,
    fetchImpl: providerFetchForStorage(storageDirectory),
    ...(callbacks.withPluginAuthorization
      ? { withAuthorization: callbacks.withPluginAuthorization }
      : {}),
  });
  let externalTools: ToolRegistry;
  try {
    externalTools = new ToolRegistry([
      {
        id: "live-smith.creative-brief",
        tools: () => [creativeBriefProposalTool],
        callTool: async (call) => proposeCreativeBrief(call.arguments, session.creativeBrief ?? ""),
      },
      ...audioTools.toolsets,
      ...pluginTools.toolsets,
    ]);
  } catch (error) {
    await pluginTools.close();
    throw error;
  }
  const canReadArrangementAudio = () => supportsArrangementAudioInput &&
    attachmentRequestQuotaIsWithinLimits([
      ...requestAttachmentQuota,
      { kind: "audio", byteLength: 1 },
    ]);
  const knownEventIds = new Set([
    ...prepared.priorEventIds,
    prepared.userEvent.id,
  ]);
  const observedWebSearchIds = new Set<string>();
  const persistedWebSearches = new Map<string, Promise<SessionEvent>>();
  const observeWebSearchId = (webSearch: ModelHostedWebSearch): boolean => {
    if (observedWebSearchIds.has(webSearch.id)) return true;
    if (observedWebSearchIds.size >= HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND) {
      return false;
    }
    observedWebSearchIds.add(webSearch.id);
    return true;
  };
  const ensureTerminalWebSearchEvent = async (
    webSearch: ModelHostedWebSearch,
    content = webSearchSummary(webSearch),
  ): Promise<{ event: SessionEvent; first: boolean } | undefined> => {
    if (!observeWebSearchId(webSearch)) return undefined;
    const existing = persistedWebSearches.get(webSearch.id);
    if (existing) {
      const event = await existing;
      if (
        event.content !== content ||
        event.webSearch === undefined ||
        !sameHostedWebSearch(event.webSearch, webSearch)
      ) {
        throw new TypeError(
          "Hosted Web Search ID has conflicting terminal activity.",
        );
      }
      return { event, first: false };
    }

    const pending = appendTerminalWebSearchEvent(
      storageDirectory,
      session.id,
      { kind: "web_search", content, webSearch },
      knownEventIds,
      appendTraceEvent,
      loadEventsForSearchReconciliation,
    );
    persistedWebSearches.set(webSearch.id, pending);
    try {
      const event = await pending;
      knownEventIds.add(event.id);
      return { event, first: true };
    } catch (error) {
      if (persistedWebSearches.get(webSearch.id) === pending) {
        persistedWebSearches.delete(webSearch.id);
      }
      throw error;
    }
  };
  if (!session.title.trim()) {
    await updateSession(storageDirectory, session.id, {
      title: sessionTitleForPrompt(prompt, session.scope.label),
    });
  }
  const requestLiveContext = prepared.recoveryContext
    ? `${interaction.summary}\n\n${prepared.recoveryContext}`
    : interaction.summary;
  const autoCompactTokenLimit = resolveAutoCompactTokenLimit(runtimeProfile);
  const maybeCompactContext = async (
    agentMessages: Parameters<typeof buildModelRequest>[0]["agentMessages"],
    tools: Parameters<typeof buildModelRequest>[0]["tools"],
    editScopes: readonly EditScope[],
    signal: AbortSignal,
  ): Promise<void> => {
    if (autoCompactTokenLimit === undefined) return;
    const activeAgentMessages = agentMessages.slice(compactedAgentMessageCount);
    const estimatedTokens = estimateTransportContextTokens(buildModelRequest({
      prompt: activePrompt,
      liveContext: requestLiveContext,
      runtimeProfile,
      history: activeHistory,
      attachmentParts: activeAttachmentParts,
      ...(audioSampleSourceInstructions
        ? {
          requestAudioSampleSourceInstructions:
            audioSampleSourceInstructions,
        }
        : {}),
      skillContext: prepared.skillContext,
      editScopes,
      creativeBrief: session.creativeBrief ?? "",
      ...(callbacks.customInstructionsSnapshot === undefined
        ? {}
        : { customInstructions: callbacks.customInstructionsSnapshot }),
      agentMessages: activeAgentMessages,
      tools,
    }));
    const activeTokens = latestAcceptedContextUsage === undefined
      ? estimatedTokens
      : latestAcceptedContextUsage.usedTokens + Math.max(
          0,
          estimatedTokens - (latestAcceptedProjectionTokens ?? estimatedTokens),
        );
    if (activeTokens < autoCompactTokenLimit) return;

    await callbacks.onProgress("Compacting conversation context");
    const checkpoint = await createConversationCheckpoint({
      prompt: activePrompt,
      liveContext: requestLiveContext,
      runtimeProfile,
      history: activeHistory,
      attachmentParts: activeAttachmentParts,
      skillContext: prepared.skillContext,
      editScopes,
      creativeBrief: session.creativeBrief ?? "",
      ...(callbacks.customInstructionsSnapshot === undefined
        ? {}
        : { customInstructions: callbacks.customInstructionsSnapshot }),
      agentMessages: activeAgentMessages,
      signal,
      requestTurn: async (input) => (await requestModelWithReconnect({
        signal,
        resetTransient: () => {},
        onProgress: callbacks.onProgress,
        ...(waitForReconnectDelay
          ? { waitForDelay: waitForReconnectDelay }
          : {}),
        request: ({ reconnectState }) => requestTurn({
          ...input,
          reconnectState,
        }),
      })).value,
    });
    const event = await appendTraceEvent(storageDirectory, session.id, {
      kind: "compaction",
      content: checkpoint,
    });
    knownEventIds.add(event.id);
    await callbacks.onSessionEvent(event);

    activeHistory = [{
      role: "user",
      content: [{
        type: "text",
        text: conversationCheckpointMessage(checkpoint),
      }],
    }];
    activePrompt = "Continue the current request from the conversation checkpoint.";
    activeAttachmentParts = [];
    compactedAgentMessageCount = agentMessages.length;
    latestAcceptedContextUsage = undefined;
    latestAcceptedProjectionTokens = undefined;
    pendingAcceptedProjectionTokens = undefined;
    await callbacks.onModelTurnAccepted?.(undefined);
  };
  // Committed changes update the synchronous action boundary without inserting
  // a disk await after the final Live-state drift check.
  const unsubscribeEditScopes = subscribeSessionEditScopesChanges(
    storageDirectory,
    (change) => {
      if (change.sessionId !== session.id) return;
      editScopesGeneration += 1;
      activeEditScopes = resolveEditScopes(change.editScopes);
    },
  );
  const unsubscribeEditScopesInvalidations = subscribeSessionEditScopesInvalidations(
    storageDirectory,
    (changedSessionId) => {
      if (changedSessionId !== session.id) return;
      editScopesGeneration += 1;
      activeEditScopes = undefined;
    },
  );
  try {
    await callbacks.onProgress("Starting agent loop");
    if (pluginTools.unavailableMidiArtifacts) {
      await callbacks.onProgress(uiMessage(
        "{count} saved MIDI artifacts are unavailable; their metadata was preserved.",
        { count: pluginTools.unavailableMidiArtifacts },
      ));
    }
    const loopResult = await runAgentLoop({
      externalTools: {
        names: externalTools.tools().map((tool) => tool.function.name),
        execute: (call) => externalTools.callTool(call),
      },
      maxConsecutiveFailures: maxConsecutiveInvalidToolCalls,
      maxIterations: 12,
      maxToolCallsPerTurn: 32,
      maxModelContinuations: 2,
      maxHostFailuresWithoutMutation: 6,
      ...(prepared.initialRecoveryState
        ? { initialRecoveryState: prepared.initialRecoveryState }
        : {}),
      signal: callbacks.signal,
      ...(callbacks.steering
        ? {
          consumeSteering: async () => {
            const acceptedMessages: Extract<ModelConversationMessage, { role: "user" }>[] = [];
            for (;;) {
              const [entry] = callbacks.steering?.takePending(1) ?? [];
              if (!entry) break;
              let appendStarted = false;
              const prepareSteering = async () => {
                if (!callbacks.steeringSendId) {
                  throw new Error("The active send is missing its steering correlation ID.");
                }
                const events = await loadSessionEvents(storageDirectory, session.id);
                const refs = await resolvePendingAttachmentRefs(
                  storageDirectory, session.id, events, entry.attachmentIds ?? [],
                );
                const modelRefs = refs.filter((ref) => !audioProcessingOnly || ref.kind !== "audio");
                if (modelRefs.length && !attachmentRequestQuotaIsWithinLimits([
                  ...requestAttachmentQuota, ...modelRefs.map(attachmentQuotaItem),
                ])) {
                  throw new AttachmentProcessingError(
                    "archive_limit", "Attachments exceed the model request limit.",
                  );
                }
                const resolved = await resolveCurrentAttachmentParts({
                  storageDirectory,
                  sessionId: session.id,
                  refs,
                  runtimeProfile,
                  audioProcessingOnly,
                  signal: callbacks.signal,
                });
                if (resolved.documentTextCharacters >
                  MAX_REQUEST_DOCUMENT_TEXT_CHARACTERS - requestDocumentTextCharacters) {
                  throw new AttachmentProcessingError(
                    "archive_limit", "Extracted document text exceeds the model request limit.",
                  );
                }
                appendStarted = true;
                const event = await appendSteeringUserEvent(
                  storageDirectory, session.id, callbacks.steeringSendId,
                  entry.id, entry.prompt, refs, appendUserEvent,
                  loadEventsForSearchReconciliation,
                );
                return { event, refs, resolved };
              };
              let steered: Awaited<ReturnType<typeof prepareSteering>>;
              try {
                steered = await (callbacks.withAttachmentMutation
                  ? callbacks.withAttachmentMutation(prepareSteering)
                  : prepareSteering());
              } catch (error) {
                const rejection = appendStarted && !(error instanceof SteeringPersistenceOutcomeUnknownError)
                  ? new Error("The steering message could not be persisted.", { cause: error })
                  : error instanceof Error ? error : new Error(String(error));
                entry.reject(rejection);
                throwIfAborted(callbacks.signal);
                if (appendStarted) throw error;
                continue;
              }
              requestAttachmentQuota.push(...steered.refs
                .filter((ref) => !audioProcessingOnly || ref.kind !== "audio").map(attachmentQuotaItem));
              requestDocumentTextCharacters += steered.resolved.documentTextCharacters;
              requestAudioAttachmentRefs.push(...steered.refs.filter(
                (ref): ref is AudioSessionAttachmentRef => ref.kind === "audio",
              ));
              for (const [key, source] of createRequestAudioSampleSources({
                context, storageDirectory, sessionId: session.id,
                requestId: prepared.userEvent.id, refs: requestAudioAttachmentRefs,
                signal: callbacks.signal,
              })) {
                if (!requestAudioSources.has(key)) requestAudioSources.set(key, source);
              }
              audioSampleSourceInstructions = [
                requestAudioSampleSourceInstructions(requestAudioSources),
                audioAssetSampleSourceInstructions(requestAudioSources),
              ].filter(Boolean).join("\n\n");
              knownEventIds.add(steered.event.id);
              entry.accept();
              acceptedMessages.push({
                role: "user",
                content: steered.resolved.parts.length
                  ? [{ type: "text", text: entry.prompt }, ...steered.resolved.parts]
                  : entry.prompt,
              });
              await callbacks.onSessionEvent(steered.event);
              break;
            }
            if (!acceptedMessages.length && interruptedModelTurnPendingReset) {
              await (callbacks.onModelRequestRetry
                ? callbacks.onModelRequestRetry()
                : callbacks.onAssistantReset?.());
              interruptedModelTurnPendingReset = false;
            }
            return acceptedMessages;
          },
          hasPendingSteering: () => callbacks.steering?.hasPending() ?? false,
          onSteeringApplied: async (messageCount: number) => {
            interruptedModelTurnPendingReset = false;
            await callbacks.onAssistantReset?.();
            await callbacks.onProgress(
              messageCount === 1
                ? "Replanning with new guidance"
                : `Replanning with ${messageCount} new guidance messages`,
            );
          },
        }
        : {}),
      onModelTurnAccepted: async (usage) => {
        latestAcceptedContextUsage = usage;
        latestAcceptedProjectionTokens = usage === undefined
          ? undefined
          : pendingAcceptedProjectionTokens;
        pendingAcceptedProjectionTokens = undefined;
        await callbacks.onModelTurnAccepted?.(usage);
      },
      askModel: async (input) => {
        pendingAcceptedProjectionTokens = undefined;
        await callbacks.onProgress(
          `Thinking with ${profile.name} / ${runtimeProfile.model.model}`,
        );
        const editScopes = await readEditScopes();
        const toolsForCurrentState = () => modelToolsForProfile(
          runtimeProfile,
          [...liveSmithTools({
            readArrangementAudio: canReadArrangementAudio(),
            ...(pluginTools.midiArtifacts().length
              ? { additionalActionSchemas: [midiArtifactImportActionSchema] }
              : {}),
          }), ...externalTools.tools()],
          Math.min(
            HOSTED_WEB_SEARCH_REQUEST_MAX_USES,
            Math.max(
              0,
              HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND - observedWebSearchIds.size,
            ),
          ),
        );
        const tools = toolsForCurrentState();
        const modelTurn = callbacks.steering?.beginModelTurn(callbacks.signal);
        const turnSignal = modelTurn?.signal ?? callbacks.signal;
        let turn: ModelTurn;
        let reconnected = false;
        try {
          if (!input.continuation) {
            await maybeCompactContext(input.messages, tools, editScopes, turnSignal);
          }
          await callbacks.onModelRequestStarted?.();
          const result = await requestModelWithReconnect({
            signal: turnSignal,
            resetTransient: () => callbacks.onModelRequestRetry
              ? callbacks.onModelRequestRetry()
              : callbacks.onAssistantReset?.(),
            onProgress: callbacks.onProgress,
            ...(waitForReconnectDelay
              ? { waitForDelay: waitForReconnectDelay }
              : {}),
            request: async ({ markResponseStarted, reconnectState }) => {
              const requestInput: Omit<ModelTurnRequestInput, "turnExecutor"> = {
                prompt: activePrompt,
                liveContext: requestLiveContext,
                runtimeProfile,
                history: activeHistory,
                attachmentParts: activeAttachmentParts,
                ...(audioSampleSourceInstructions
                  ? {
                    requestAudioSampleSourceInstructions:
                      audioSampleSourceInstructions,
                  }
                  : {}),
                skillContext: prepared.skillContext,
                editScopes: await readEditScopes(),
                creativeBrief: session.creativeBrief ?? "",
                ...(callbacks.customInstructionsSnapshot === undefined
                  ? {}
                  : { customInstructions: callbacks.customInstructionsSnapshot }),
                agentMessages: input.messages.slice(compactedAgentMessageCount),
                tools: toolsForCurrentState(),
                reconnectState,
                signal: turnSignal,
                onDelta: async (delta) => {
                  await markResponseStarted();
                  await callbacks.onDelta(delta);
                },
                onReasoning: async (update) => {
                  await markResponseStarted();
                  await callbacks.onReasoningUpdate?.(update);
                },
                onHostedWebSearch: async (update) => {
                  await markResponseStarted();
                  if (update.status !== "searching") {
                    const persisted = await ensureTerminalWebSearchEvent(update);
                    if (persisted?.first) {
                      await callbacks.onSessionEvent(persisted.event);
                    }
                  } else {
                    if (!observeWebSearchId(update)) return;
                    if (persistedWebSearches.has(update.id)) {
                      throw new TypeError(
                        "Hosted Web Search reported in-flight activity after its terminal event.",
                      );
                    }
                    await callbacks.onWebSearchUpdate?.(update);
                  }
                  await callbacks.onProgress(webSearchProgressMessage(update));
                },
              };
              const value = await requestTurn(requestInput);
              pendingAcceptedProjectionTokens = estimateTransportContextTokens(
                buildModelRequest({
                  ...requestInput,
                  agentMessages: [
                    ...requestInput.agentMessages,
                    {
                      role: "assistant",
                      content: value.content,
                      toolCalls: value.toolCalls,
                      ...(value.providerState === undefined
                        ? {}
                        : { providerState: value.providerState }),
                    },
                  ],
                }),
              );
              return value;
            },
          });
          turn = result.value;
          reconnected = result.reconnected;
        } catch (error) {
          throwIfAborted(callbacks.signal);
          if (modelTurn?.wasInterrupted()) {
            interruptedModelTurnPendingReset = true;
            throw new AgentSteeringInterruptError();
          }
          throw error;
        } finally {
          modelTurn?.dispose();
        }
        throwIfAborted(callbacks.signal);
        if (modelTurn?.wasInterrupted()) {
          interruptedModelTurnPendingReset = true;
          throw new AgentSteeringInterruptError();
        }
        if (!reconnected) {
          await callbacks.onProgress("Reading model response");
        }
        return turn;
      },
      observe: async (request) => {
        if (request.type === "read_arrangement_audio") {
          if (!supportsArrangementAudioInput) {
            throw new Error(
              "read_arrangement_audio is not available for the active model Profile.",
            );
          }
          if (!attachmentRequestQuotaIsWithinLimits([
            ...requestAttachmentQuota,
            { kind: "audio", byteLength: 1 },
          ])) {
            throw new AttachmentProcessingError(
              "archive_limit",
              "Rendered audio would exceed the model request attachment limits.",
            );
          }
          const rendered = await readArrangementAudio(
            context,
            request,
            interaction.target,
            callbacks.signal,
          );
          const quotaItem: AttachmentQuotaItem = {
            kind: "audio",
            byteLength: rendered.bytes.byteLength,
          };
          if (!attachmentRequestQuotaIsWithinLimits([
            ...requestAttachmentQuota,
            quotaItem,
          ])) {
            throw new AttachmentProcessingError(
              "archive_limit",
              "Rendered audio would exceed the model request attachment limits.",
            );
          }
          return {
            content: rendered.summary,
            modelInputPart: {
              type: "audio",
              fileName: rendered.fileName,
              mediaType: rendered.inspection.mediaType,
              bytes: rendered.bytes,
            },
          };
        }
        const observation = await observeLive(
          context,
          request,
          interaction.target,
          callbacks.signal,
        );
        throwIfAborted(callbacks.signal);
        return observation;
      },
      onModelInputPartAccepted: (part) => {
        requestAttachmentQuota.push({
          kind: "audio",
          byteLength: part.bytes.byteLength,
        });
      },
      preflightActions: (plan) =>
        preflightAgentPlan(
          context, interaction, plan, callbacks.signal,
          undefined, undefined, {
            refresh: readEditScopes,
            assert: (requestedPlan, bindings) => assertEditScopesAllow(
              requiredEditScopesForPlan(context, requestedPlan, bindings),
              currentEditScopes(),
            ),
          },
          requestAudioSources,
        ),
      prepareActionPlan: (toolCall) => materializeMidiArtifactActionPlan({
        argumentsJson: toolCall.arguments,
        storageDirectory,
        sessionId: session.id,
        signal: callbacks.signal,
      }),
      confirmActions: callbacks.confirmActions,
      ...(callbacks.confirmRecoveryResolution
        ? { confirmRecoveryResolution: callbacks.confirmRecoveryResolution }
        : {}),
      executeActions: async (plan, rawBindings, revalidateAfterImport) => {
        let bindings = rawBindings as AgentPlanBindings;
        const assertActionBoundary = (actionIndex: number, action: AgentPlan["actions"][number]) => {
          assertEditScopesAllow(
            requiredEditScopesForAction(context, action, actionIndex, bindings),
            currentEditScopes(),
          );
          if (callbacks.steering?.hasPending()) {
            throw new AgentSteeringBeforeApplyError(
              "Newer user guidance arrived before the next Live action began. " +
                "The remaining actions in this plan were not executed.",
            );
          }
        };
        let importProgress: RequestAudioImportProgress = {
          results: [],
          keys: [],
        };
        let outcome: AgentActionExecutionOutcome;
        try {
          importProgress = await prepareRequestAudioSampleSources(
            bindings,
            callbacks.signal,
            () => {
              assertEditScopesAllow(
                requiredEditScopesForPlan(context, plan, bindings),
                currentEditScopes(),
              );
              if (callbacks.steering?.hasPending()) {
                throw new AgentSteeringBeforeApplyError(
                  "Newer user guidance arrived while the audio attachment was being imported. " +
                    "The remaining Live actions were not executed.",
                );
              }
            },
          );
          if (importProgress.results.length > 0) {
            bindings = await revalidateAfterImport() as AgentPlanBindings;
          }
          outcome = await executeAgentPlanWithProgress(
            context,
            plan,
            interaction.target,
            callbacks.signal,
            bindings,
            assertActionBoundary,
          );
          outcome = {
            results: [...importProgress.results, ...outcome.results],
            mutationCount: importProgress.results.length + outcome.mutationCount,
          };
        } catch (caught) {
          const error = mergeRequestAudioImportProgress(importProgress, caught);
          if (
            error instanceof AgentPlanExecutionError &&
            error.cause instanceof AgentSteeringBeforeApplyError &&
            error.completedResults.length === 0 &&
            error.completedMutationCount === 0
          ) {
            throwIfAborted(callbacks.signal);
            throw error.cause;
          }
          if (
            callbacks.signal.aborted &&
            error instanceof AgentPlanExecutionError &&
            error.completedResults.length &&
            isAbortCause(error.cause, callbacks.signal)
          ) {
            outcome = {
              results: error.completedResults,
              mutationCount: error.completedMutationCount,
              incompleteRecovery: {
                completedActionKeys: error.completedActionKeys,
                completedActionCount: error.completedActionCount,
                failureMessage:
                  "The request was stopped before every confirmed Live action completed.",
              },
            };
          } else if (error instanceof AgentPlanExecutionError) {
            throw new AgentPartialCompletionError(
              error.completedResults,
              error.cause,
              error.failedActionIndex,
              error.failedAction,
              error.failedTrackName,
              error.completedActionKeys,
              error.completedMutationCount,
              error.failedTrackSelector,
              error.completedActionCount,
            );
          } else {
            throw error;
          }
        }
        await callbacks.onProgress("Updating chat history");
        return outcome;
      },
      ...(callbacks.withActionExecutionLock
        ? { withActionExecutionLock: callbacks.withActionExecutionLock }
        : {}),
      onEvent: async (event) => {
        if (event.kind === "web_search") {
          const persisted = await ensureTerminalWebSearchEvent(
            event.webSearch,
            event.content,
          );
          if (persisted?.first) {
            await callbacks.onSessionEvent(persisted.event);
          }
          return;
        }
        const sessionEvent = await appendAgentLoopTraceEvent(
          storageDirectory,
          session.id,
          event,
          appendTraceEvent,
        );
        knownEventIds.add(sessionEvent.id);
        await callbacks.onSessionEvent(sessionEvent);
      },
      onProgress: callbacks.onProgress,
    });
    return loopResult.message;
  } catch (error) {
    if (
      isStorageCommitOutcomeUnknownError(error) ||
      error instanceof AgentRecoveryResolutionReportingError ||
      error instanceof SteeringPersistenceOutcomeUnknownError
    ) {
      await callbacks.onSessionStateInvalidated?.();
    }
    try {
      const errorEvent = await appendSessionEvent(
        storageDirectory,
        session.id,
        {
          kind: "error",
          ...(error instanceof ModelInputTooLargeError ? { name: "input_too_large" } : {}),
          content: sessionErrorMessage(error, profileSecrets(profile)),
        },
      );
      await callbacks.onSessionEvent(errorEvent);
    } catch (persistenceError) {
      if (isStorageCommitOutcomeUnknownError(persistenceError)) {
        await callbacks.onSessionStateInvalidated?.();
      }
      console.error("Failed to persist the agent request error.", persistenceError);
    }
    throw error;
  } finally {
    await externalTools.close();
    unsubscribeEditScopes();
    unsubscribeEditScopesInvalidations();
  }
}

function attachmentQuotaItem(ref: SessionAttachmentRef): AttachmentQuotaItem {
  return { kind: ref.kind, byteLength: ref.byteLength };
}

function isAbortCause(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if ("reason" in signal) return error === signal.reason;
  return error instanceof Error && /abort/i.test(error.message);
}

export async function preflightAgentPlan(
  context: Api,
  interaction: LiveInteractionContext,
  plan: AgentPlan,
  signal: AbortSignal,
  observer: typeof observeLive = observeLive,
  snapshotter: (
    context: Api,
    action: AgentPlan["actions"][number],
    target: LiveInteractionContext["target"],
    requestAudioSources?: RequestAudioSampleSources,
    includePreview?: boolean,
  ) => string | LiveActionPreflightObservation | Promise<string | LiveActionPreflightObservation> = captureLiveActionPreflightObservation,
  authorization?: {
    refresh(): Promise<unknown>;
    assert(plan: AgentPlan, bindings: AgentPlanBindings): void;
  },
  requestAudioSources?: RequestAudioSampleSources,
): Promise<AgentActionPreflightGuard<AgentPlanBindings>> {
  await authorization?.refresh();
  const initialBindings = bindAgentPlanTargets(
    context,
    plan,
    interaction.target,
    requestAudioSources,
  );
  const initialSnapshots = await captureAgentPlanPreflightSnapshots(
    context,
    interaction,
    plan,
    signal,
    observer,
    snapshotter,
    initialBindings,
    requestAudioSources,
    plan.actions.length === 1,
  );
  authorization?.assert(plan, initialBindings);

  const guard: AgentActionPreflightGuard<AgentPlanBindings> = async () => {
    await authorization?.refresh();
    const currentBindings = bindAgentPlanTargets(
      context,
      plan,
      interaction.target,
      requestAudioSources,
    );
    assertSameExistingPlanTargets(initialBindings, currentBindings);
    const currentSnapshots = await captureAgentPlanPreflightSnapshots(
      context,
      interaction,
      plan,
      signal,
      observer,
      snapshotter,
      currentBindings,
      requestAudioSources,
    );
    const changedIndex = currentSnapshots.findIndex(
      (snapshot, index) => snapshot.fingerprint !== initialSnapshots[index]?.fingerprint,
    );
    if (
      changedIndex !== -1 ||
      currentSnapshots.length !== initialSnapshots.length
    ) {
      const actionNumber = changedIndex === -1 ? 1 : changedIndex + 1;
      throw new Error(
        `Live target or relevant state changed for action ${actionNumber} while confirmation was open. Inspect the current Live state and try again.`,
      );
    }
    authorization?.assert(plan, currentBindings);
    return currentBindings;
  };
  Object.defineProperty(guard, "actionKeys", {
    enumerable: true,
    value: planActionIdentityKeys(plan, initialBindings),
  });
  const preview = plan.actions.length === 1 ? initialSnapshots[0]?.preview : undefined;
  if (preview) {
    Object.defineProperty(guard, "previews", { enumerable: true, value: [preview] });
  }
  return guard;
}

function planActionIdentityKeys(
  plan: AgentPlan,
  bindings: AgentPlanBindings,
): string[][] {
  const aliases = new Map(
    Object.entries(plan.targets ?? {}).flatMap(([ref, target]) =>
      target.trackName ? [[ref, target.trackName] as const] : []
    ),
  );
  return plan.actions.map((action, actionIndex) => {
    const boundTrack = boundTrackForAction(action, actionIndex, bindings);
    const trackAliases: string[] = [];
    if ("trackRef" in action && action.trackRef) {
      const alias = aliases.get(action.trackRef);
      if (alias) trackAliases.push(alias);
    } else if ("trackName" in action && action.trackName) {
      trackAliases.push(action.trackName);
    }
    const target = "trackRef" in action && action.trackRef
      ? plan.targets?.[action.trackRef]
      : undefined;
    const nonRegularTrack = target?.trackRole === "return"
      ? { role: "return" as const }
      : target?.trackRole === "main"
        ? { role: "main" as const }
        : undefined;
    const keys = liveActionIdentityKeys(
      action,
      boundTrack,
      trackAliases,
      nonRegularTrack,
    );
    if (
      (action.type === "create_midi_track" || action.type === "create_audio_track") &&
      action.ref &&
      action.name
    ) {
      aliases.set(action.ref, action.name);
    }
    if (action.type === "rename_track" && action.trackRef) {
      aliases.set(action.trackRef, action.newName);
    } else if (action.type === "rename_track" && action.trackName) {
      for (const [ref, name] of aliases) {
        if (normalizedIdentityText(name) === normalizedIdentityText(action.trackName)) {
          aliases.set(ref, action.newName);
        }
      }
    }
    return keys;
  });
}

function normalizedIdentityText(value: string): string {
  return value.trim().toLowerCase();
}

async function captureAgentPlanPreflightSnapshots(
  context: Api,
  interaction: LiveInteractionContext,
  plan: AgentPlan,
  signal: AbortSignal,
  observer: typeof observeLive,
  snapshotter: (
    context: Api,
    action: AgentPlan["actions"][number],
    target: LiveInteractionContext["target"],
    requestAudioSources?: RequestAudioSampleSources,
    includePreview?: boolean,
  ) => string | LiveActionPreflightObservation | Promise<string | LiveActionPreflightObservation>,
  bindings: AgentPlanBindings,
  requestAudioSources?: RequestAudioSampleSources,
  includePreview = false,
): Promise<LiveActionPreflightObservation[]> {
  const snapshots: LiveActionPreflightObservation[] = [];
  for (const [actionIndex, action] of plan.actions.entries()) {
    throwIfAborted(signal);
    const boundTrack = boundTrackForAction(action, actionIndex, bindings);
    if ("trackRef" in action && action.trackRef && !boundTrack) {
      snapshots.push({ fingerprint: `deferred:${action.type}:${action.trackRef}` });
      continue;
    }
    const actionTarget = boundTrack
      ? { ...interaction.target, track: boundTrack }
      : interaction.target;
    await observer(
      context,
      observationRequestForAction(action),
      actionTarget,
    );
    throwIfAborted(signal);
    const captured = await snapshotter(
      context,
      action,
      actionTarget,
      requestAudioSources,
      includePreview,
    );
    snapshots.push(typeof captured === "string" ? { fingerprint: captured } : captured);
    throwIfAborted(signal);
  }
  return snapshots;
}

interface AgentRequestCallbacks {
  withGenerationAuthorization?: AudioProcessingContext["withGenerationAuthorization"];
  withPluginAuthorization?: PluginExecutionAuthorization;
  /** Test seam for the external service; no service config is accepted in /send. */
  audioProcessing?: Pick<AudioProcessingContext, "adapter" | "generationAdapter" | "wait">;
  signal: AbortSignal;
  /** Undefined sends all pending files; an explicit list sends exactly those files. */
  attachmentIds?: readonly string[];
  withAttachmentMutation?<T>(operation: () => Promise<T>): Promise<T>;
  /** Configuration snapshot captured atomically with the selected Profile. */
  skillContextSnapshot?: ResolvedSkillContext;
  /** Global user-authored preferences captured atomically for this send. */
  customInstructionsSnapshot?: string;
  steering?: SteeringChannel;
  steeringSendId?: string;
  onDelta(delta: string): Promise<void> | void;
  onReasoningUpdate?(
    update: ModelReasoningStreamUpdate,
  ): Promise<void> | void;
  onModelRequestStarted?(): Promise<void> | void;
  onModelRequestRetry?(): Promise<void> | void;
  onAssistantReset?(): Promise<void> | void;
  onModelTurnAccepted?(usage: ModelContextUsage | undefined): Promise<void> | void;
  onProgress(message: UiMessage): Promise<void> | void;
  onWebSearchUpdate?(
    update: ModelHostedWebSearch,
  ): Promise<void> | void;
  onSessionEvent(event: SessionEvent): Promise<void> | void;
  onSessionStateInvalidated?(): Promise<void> | void;
  confirmActions(
    plan: AgentPlan,
    guard: AgentActionPreflightGuard<AgentPlanBindings>,
  ): Promise<boolean | AgentConfirmationDecision>;
  confirmRecoveryResolution?(message: string): Promise<boolean>;
  withActionExecutionLock?(
    operation: () => Promise<AgentActionExecutionOutcome>,
  ): Promise<AgentActionExecutionOutcome>;
}

export type AgentModelTurnRequester = (
  input: Omit<ModelTurnRequestInput, "turnExecutor">,
) => ReturnType<typeof requestModelTurn>;

export function consumedAttachmentIds(events: readonly SessionEvent[]): string[] {
  return [...new Set(events.flatMap((event) =>
    event.attachments?.map((attachment) => attachment.id) ?? []
  ))];
}

async function resolvePendingAttachmentRefs(
  storageDirectory: string | undefined,
  sessionId: string,
  events: readonly SessionEvent[],
  attachmentIds: readonly string[] | undefined,
): Promise<SessionAttachmentRef[]> {
  const pending = await listPendingSessionAttachments(
    storageDirectory, sessionId, consumedAttachmentIds(events),
  );
  if (attachmentIds === undefined) return pending.map(sessionAttachmentRefFromStored);
  const pendingById = new Map(pending.map((attachment) => [attachment.id, attachment]));
  return attachmentIds.map((id) => {
    const attachment = pendingById.get(id);
    if (!attachment) {
      throw new Error("A selected attachment is no longer pending in this Session.");
    }
    return sessionAttachmentRefFromStored(attachment);
  });
}
async function appendAgentLoopTraceEvent(
  storageDirectory: string | undefined,
  sessionId: string,
  event: AgentLoopTraceEvent,
  appendEvent: typeof appendSessionEvent = appendSessionEvent,
): Promise<SessionEvent> {
  if ("name" in event) {
    return appendEvent(storageDirectory, sessionId, {
      kind: event.kind,
      name: event.name,
      content: event.content,
    });
  }

  return appendEvent(storageDirectory, sessionId, {
    kind: event.kind,
    content: event.content,
    ...(event.kind === "web_search" ? { webSearch: event.webSearch } : {}),
    ...(event.kind === "assistant" && event.citations?.length
      ? { citations: event.citations }
      : {}),
    ...(event.kind === "apply_result" && event.recovery
      ? { recovery: event.recovery }
      : {}),
  });
}

async function appendTerminalWebSearchEvent(
  storageDirectory: string | undefined,
  sessionId: string,
  input: SessionEventInput & {
    kind: "web_search";
    webSearch: ModelHostedWebSearch;
  },
  knownEventIds: ReadonlySet<string>,
  appendEvent: typeof appendSessionEvent,
  loadEvents: typeof loadSessionEvents,
): Promise<SessionEvent> {
  let reconciledUnknownOutcome = false;
  for (;;) {
    try {
      return await appendEvent(storageDirectory, sessionId, input);
    } catch (error) {
      if (!isStorageCommitOutcomeUnknownError(error)) throw error;

      const authoritativeEvents = await loadEvents(storageDirectory, sessionId);
      const committed = authoritativeEvents.find((event) =>
        !knownEventIds.has(event.id) &&
        event.kind === "web_search" &&
        event.content === input.content &&
        event.webSearch !== undefined &&
        sameHostedWebSearch(event.webSearch, input.webSearch)
      );
      if (committed) return committed;
      if (reconciledUnknownOutcome) throw error;
      reconciledUnknownOutcome = true;
    }
  }
}

async function appendSteeringUserEvent(
  storageDirectory: string | undefined,
  sessionId: string,
  sendId: string,
  steerId: string,
  content: string,
  attachmentRefs: SessionAttachmentRef[],
  appendEvent: typeof appendSessionEvent,
  loadEvents: typeof loadSessionEvents,
): Promise<SessionEvent> {
  const steeringReceipt = steeringReceiptFor(
    sendId, steerId, content, attachmentRefs.map((ref) => ref.id),
  );
  const input = {
    kind: "user" as const,
    content,
    steeringReceipt,
    ...(attachmentRefs.length ? { attachments: attachmentRefs } : {}),
  };
  let reconciledUnknownOutcome = false;
  for (;;) {
    try {
      return await appendEvent(storageDirectory, sessionId, input);
    } catch (error) {
      if (!isStorageCommitOutcomeUnknownError(error)) throw error;

      let authoritativeEvents: SessionEvent[];
      try {
        authoritativeEvents = await loadEvents(storageDirectory, sessionId);
      } catch (cause) {
        throw new SteeringPersistenceOutcomeUnknownError(sendId, steerId, {
          cause,
        });
      }
      const committed = authoritativeEvents.find((event) =>
        event.steeringReceipt?.sendId === sendId &&
        event.steeringReceipt.id === steerId
      );
      if (committed) {
        if (
          committed.kind !== "user" ||
          committed.content !== content ||
          committed.steeringReceipt?.sha256 !== steeringReceipt.sha256
        ) {
          throw new SessionSteeringReceiptConflictError(sendId, steerId);
        }
        return committed;
      }
      if (reconciledUnknownOutcome) {
        throw new SteeringPersistenceOutcomeUnknownError(sendId, steerId, {
          cause: error,
        });
      }
      reconciledUnknownOutcome = true;
    }
  }
}

export function steeringReceiptFor(
  sendId: string,
  steerId: string,
  content: string,
  attachmentIds?: readonly string[],
): SessionSteeringReceipt {
  return {
    sendId,
    id: steerId,
    sha256: sessionSteeringContentSha256(content, attachmentIds),
  };
}

function sameHostedWebSearch(
  left: ModelHostedWebSearch,
  right: ModelHostedWebSearch,
): boolean {
  return left.id === right.id &&
    left.status === right.status &&
    left.action === right.action &&
    left.queries.length === right.queries.length &&
    left.queries.every((query, index) => query === right.queries[index]) &&
    left.sources.length === right.sources.length &&
    left.sources.every((source, index) =>
      source.url === right.sources[index]?.url &&
      source.title === right.sources[index]?.title
    );
}

function webSearchProgressMessage(update: ModelHostedWebSearch): string {
  if (update.status === "searching") {
    return update.queries[0]
      ? `Searching for “${update.queries[0]}”…`
      : "Searching the web…";
  }
  if (update.status === "failed") return "Web Search failed.";
  const pages = update.sources.length;
  return pages > 0
    ? `Reviewing ${pages} web ${pages === 1 ? "page" : "pages"}…`
    : "Reading Web Search results…";
}
