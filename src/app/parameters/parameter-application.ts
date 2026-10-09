import { uiMessage, UiMessageError } from "../../i18n/ui-message.js";
import { summarizeActionPlan, validateAgentPlan, type AgentPlan } from "../../agent/actions.js";
import { assertEditScopesAllow, resolveEditScopes, type EditScope } from "../../agent/edit-scopes.js";
import { parameterApplicationIsOpen, sameParameterLayout, sameParameterNumber, type DeviceParameterApplication, type DeviceParameterValue, type DeviceParameterWrite } from "../../agent/device-parameter-contracts.js";
import type { AgentConfirmationDecision } from "../../agent/loop.js";
import { requiredEditScopesForAction, requiredEditScopesForPlan } from "../../live/action-permissions.js";
import { captureParameterDevice, resolveParameterDevice } from "../../live/device-parameters.js";
import type { LiveInteractionContext } from "../../live/context.js";
import { executeAgentPlanWithProgress } from "../../live/executor.js";
import { throwIfAborted } from "../../runtime/host.js";
import { listDeviceParameterApplications, readDeviceParameterArtifact, saveDeviceParameterApplication, saveDeviceParameterProgress } from "../../storage/device-parameter-artifacts.js";
import { appendSessionEvent } from "../../storage/events.js";
import { createStorageId } from "../../storage/id.js";
import { listSessions } from "../../storage/sessions.js";
import { preflightAgentPlan } from "../agent-request.js";
import { ChatBridgeCommandOutcomeUnknownError } from "../chat/chat-bridge.js";
import type { LiveMutationQueue } from "../live-mutation-queue.js";
import { subscribeSessionEditScopesChanges, subscribeSessionEditScopesInvalidations } from "../session/session-edit-scope-events.js";
import type { ParameterArtifactCommand } from "./contracts.js";
import { assertSnapshotMatchesDestination, requireParameterSession, restorableParameterEntries, type ParameterArtifactContext } from "./parameter-artifacts.js";

type ApplicationCommand = Exclude<ParameterArtifactCommand, { kind: "capture_device_parameters" }>;
interface Dependencies extends ParameterArtifactContext {
  interaction: LiveInteractionContext;
  mutationQueue: LiveMutationQueue;
  confirm(plan: AgentPlan, guard: Awaited<ReturnType<typeof preflightAgentPlan>>, operationId: string): Promise<AgentConfirmationDecision>;
}

/** The caller holds the Session send fence. Human listening never holds the Live queue. */
export async function runParameterApplication(input: Dependencies & ApplicationCommand): Promise<"applied" | "restored" | "kept" | "cancelled" | "unchanged"> {
  await requireParameterSession(input);
  const applications = await listDeviceParameterApplications(input.storageDirectory, input.sessionId);
  const open = applications.findLast(parameterApplicationIsOpen);
  let application: DeviceParameterApplication;
  let values: DeviceParameterWrite[];
  let expectedParameters: DeviceParameterValue[];
  const restoring = input.kind === "restore_device_parameters";
  if (input.kind === "apply_device_parameters") {
    if (open) throw new UiMessageError(uiMessage("Keep or restore the previous parameter application before applying another version."));
    const artifact = await readDeviceParameterArtifact(input.storageDirectory, input.sessionId, input.artifactId);
    const snapshot = await captureParameterDevice(input.context, input.target ?? artifact.target, input.signal);
    assertSnapshotMatchesDestination(artifact, snapshot, input.target !== undefined);
    expectedParameters = snapshot.parameters;
    const entries = artifact.parameters.map((parameter, index) => {
      const current = snapshot.parameters[index]!;
      return { parameter: current, requested: parameter.value, state: "pending" as const };
    });
    application = { id: createStorageId("parameter_apply"), sessionId: input.sessionId, artifactId: artifact.id,
      artifactLabel: artifact.label, artifactVersion: artifact.version.number,
      createdAt: new Date().toISOString(), target: snapshot.target, status: "applying", entries };
    values = entries.filter((entry) => !sameParameterNumber(entry.parameter.value, entry.requested)).map((entry) => ({ parameterIndex: entry.parameter.index, parameterName: entry.parameter.name, value: entry.requested }));
    if (!values.length) return "unchanged";
  } else {
    const saved = applications.find((entry) => entry.id === input.applicationId);
    if (!saved || !parameterApplicationIsOpen(saved) || open?.id !== saved.id) throw new UiMessageError(uiMessage("That parameter application is no longer pending."));
    application = saved;
    if (input.kind === "keep_device_parameters") {
      application.status = "kept";
      await saveDeviceParameterApplication(input.storageDirectory, application);
      return "kept";
    }
    const restorable = await restorableParameterEntries(input, application);
    expectedParameters = restorable.snapshot.parameters;
    application.restorationBaseline ??= restorable.snapshot.parameters;
    values = restorable.entries.map((entry) => ({ parameterIndex: entry.parameter.index, parameterName: entry.parameter.name, value: entry.parameter.value }));
    if (!values.length) { application.status = "restored"; await saveDeviceParameterApplication(input.storageDirectory, application); return "restored"; }
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
      applyOperation: { id: operationId, status: "proposed", ...(guard.previews ? { previews: guard.previews } : {}) } });
    const decision = await input.confirm(plan, guard, operationId);
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
      application.status = restoring ? "restoring" : "applying";
      await persist(); started = true;
      await executeAgentPlanWithProgress(input.context, plan, interaction.target, input.signal, bindings, (index, action) => {
        input.assertLiveSetCurrent(); resolveParameterDevice(input.context, application.target);
        assertEditScopesAllow(requiredEditScopesForAction(input.context, action, index, bindings), scopes);
      }, {
        beforeWrite: async (index, current) => {
          const entry = entryAt(index);
          if (current.handleId !== entry.parameter.handleId || !sameParameterNumber(current.value, restoring ? entry.after! : entry.parameter.value)) {
            throw new UiMessageError(uiMessage('Parameter "{name}" changed before its write.', { name: current.name }));
          }
          entry.state = restoring ? "restoring" : "applying";
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
          entry.state = restoring ? "applied" : "pending";
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
