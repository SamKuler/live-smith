import { uiMessage, UiMessageError } from "../../i18n/ui-message.js";
import { summarizeActionPlan, validateAgentPlan, type AgentPlan } from "../../agent/actions.js";
import { assertEditScopesAllow, resolveEditScopes, type EditScope } from "../../agent/edit-scopes.js";
import { parameterApplicationIsOpen, parameterApplicationLeaves, sameParameterTarget, sameParameterLayout, sameParameterNumber, type DeviceParameterApplication, type DeviceParameterTarget, type DeviceParameterValue, type DeviceParameterWrite } from "../../agent/device-parameter-contracts.js";
import type { AgentConfirmationDecision } from "../../agent/loop.js";
import { requiredEditScopesForAction, requiredEditScopesForPlan } from "../../live/action-permissions.js";
import { captureParameterDevice, resolveParameterDevice } from "../../live/device-parameters.js";
import type { LiveInteractionContext } from "../../live/context.js";
import { executeAgentPlanWithProgress } from "../../live/executor.js";
import { throwIfAborted } from "../../runtime/host.js";
import { cloneJsonValue } from "../../model/json-clone.js";
import { listDeviceParameterApplications, readDeviceParameterArtifact, saveDeviceParameterArtifact, saveDeviceParameterApplication, saveDeviceParameterProgress } from "../../storage/device-parameter-artifacts.js";
import { appendSessionEvent, loadSessionEvents } from "../../storage/events.js";
import { createStorageId } from "../../storage/id.js";
import { listSessions } from "../../storage/sessions.js";
import { preflightAgentPlan } from "../agent-request.js";
import { ChatBridgeCommandOutcomeUnknownError } from "../chat/chat-bridge.js";
import type { LiveMutationQueue } from "../live-mutation-queue.js";
import { subscribeSessionEditScopesChanges, subscribeSessionEditScopesInvalidations } from "../session/session-edit-scope-events.js";
import type { ParameterArtifactCommand } from "./contracts.js";
import { assertSnapshotMatchesDestination, assertParameterAuditionCurrent, assertParameterRestorationCurrent, parameterApplicationForArtifact, parameterAuditionDestination, requireParameterSession, restorableParameterEntries, type ParameterArtifactContext } from "./parameter-artifacts.js";

type ApplicationCommand = Exclude<ParameterArtifactCommand, { kind: "capture_device_parameters" }>;
interface Dependencies extends ParameterArtifactContext {
  interaction: LiveInteractionContext;
  mutationQueue: LiveMutationQueue;
  confirm(plan: AgentPlan, guard: Awaited<ReturnType<typeof preflightAgentPlan>>, operationId: string): Promise<AgentConfirmationDecision>;
}

/** A chat choice confirms only a version or Original from its saved presentation. */
async function assertPresentedChoice(input: ParameterArtifactContext, presentationId: string, artifactId: string, restorationTarget?: DeviceParameterTarget): Promise<void> {
  const event = (await loadSessionEvents(input.storageDirectory, input.sessionId)).find(entry => entry.id === presentationId);
  if (event?.kind !== "tool_result" || event.name !== "present_device_parameter_candidates" || event.outcome !== "success" ||
      !event.artifacts?.length || event.artifacts.some(ref => ref.kind !== "device-parameters")) {
    throw new UiMessageError(uiMessage("This sound choice is unavailable. Open a saved sound presentation."));
  }
  if (!restorationTarget && !event.artifacts.some(ref => ref.id === artifactId)) {
    throw new UiMessageError(uiMessage("This version is not included in the sound choices."));
  }
  if (restorationTarget) {
    const [presented, applied] = await Promise.all([
      readDeviceParameterArtifact(input.storageDirectory, input.sessionId, event.artifacts[0]!.id),
      readDeviceParameterArtifact(input.storageDirectory, input.sessionId, artifactId),
    ]);
    if ((!sameParameterTarget(presented.target, applied.target) && !sameParameterTarget(presented.target, restorationTarget)) ||
        !sameParameterLayout(presented.parameters, applied.parameters)) {
      throw new UiMessageError(uiMessage("These sound choices belong to another device."));
    }
  }
  throwIfAborted(input.signal);
}

/** The caller holds the Session send fence. Human listening never holds the Live queue. */
export async function runParameterApplication(input: Dependencies & ApplicationCommand): Promise<"applied" | "restored" | "kept" | "cancelled" | "unchanged"> {
  await requireParameterSession(input);
  const history = await listDeviceParameterApplications(input.storageDirectory, input.sessionId);
  const applications = parameterApplicationLeaves(history);
  const open = applications.findLast(parameterApplicationIsOpen);
  let application: DeviceParameterApplication;
  let values: DeviceParameterWrite[];
  let expectedParameters: DeviceParameterValue[];
  const restoring = input.kind === "restore_device_parameters";
  const presentationId = input.kind === "apply_device_parameters" || restoring ? input.presentationId : undefined;
  let restoresKeptApplication = false;
  if (input.kind === "apply_device_parameters") {
    const artifact = await readDeviceParameterArtifact(input.storageDirectory, input.sessionId, input.artifactId);
    if (presentationId) await assertPresentedChoice(input, presentationId, artifact.id);
    const target = await parameterAuditionDestination(input, artifact, parameterApplicationForArtifact(history, artifact));
    const snapshot = await captureParameterDevice(input.context, target, input.signal);
    assertSnapshotMatchesDestination(artifact, snapshot, input.target !== undefined || !sameParameterTarget(target, artifact.target));
    if (open) {
      if (!sameParameterTarget(open.target, snapshot.target)) throw new UiMessageError(uiMessage("Finish the current device audition before choosing another device."));
      assertParameterAuditionCurrent(open, snapshot);
      if (open.artifactId === artifact.id) return "unchanged";
    }
    expectedParameters = snapshot.parameters;
    const entries = artifact.parameters.map((parameter, index) => {
      const current = snapshot.parameters[index]!;
      const original = open?.entries[index]!.parameter ?? current;
      return { parameter: original, requested: parameter.value,
        ...(sameParameterNumber(current.value, original.value) ? { state: "pending" as const } : { state: "applied" as const, after: current.value }) };
    });
    application = { id: createStorageId("parameter_apply"), sessionId: input.sessionId, artifactId: artifact.id,
      artifactLabel: artifact.label, artifactVersion: artifact.version.number,
      createdAt: new Date().toISOString(), target: snapshot.target, status: "applying", entries,
      ...(open ? { previousApplicationId: open.id, ...(open.baselineArtifactId ? { baselineArtifactId: open.baselineArtifactId } : {}) } : {}) };
    values = entries.filter((entry) => !sameParameterNumber(expectedParameters[entry.parameter.index]!.value, entry.requested)).map((entry) => ({ parameterIndex: entry.parameter.index, parameterName: entry.parameter.name, value: entry.requested }));
    if (!values.length) {
      // The executor observes and validates equal values without performing SDK writes.
      values = entries.map((entry) => ({ parameterIndex: entry.parameter.index, parameterName: entry.parameter.name, value: entry.requested }));
    }
  } else {
    const saved = applications.find((entry) => entry.id === input.applicationId);
    if (!saved) throw new UiMessageError(uiMessage("That parameter application is no longer pending."));
    application = saved;
    if (input.kind === "keep_device_parameters") {
      if (!parameterApplicationIsOpen(saved) || open?.id !== saved.id) throw new UiMessageError(uiMessage("That parameter application is no longer pending."));
      application.status = "kept";
      await saveDeviceParameterApplication(input.storageDirectory, application);
      return "kept";
    }
    assertParameterRestorationCurrent(history, saved);
    if (presentationId) await assertPresentedChoice(input, presentationId, application.artifactId, application.target);
    const restorable = await restorableParameterEntries(input, application);
    expectedParameters = restorable.snapshot.parameters;
    restoresKeptApplication = saved.status === "kept";
    if (restoresKeptApplication) {
      application = { ...cloneJsonValue(saved), id: createStorageId("parameter_apply"), previousApplicationId: saved.id,
        createdAt: new Date().toISOString(), status: "restoring", restorationBaseline: restorable.snapshot.parameters };
    }
    application.restorationBaseline ??= restorable.snapshot.parameters;
    values = restorable.entries.map((entry) => ({ parameterIndex: entry.parameter.index, parameterName: entry.parameter.name, value: entry.parameter.value }));
    if (!values.length) {
      if (!restoresKeptApplication) { application.status = "restored"; await saveDeviceParameterApplication(input.storageDirectory, application); return "restored"; }
      values = application.entries.map((entry) => ({ parameterIndex: entry.parameter.index, parameterName: entry.parameter.name, value: entry.parameter.value }));
    }
  }
  const bound = resolveParameterDevice(input.context, application.target);
  const interaction = { ...input.interaction, target: { track: bound.track, object: bound.resolved.device } };
  const plan = validateAgentPlan({ message: `${restoring ? "Restore values from before applying" : "Apply"} "${application.artifactLabel}" v${application.artifactVersion}`,
    actions: [{ type: "set_device_parameters",
      deviceName: bound.resolved.device.name, devicePath: bound.resolved.path, values }] });
  const operationId = createStorageId("apply");
  let scopes: EditScope[] = [];
  let scopeGeneration = 0;
  let started = false;
  const unsubscribe = subscribeSessionEditScopesChanges(input.storageDirectory, (change) => {
    if (change.sessionId === input.sessionId) { scopeGeneration += 1; scopes = resolveEditScopes(change.editScopes); }
  });
  const invalidate = subscribeSessionEditScopesInvalidations(input.storageDirectory, (sessionId) => {
    if (sessionId === input.sessionId) { scopeGeneration += 1; scopes = []; }
  });
  const persist = () => saveDeviceParameterApplication(input.storageDirectory, application);
  const persistEntry = (entry: DeviceParameterApplication["entries"][number]) => saveDeviceParameterProgress(input.storageDirectory, input.sessionId, application.id,
    { index: entry.parameter.index, state: entry.state, ...(entry.after === undefined ? {} : { after: entry.after }) });
  const entryAt = (index: number) => application.entries.find((entry) => entry.parameter.index === values[index]!.parameterIndex)!;
  try {
    const guard = await preflightAgentPlan(input.context, interaction, plan, input.signal, undefined, undefined, {
      refresh: async () => {
        await requireParameterSession(input);
        const generation = scopeGeneration;
        const session = (await listSessions(input.storageDirectory, input.projectKey)).find((entry) => entry.id === input.sessionId && !entry.archivedAt);
        if (!session) throw new UiMessageError(uiMessage("The Session is no longer available."));
        if (generation === scopeGeneration) scopes = resolveEditScopes(session.editScopes);
      },
      assert: (candidate, bindings) => {
        input.assertLiveSetCurrent(); resolveParameterDevice(input.context, application.target);
        if (bindings.actionObjects.get(0)?.deviceTarget?.device !== bound.resolved.device) throw new UiMessageError(uiMessage("The parameter destination changed."));
        assertEditScopesAllow(requiredEditScopesForPlan(input.context, candidate, bindings), scopes);
        const parameters = bindings.actionObjects.get(0)?.parameterValues;
        if (!parameters || !sameParameterLayout(expectedParameters, parameters) || expectedParameters.some((parameter, index) =>
          parameter.handleId !== parameters[index]!.handleId || !sameParameterNumber(parameter.value, parameters[index]!.value))) {
          throw new UiMessageError(uiMessage("The device values changed while preparing the application. Refresh the comparison."));
        }
      },
    });
    await appendSessionEvent(input.storageDirectory, input.sessionId, { kind: "apply_requested", content: summarizeActionPlan(plan),
      applyOperation: { id: operationId, status: "proposed", plan, ...(guard.previews ? { previews: guard.previews } : {}) } });
    const decision: AgentConfirmationDecision = presentationId ? { confirmed: true, source: "user" } : await input.confirm(plan, guard, operationId);
    throwIfAborted(input.signal);
    if (!decision.confirmed) {
      await appendSessionEvent(input.storageDirectory, input.sessionId, { kind: "apply_result", content: "Device parameter application cancelled.", applyOperation: { id: operationId, status: "cancelled" } });
      return "cancelled";
    }
    if (decision.source === "automatic") await appendSessionEvent(input.storageDirectory, input.sessionId, { kind: "apply_auto_approved", content: `Device parameter application approved by ${decision.mode}.`, applyOperation: { id: operationId, status: "approved" } });
    await input.mutationQueue.run(input.signal, async () => {
      const bindings = await guard();
      if (restoring) {
        const restorable = await restorableParameterEntries(input, application);
        application.restorationBaseline ??= restorable.snapshot.parameters;
      }
      if ((!restoring || restoresKeptApplication) && !application.baselineArtifactId) {
        const baseline = await saveDeviceParameterArtifact(input.storageDirectory, input.sessionId, {
          target: application.target, parameters: application.entries.map((entry) => entry.parameter),
          label: `Before audition · ${application.artifactLabel}`.slice(0, 120), source: { kind: "captured" }, signal: input.signal,
        });
        application.baselineArtifactId = baseline.id;
      }
      application.status = restoring ? "restoring" : "applying";
      await persist(); started = true;
      await executeAgentPlanWithProgress(input.context, plan, interaction.target, input.signal, bindings, (index, action) => {
        input.assertLiveSetCurrent(); resolveParameterDevice(input.context, application.target);
        assertEditScopesAllow(requiredEditScopesForAction(input.context, action, index, bindings), scopes);
      }, {
        ...(presentationId ? { withinTransaction: input.context.withinTransaction.bind(input.context) } : {}),
        beforeWrite: async (index, current) => {
          const entry = entryAt(index);
          if (current.handleId !== entry.parameter.handleId || !sameParameterNumber(current.value, expectedParameters[entry.parameter.index]!.value)) {
            throw new UiMessageError(uiMessage('Parameter "{name}" changed before its write.', { name: current.name }));
          }
          entry.state = restoring ? "restoring" : "applying";
          if (!restoring) delete entry.after;
          await persistEntry(entry);
        },
        afterWrite: async (index, actual) => {
          const entry = entryAt(index);
          if (restoring) {
            if (!sameParameterNumber(actual, entry.parameter.value)) throw new UiMessageError(uiMessage('Parameter "{name}" did not return to its original value.', { name: entry.parameter.name }));
            entry.state = "restored";
          } else { entry.after = actual; entry.state = "applied"; }
          await persistEntry(entry);
        },
        writeNotStarted: async (index) => {
          const entry = entryAt(index);
          const before = expectedParameters[entry.parameter.index]!.value;
          if (restoring || !sameParameterNumber(before, entry.parameter.value)) { entry.state = "applied"; entry.after = before; }
          else { entry.state = "pending"; delete entry.after; }
          await persistEntry(entry);
        },
      });
      if (!await reconcileApplication(input, application, restoring)) throw new UiMessageError(uiMessage("Device parameters changed during application. Review the current values before restoring."));
      application.status = restoring ? "restored" : "applied";
      await persist();
    });
    await appendSessionEvent(input.storageDirectory, input.sessionId, { kind: "apply_result",
      content: restoring ? "Restored the verified previous device parameter values." : "Applied the saved device parameter version. Actual values were read back; Keep or Restore is available in Artifacts.",
      applyOperation: { id: operationId, status: "applied" } });
    return restoring ? "restored" : "applied";
  } catch (error) {
    if (started && application.status !== "restored" && application.status !== "applied") {
      await reconcileApplication(input, application, restoring).catch(() => undefined);
      application.status = "partial";
      await persist().catch(() => undefined);
    }
    await appendSessionEvent(input.storageDirectory, input.sessionId, { kind: "apply_result",
      content: error instanceof Error ? error.message : "Device parameter application failed.",
      applyOperation: { id: operationId, status: started && (application.status === "applied" || application.status === "restored") ? "applied" : started ? "partial" : input.signal.aborted ? "cancelled" : "failed" } }).catch(() => undefined);
    if (started) throw new ChatBridgeCommandOutcomeUnknownError(uiMessage("Device parameter application did not finish reliably. Refresh Artifacts and review the saved application before trying again."), { cause: error });
    throw error;
  } finally { unsubscribe(); invalidate(); }
}

/** Changes outside confirmed writes can be device side effects or concurrent edits. */
async function reconcileApplication(input: ParameterArtifactContext, application: DeviceParameterApplication, restoring: boolean): Promise<boolean> {
  const observed = await captureParameterDevice(input.context, application.target);
  input.assertLiveSetCurrent();
  if (!(await listSessions(input.storageDirectory, input.projectKey)).some((session) => session.id === input.sessionId && !session.archivedAt)) throw new UiMessageError(uiMessage("The Session changed while reading parameter results."));
  input.assertLiveSetCurrent(); resolveParameterDevice(input.context, application.target);
  let matches = observed.parameters.length === application.entries.length;
  for (const entry of application.entries) {
    const actual = observed.parameters[entry.parameter.index];
    const expected = entry.state === "applied" ? entry.after : entry.state === "restored" ? entry.parameter.value
      : restoring ? application.restorationBaseline?.[entry.parameter.index]?.value : entry.parameter.value;
    if (entry.state === "applying" || entry.state === "restoring" || entry.state === "conflict") { matches = false; continue; }
    const sameIdentity = actual?.handleId === entry.parameter.handleId;
    if (!actual || !sameIdentity || !sameParameterLayout([entry.parameter], [actual]) || expected === undefined || !sameParameterNumber(actual.value, expected)) {
      entry.state = "conflict";
      if (actual && sameIdentity) entry.after = actual.value; else delete entry.after;
      matches = false;
    }
  }
  return matches;
}
