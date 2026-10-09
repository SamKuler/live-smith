import { isDeviceParameterApplication, isDeviceParameterArtifact, isDeviceParameterSnapshot, isDeviceParameterTarget,
  type DeviceParameterApplication, type DeviceParameterArtifact, type DeviceParameterSnapshot, type DeviceParameterTarget } from "../../agent/device-parameter-contracts.js";
import type { DeviceParameterDestination } from "../../live/device-parameters.js";
import { isUiMessage, type UiMessage } from "../../i18n/ui-message.js";

export type ParameterArtifactCommand =
  | { kind: "capture_device_parameters"; sessionId: string; target: DeviceParameterDestination; label: string }
  | { kind: "apply_device_parameters"; sessionId: string; artifactId: string; target?: DeviceParameterDestination }
  | { kind: "restore_device_parameters"; sessionId: string; applicationId: string }
  | { kind: "keep_device_parameters"; sessionId: string; applicationId: string };

export interface ParameterArtifactRead {
  sessionId: string;
  artifactId?: string;
  target?: DeviceParameterDestination;
  baseArtifactId?: string;
}

export interface ParameterArtifactPreview {
  sessionId: string;
  devices: DeviceParameterTarget[];
  artifact?: DeviceParameterArtifact;
  current?: DeviceParameterSnapshot;
  comparison?: DeviceParameterArtifact;
  bindingError?: UiMessage;
  restoreError?: UiMessage;
  application?: DeviceParameterApplication;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
export function isParameterDestination(value: unknown): value is DeviceParameterDestination {
  return record(value) && Object.keys(value).length === 4 && [value.runtimeId, value.songId, value.trackId, value.deviceId].every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 128);
}
export function isParameterArtifactRead(value: unknown): value is ParameterArtifactRead {
  return record(value) && Object.keys(value).every((key) => ["sessionId", "artifactId", "target", "baseArtifactId"].includes(key)) && id(value.sessionId) &&
    (value.artifactId === undefined || id(value.artifactId)) && (value.baseArtifactId === undefined || id(value.baseArtifactId) && value.artifactId !== undefined) &&
    (value.target === undefined || isParameterDestination(value.target));
}
export function isParameterArtifactCommand(value: unknown): value is ParameterArtifactCommand {
  if (!record(value) || !id(value.sessionId)) return false;
  if (value.kind === "capture_device_parameters") return Object.keys(value).length === 4 && isParameterDestination(value.target) &&
    typeof value.label === "string" && value.label.trim().length > 0 && value.label.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(value.label);
  if (value.kind === "apply_device_parameters") return Object.keys(value).every((key) => ["kind", "sessionId", "artifactId", "target"].includes(key)) && id(value.artifactId) &&
    (value.target === undefined || isParameterDestination(value.target));
  return (value.kind === "restore_device_parameters" || value.kind === "keep_device_parameters") && Object.keys(value).length === 3 && id(value.applicationId);
}
export function isParameterArtifactPreview(value: unknown): value is ParameterArtifactPreview {
  return record(value) && Object.keys(value).every((key) => ["sessionId", "devices", "artifact", "current", "comparison", "bindingError", "restoreError", "application"].includes(key)) &&
    id(value.sessionId) && Array.isArray(value.devices) && value.devices.every(isDeviceParameterTarget) &&
    (value.artifact === undefined || isDeviceParameterArtifact(value.artifact) && value.artifact.sessionId === value.sessionId) &&
    (value.current === undefined || isDeviceParameterSnapshot(value.current)) &&
    (value.comparison === undefined || isDeviceParameterArtifact(value.comparison) && value.comparison.sessionId === value.sessionId &&
      isDeviceParameterArtifact(value.artifact) && value.comparison.version.groupId === value.artifact.version.groupId) &&
    (value.bindingError === undefined || isUiMessage(value.bindingError)) &&
    (value.restoreError === undefined || isUiMessage(value.restoreError)) &&
    (value.application === undefined || isDeviceParameterApplication(value.application) && value.application.sessionId === value.sessionId);
}
