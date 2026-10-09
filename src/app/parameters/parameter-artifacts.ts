import type { ExtensionContext } from "@ableton-extensions/sdk";
import { uiMessage, UiMessageError } from "../../i18n/ui-message.js";
import { sameParameterLayout, sameParameterNumber, parameterApplicationIsOpen, type DeviceParameterArtifact, type DeviceParameterApplication } from "../../agent/device-parameter-contracts.js";
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
  const applications = await listDeviceParameterApplications(input.storageDirectory, input.sessionId);
  const application = applications.findLast(parameterApplicationIsOpen) ?? applications.findLast((entry) => entry.artifactId === input.artifactId);
  if (application) result.application = application;
  if (input.artifactId) {
    const artifact = result.artifact = await readDeviceParameterArtifact(input.storageDirectory, input.sessionId, input.artifactId);
    const baseId = input.baseArtifactId;
    if (baseId) {
      const base = await readDeviceParameterArtifact(input.storageDirectory, input.sessionId, baseId);
      if (base.version.groupId !== artifact.version.groupId || !sameParameterLayout(base.parameters, artifact.parameters)) throw new UiMessageError(uiMessage("Choose a parameter comparison version from the same work."));
      result.comparison = base;
    }
    try {
      result.current = await captureParameterDevice(input.context, input.target ?? artifact.target, input.signal);
      assertSnapshotMatchesDestination(artifact, result.current, input.target !== undefined);
    } catch (error) {
      throwIfAborted(input.signal);
      delete result.current;
      result.bindingError = error instanceof UiMessageError ? error.displayMessage : error instanceof Error ? error.message : uiMessage("The parameter destination is unavailable. Refresh the device list.");
    }
  }
  if (application && parameterApplicationIsOpen(application)) {
    try { await restorableParameterEntries(input, application); }
    catch (error) { throwIfAborted(input.signal); result.restoreError = error instanceof UiMessageError ? error.displayMessage : error instanceof Error ? error.message : uiMessage("The previous parameter values cannot be read. Refresh before restoring."); }
  }
  await requireParameterSession(input);
  return result;
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
      if ((application.status !== "applied" || entry.state === "restored") &&
          !sameParameterNumber(snapshot.parameters[entry.parameter.index]!.value, expected)) {
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
