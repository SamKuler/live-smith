import type { ExtensionContext } from "@ableton-extensions/sdk";
import { uiMessage, UiMessageError } from "../../i18n/ui-message.js";
import { sameParameterLayout, sameParameterNumber, sameParameterTarget, parameterApplicationIsOpen, parameterApplicationLeaves, type DeviceParameterArtifact, type DeviceParameterApplication } from "../../agent/device-parameter-contracts.js";
import { captureParameterDevice, parameterDeviceTargets, resolveParameterDevice } from "../../live/device-parameters.js";
import { throwIfAborted } from "../../runtime/host.js";
import { listDeviceParameterApplications, readDeviceParameterArtifact, saveDeviceParameterArtifact } from "../../storage/device-parameter-artifacts.js";
import { appendSessionEvent } from "../../storage/events.js";
import { listSessions } from "../../storage/sessions.js";
import type { ParameterArtifactCommand, ParameterArtifactPreview, ParameterArtifactRead } from "./contracts.js";

export interface ParameterArtifactContext {
  context: ExtensionContext<"1.0.0">;
  storageDirectory: string;
  sessionId: string;
  projectKey: string;
  signal: AbortSignal;
  assertLiveSetCurrent(): void;
}

export async function requireParameterSession(input: ParameterArtifactContext): Promise<void> {
  input.assertLiveSetCurrent(); throwIfAborted(input.signal);
  if (!(await listSessions(input.storageDirectory, input.projectKey)).some((entry) => entry.id === input.sessionId && !entry.archivedAt)) throw new UiMessageError(uiMessage("That Session is not available in this Live Set."));
  input.assertLiveSetCurrent(); throwIfAborted(input.signal);
}

export async function readParameterArtifactPreview(input: ParameterArtifactContext & ParameterArtifactRead): Promise<ParameterArtifactPreview> {
  await requireParameterSession(input);
  const devices = parameterDeviceTargets(input.context).map((entry) => entry.target);
  const result: ParameterArtifactPreview = { sessionId: input.sessionId, devices };
  const history = await listDeviceParameterApplications(input.storageDirectory, input.sessionId);
  const applications = parameterApplicationLeaves(history);
  const open = applications.findLast(parameterApplicationIsOpen);
  let application = open;
  if (application) result.application = application;
  if (input.artifactId) {
    const artifact = result.artifact = await readDeviceParameterArtifact(input.storageDirectory, input.sessionId, input.artifactId);
    application = undefined;
    delete result.application;
    const baseId = input.baseArtifactId;
    if (baseId) {
      const base = await readDeviceParameterArtifact(input.storageDirectory, input.sessionId, baseId);
      if (base.version.groupId !== artifact.version.groupId || !sameParameterLayout(base.parameters, artifact.parameters)) throw new UiMessageError(uiMessage("Choose a parameter comparison version from the same work."));
      result.comparison = base;
    }
    try {
      const target = await parameterAuditionDestination(input, artifact, parameterApplicationForArtifact(history, artifact));
      application = applications.findLast((entry) => sameParameterTarget(entry.target, target));
      if (application) result.application = application;
      result.current = await captureParameterDevice(input.context, target, input.signal);
      assertSnapshotMatchesDestination(artifact, result.current, input.target !== undefined || !sameParameterTarget(target, artifact.target));
      if (open) {
        try {
          if (!sameParameterTarget(open.target, result.current.target)) throw new UiMessageError(uiMessage("Finish the current device audition before choosing another device."));
          assertParameterAuditionCurrent(open, result.current);
        } catch (error) { result.switchError = error instanceof UiMessageError ? error.displayMessage : uiMessage("Refresh device parameters before switching versions."); }
      }
    } catch (error) {
      throwIfAborted(input.signal);
      delete result.current;
      result.bindingError = error instanceof UiMessageError ? error.displayMessage : error instanceof Error ? error.message : uiMessage("The parameter destination is unavailable. Refresh the device list.");
    }
  }
  if (application && application.status !== "restored") {
    try { assertParameterRestorationCurrent(history, application); await restorableParameterEntries(input, application); }
    catch (error) { throwIfAborted(input.signal); result.restoreError = error instanceof UiMessageError ? error.displayMessage : error instanceof Error ? error.message : uiMessage("The previous parameter values cannot be read. Refresh before restoring."); }
  }
  await requireParameterSession(input);
  return result;
}

export function assertParameterRestorationCurrent(history: readonly DeviceParameterApplication[], application: DeviceParameterApplication): void {
  const leaves = parameterApplicationLeaves(history);
  const current = leaves.findLast(parameterApplicationIsOpen) ?? leaves.findLast((entry) => sameParameterTarget(entry.target, application.target));
  if (application.status === "restored" || current?.id !== application.id) throw new UiMessageError(uiMessage("That parameter application is no longer pending."));
}

/** Preview and execution resolve the same saved audition and explicit device binding. */
export function parameterApplicationForArtifact(history: readonly DeviceParameterApplication[], artifact: DeviceParameterArtifact): DeviceParameterApplication | undefined {
  const leaves = parameterApplicationLeaves(history);
  return leaves.findLast(parameterApplicationIsOpen) ?? leaves.findLast((entry) => {
    if (entry.baselineArtifactId === artifact.id || sameParameterTarget(entry.target, artifact.target)) return true;
    let ancestor: DeviceParameterApplication | undefined = entry;
    for (let depth = 0; ancestor && depth < history.length; depth++) {
      if (ancestor.artifactId === artifact.id) return true;
      const previousId: string | undefined = ancestor.previousApplicationId;
      ancestor = history.find((previous) => previous.id === previousId);
    }
    return false;
  });
}

/** Candidates captured from the same source follow the audition's explicit destination binding. */
export async function parameterAuditionDestination(input: ParameterArtifactContext & ParameterArtifactRead, artifact: DeviceParameterArtifact, application?: DeviceParameterApplication) {
  if (input.target) return { ...artifact.target, ...input.target };
  if (application) {
    const applied = await readDeviceParameterArtifact(input.storageDirectory, input.sessionId, application.artifactId);
    if (sameParameterTarget(applied.target, artifact.target)) return application.target;
  }
  return artifact.target;
}

export function assertParameterAuditionCurrent(application: DeviceParameterApplication, snapshot: Awaited<ReturnType<typeof captureParameterDevice>>): void {
  if (application.status !== "applied" || application.restorationBaseline) throw new UiMessageError(uiMessage("Keep or restore the previous parameter application before applying another version."));
  if (!sameParameterTarget(application.target, snapshot.target) || !sameParameterLayout(application.entries.map((entry) => entry.parameter), snapshot.parameters)) {
    throw new UiMessageError(uiMessage("The device parameter layout changed after application. Restore is unavailable."));
  }
  for (const entry of application.entries) {
    const current = snapshot.parameters[entry.parameter.index];
    const expected = entry.state === "applied" ? entry.after : entry.state === "pending" ? entry.parameter.value : undefined;
    if (!current || current.handleId !== entry.parameter.handleId || expected === undefined || !sameParameterNumber(current.value, expected)) {
      throw new UiMessageError(uiMessage('Parameter "{name}" changed after application. Restore was stopped to preserve the current edits.', { name: entry.parameter.name }));
    }
  }
}

export function assertSnapshotMatchesDestination(artifact: DeviceParameterArtifact, current: Pick<DeviceParameterArtifact, "target" | "parameters">, rebound: boolean): void {
  if (!sameParameterLayout(artifact.parameters, current.parameters)) throw new UiMessageError(uiMessage("The selected device has a different parameter layout. Capture it as a new snapshot."));
  if (!rebound && artifact.parameters.some((parameter, index) => parameter.handleId !== current.parameters[index]!.handleId)) {
    throw new UiMessageError(uiMessage("The original device parameters were replaced. Choose the destination device explicitly before applying."));
  }
}

export async function captureParameterArtifact(input: ParameterArtifactContext & Extract<ParameterArtifactCommand, { kind: "capture_device_parameters" }>): Promise<DeviceParameterArtifact> {
  await requireParameterSession(input);
  const snapshot = await captureParameterDevice(input.context, input.target, input.signal);
  await requireParameterSession(input);
  const artifact = await saveDeviceParameterArtifact(input.storageDirectory, input.sessionId, { ...snapshot, label: input.label, source: { kind: "captured" }, signal: input.signal });
  await appendSessionEvent(input.storageDirectory, input.sessionId, { kind: "tool_result", name: "capture_device_parameter_artifact",
    content: JSON.stringify({ artifacts: [parameterArtifactView(artifact)] }), artifacts: [{ kind: "device-parameters", id: artifact.id }] });
  return artifact;
}

export function parameterArtifactView(artifact: DeviceParameterArtifact) {
  return { kind: "device-parameters" as const, artifactRef: artifact.id, label: artifact.label, createdAt: artifact.createdAt,
    version: artifact.version, source: artifact.source.kind, deviceName: artifact.target.deviceName,
    trackName: artifact.target.trackName, parameterCount: artifact.parameters.length };
}

export async function restorableParameterEntries(input: ParameterArtifactContext, application: DeviceParameterApplication) {
  resolveParameterDevice(input.context, application.target);
  const snapshot = await captureParameterDevice(input.context, application.target, input.signal);
  if (!sameParameterLayout(application.entries.map((entry) => entry.parameter), snapshot.parameters) ||
      application.entries.some((entry) => entry.parameter.handleId !== snapshot.parameters[entry.parameter.index]?.handleId)) throw new UiMessageError(uiMessage("The device parameter layout changed after application. Restore is unavailable."));
  for (const entry of application.entries) {
    if (entry.state === "pending" || entry.state === "restored") {
      const expected = entry.state === "restored" ? entry.parameter.value
        : application.restorationBaseline?.[entry.parameter.index]?.value ?? entry.parameter.value;
      if (!sameParameterNumber(snapshot.parameters[entry.parameter.index]!.value, expected)) {
        throw new UiMessageError(uiMessage('Parameter "{name}" changed during an unfinished application or restore. Inspect Live before continuing.', { name: entry.parameter.name }));
      }
      continue;
    }
    if (entry.state === "conflict") throw new UiMessageError(uiMessage("Device parameters changed outside confirmed writes. Inspect Live and keep the current state before applying another version."));
    if (entry.state !== "applied" || entry.after === undefined) throw new UiMessageError(uiMessage("A parameter write has an unknown outcome. Inspect Live, then keep the current state before applying another version."));
    const current = snapshot.parameters[entry.parameter.index];
    if (!current || current.handleId !== entry.parameter.handleId || !sameParameterLayout([entry.parameter], [current]) || !sameParameterNumber(current.value, entry.after)) {
      throw new UiMessageError(uiMessage('Parameter "{name}" changed after application. Restore was stopped to preserve the current edits.', { name: entry.parameter.name }));
    }
  }
  return { snapshot, entries: application.entries.filter((entry) => entry.state === "applied" && !sameParameterNumber(entry.parameter.value, entry.after!)) };
}
