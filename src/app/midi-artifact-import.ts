import type { ExtensionContext } from "@ableton-extensions/sdk";
import { summarizeActionPlan, type AgentPlan } from "../agent/actions.js";
import { assertEditScopesAllow, EditScopeDeniedError, resolveEditScopes, type EditScope } from "../agent/edit-scopes.js";
import { digestActionIdentity, type AgentConfirmationDecision } from "../agent/loop.js";
import { requiredEditScopesForAction, requiredEditScopesForPlan } from "../live/action-permissions.js";
import type { LiveInteractionContext } from "../live/context.js";
import { AgentPlanExecutionError, executeAgentPlanWithProgress } from "../live/executor.js";
import { materializeMidiArtifactActionPlan } from "../plugins/artifacts.js";
import { throwIfAborted } from "../runtime/host.js";
import { appendSessionEvent, loadSessionEvents } from "../storage/events.js";
import { listSessions } from "../storage/sessions.js";
import { preflightAgentPlan } from "./agent-request.js";
import { ChatBridgeCommandOutcomeUnknownError, ChatBridgeConflictError } from "./chat-bridge.js";
import { activeRecoveryLedgerFromEvents } from "./session-context.js";
import type { LiveMutationQueue } from "./live-mutation-queue.js";
import { subscribeSessionEditScopesChanges, subscribeSessionEditScopesInvalidations } from "./session-edit-scope-events.js";

export interface MidiArtifactImportCommand {
  kind: "import_midi_artifact";
  sessionId: string;
  artifactRef: string;
  trackName: string;
  startBeat: number;
  name?: string;
}

/** Called with the Session send fence held; all Live writes use the shared queue. */
export async function importMidiArtifact(input: MidiArtifactImportCommand & {
  context: ExtensionContext<"1.0.0">;
  storageDirectory: string | undefined;
  projectKey: string;
  interaction: LiveInteractionContext;
  signal: AbortSignal;
  mutationQueue: LiveMutationQueue;
  confirm(plan: AgentPlan, guard: Awaited<ReturnType<typeof preflightAgentPlan>>): Promise<AgentConfirmationDecision>;
}): Promise<boolean> {
  let plan: AgentPlan | undefined;
  let mutationStarted = false;
  let completedActionKeys: readonly (readonly string[])[] = [];
  let completedActionCount = 0;
  let scopes: EditScope[] | undefined;
  let generation = 0;
  const currentScopes = () => {
    if (!scopes) throw new EditScopeDeniedError([]);
    return scopes;
  };
  const refresh = async () => {
    const version = generation;
    const session = (await listSessions(input.storageDirectory, input.projectKey)).find(
      (entry) => entry.id === input.sessionId && !entry.archivedAt,
    );
    if (!session) throw new Error("That Session is not available in this Live Set.");
    throwIfAborted(input.signal);
    if (version === generation) scopes = resolveEditScopes(session.editScopes);
  };
  const unsubscribe = subscribeSessionEditScopesChanges(input.storageDirectory, (change) => {
    if (change.sessionId !== input.sessionId) return;
    generation += 1;
    scopes = resolveEditScopes(change.editScopes);
  });
  const invalidate = subscribeSessionEditScopesInvalidations(input.storageDirectory, (sessionId) => {
    if (sessionId !== input.sessionId) return;
    generation += 1;
    scopes = undefined;
  });
  const record = (kind: "apply_requested" | "apply_result" | "apply_auto_approved" | "error", content: string) =>
    appendSessionEvent(input.storageDirectory, input.sessionId, { kind, content });
  try {
    const recovery = activeRecoveryLedgerFromEvents(await loadSessionEvents(input.storageDirectory, input.sessionId));
    if (recovery) {
      throw new ChatBridgeConflictError("This Session has an unfinished Live operation. Inspect and resolve it in chat before importing MIDI.");
    }
    await refresh();
    const importPlan = plan = await materializeMidiArtifactActionPlan({
      storageDirectory: input.storageDirectory, sessionId: input.sessionId, signal: input.signal,
      argumentsJson: JSON.stringify({ message: "Import saved MIDI artifact", actions: [{
        type: "create_midi_clip_from_artifact", artifactRef: input.artifactRef,
        trackName: input.trackName, startBeat: input.startBeat,
        ...(input.name === undefined ? {} : { name: input.name }),
      }] }),
    });
    const guard = await preflightAgentPlan(input.context, input.interaction, plan, input.signal,
      undefined, undefined, { refresh, assert: (candidate, bindings) => {
        assertEditScopesAllow(requiredEditScopesForPlan(input.context, candidate, bindings), currentScopes());
      } });
    await record("apply_requested", summarizeActionPlan(plan));
    throwIfAborted(input.signal);
    const decision = await input.confirm(plan, guard);
    throwIfAborted(input.signal);
    if (!decision.confirmed) {
      await record("apply_result", "User cancelled the proposed Live actions.\nNo MIDI was imported.");
      return false;
    }
    if (decision.source === "automatic") await record("apply_auto_approved", `MIDI import approved by ${decision.mode}.`);
    const outcome = await input.mutationQueue.run(input.signal, async () => {
      const bindings = await guard();
      return executeAgentPlanWithProgress(input.context, importPlan, input.interaction.target, input.signal, bindings,
        (index, action) => {
          assertEditScopesAllow(requiredEditScopesForAction(input.context, action, index, bindings), currentScopes());
          mutationStarted = true;
        });
    });
    completedActionCount = plan.actions.length;
    completedActionKeys = guard.actionKeys ?? [];
    try {
      await record("apply_result", ["Applied:", ...outcome.results.map((result) => `- ${result}`)].join("\n"));
    } catch (cause) {
      throw new ChatBridgeCommandOutcomeUnknownError("MIDI import completed, but its history could not be saved. Inspect Live before trying again.", { cause });
    }
    return true;
  } catch (error) {
    const message = error instanceof AgentPlanExecutionError
      ? `MIDI import did not complete reliably. Inspect Live before trying again. ${error.completedResults.join("; ")}`
      : error instanceof Error ? error.message : "MIDI import failed.";
    if (mutationStarted && plan) {
      if (error instanceof AgentPlanExecutionError) {
        completedActionKeys = error.completedActionKeys;
        completedActionCount = error.completedActionCount;
      }
      const identities = [
        ...plan.actions.slice(0, completedActionCount).map((action) => JSON.stringify(action)),
        ...completedActionKeys.flat(),
      ];
      await appendSessionEvent(input.storageDirectory, input.sessionId, {
        kind: "apply_result", content: [
          completedActionCount > 0 || error instanceof AgentPlanExecutionError && error.completedResults.length > 0
            ? `Live action plan partially completed after ${error instanceof AgentPlanExecutionError ? error.completedResults.length : completedActionCount} operation(s).`
            : "Live action plan could not complete its first operation.",
          message,
        ].join("\n"),
        recovery: { active: true, completedActionDigests: [...new Set(identities.map(digestActionIdentity))].sort() },
      }).catch(() => undefined);
      throw new ChatBridgeCommandOutcomeUnknownError(message, { cause: error });
    }
    await record("error", message).catch(() => undefined);
    throw error;
  } finally {
    unsubscribe();
    invalidate();
  }
}
