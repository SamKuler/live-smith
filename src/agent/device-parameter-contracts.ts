import { isArtifactLabel, isArtifactVersion, type ArtifactVersion } from "./artifact-contracts.js";

/** Complete saved values; display labels never imply units or enum value mappings. */
export interface DeviceParameterValue {
  index: number;
  name: string;
  handleId: string;
  min: number;
  max: number;
  isQuantized: boolean;
  valueItems: { name: string; shortName: string }[];
  value: number;
}

export interface DeviceParameterTarget {
  runtimeId: string;
  songId: string;
  trackId: string;
  deviceId: string;
  trackName: string;
  trackRole: "regular" | "return" | "main";
  trackIndex?: number;
  deviceName: string;
  devicePath: string;
}

export interface DeviceParameterSnapshot {
  target: DeviceParameterTarget;
  parameters: DeviceParameterValue[];
}

export const MAX_DEVICE_PARAMETERS = 4096;
export const MAX_DEVICE_PARAMETER_ITEMS = 4096;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 512): value is string => typeof value === "string" && value.length <= max;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));

export function isDeviceParameterTarget(value: unknown): value is DeviceParameterTarget {
  return record(value) && keys(value, ["runtimeId", "songId", "trackId", "deviceId", "trackName", "trackRole", "trackIndex", "deviceName", "devicePath"]) &&
    [value.runtimeId, value.songId, value.trackId, value.deviceId].every((id) => text(id, 128) && id.length > 0) &&
    text(value.trackName) && text(value.deviceName) && text(value.devicePath, 8192) &&
    (value.trackRole === "main" ? value.trackIndex === undefined : (value.trackRole === "regular" || value.trackRole === "return") && Number.isSafeInteger(value.trackIndex) && Number(value.trackIndex) >= 0);
}

export function isDeviceParameterValue(value: unknown): value is DeviceParameterValue {
  return record(value) && keys(value, ["index", "name", "handleId", "min", "max", "isQuantized", "valueItems", "value"]) &&
    Number.isSafeInteger(value.index) && Number(value.index) >= 0 && Number(value.index) < MAX_DEVICE_PARAMETERS &&
    text(value.name) && text(value.handleId, 128) && value.handleId.length > 0 &&
    finite(value.min) && finite(value.max) && value.min <= value.max && finite(value.value) && value.value >= value.min && value.value <= value.max &&
    typeof value.isQuantized === "boolean" && Array.isArray(value.valueItems) && value.valueItems.length <= MAX_DEVICE_PARAMETER_ITEMS &&
    value.valueItems.every((item) => record(item) && keys(item, ["name", "shortName"]) && text(item.name) && text(item.shortName));
}

export function isDeviceParameterSnapshot(value: unknown): value is DeviceParameterSnapshot {
  return record(value) && keys(value, ["target", "parameters"]) && isDeviceParameterTarget(value.target) &&
    Array.isArray(value.parameters) && value.parameters.length > 0 && value.parameters.length <= MAX_DEVICE_PARAMETERS &&
    value.parameters.every((parameter, index) => isDeviceParameterValue(parameter) && parameter.index === index) &&
    new Set(value.parameters.map((parameter) => parameter.handleId)).size === value.parameters.length;
}

export interface DeviceParameterWrite {
  parameterIndex: number;
  parameterName: string;
  value: number;
}

export function isDeviceParameterWrites(value: unknown): value is DeviceParameterWrite[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_DEVICE_PARAMETERS &&
    value.every((item) => record(item) && keys(item, ["parameterIndex", "parameterName", "value"]) &&
      Number.isSafeInteger(item.parameterIndex) && Number(item.parameterIndex) >= 0 && Number(item.parameterIndex) < MAX_DEVICE_PARAMETERS &&
      text(item.parameterName) && finite(item.value)) &&
    new Set(value.map((item) => item.parameterIndex)).size === value.length;
}

export function sameParameterLayout(left: readonly DeviceParameterValue[], right: readonly DeviceParameterValue[]): boolean {
  return left.length === right.length && left.every((a, index) => {
    const b = right[index]!;
    return a.index === b.index && a.name === b.name && a.min === b.min && a.max === b.max &&
      a.isQuantized === b.isQuantized && JSON.stringify(a.valueItems) === JSON.stringify(b.valueItems);
  });
}

export function sameParameterNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

export interface DeviceParameterArtifact extends DeviceParameterSnapshot {
  id: string;
  sessionId: string;
  label: string;
  createdAt: string;
  version: ArtifactVersion;
  source: { kind: "captured" } | { kind: "model"; profileId: string; model: string };
}

const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
const timestamp = (value: unknown): value is string => text(value, 64) && Number.isFinite(Date.parse(value));

export function isDeviceParameterArtifact(value: unknown): value is DeviceParameterArtifact {
  return record(value) && keys(value, ["id", "sessionId", "label", "createdAt", "version", "source", "target", "parameters"]) &&
    id(value.id) && id(value.sessionId) && isArtifactLabel(value.label) && timestamp(value.createdAt) &&
    isArtifactVersion(value.version, value.id) && isDeviceParameterSnapshot({ target: value.target, parameters: value.parameters }) &&
    record(value.source) && (value.source.kind === "captured" ? keys(value.source, ["kind"]) :
      value.source.kind === "model" && keys(value.source, ["kind", "profileId", "model"]) && text(value.source.profileId, 128) && text(value.source.model, 512));
}

export interface DeviceParameterApplication {
  id: string;
  sessionId: string;
  artifactId: string;
  artifactLabel: string;
  artifactVersion: number;
  createdAt: string;
  target: DeviceParameterTarget;
  status: "applying" | "applied" | "restoring" | "restored" | "partial" | "kept";
  restorationBaseline?: DeviceParameterValue[];
  entries: {
    parameter: DeviceParameterValue;
    requested: number;
    state: "pending" | "applying" | "applied" | "restoring" | "restored" | "conflict";
    after?: number;
  }[];
}

export function isDeviceParameterApplication(value: unknown): value is DeviceParameterApplication {
  return record(value) && keys(value, ["id", "sessionId", "artifactId", "artifactLabel", "artifactVersion", "createdAt", "target", "status", "entries", "restorationBaseline"]) &&
    id(value.id) && id(value.sessionId) && id(value.artifactId) && timestamp(value.createdAt) && isDeviceParameterTarget(value.target) &&
    isArtifactLabel(value.artifactLabel) && Number.isSafeInteger(value.artifactVersion) && Number(value.artifactVersion) > 0 &&
    ["applying", "applied", "restoring", "restored", "partial", "kept"].includes(String(value.status)) &&
    Array.isArray(value.entries) && value.entries.length > 0 && value.entries.length <= MAX_DEVICE_PARAMETERS &&
    (value.restorationBaseline === undefined || isDeviceParameterSnapshot({ target: value.target, parameters: value.restorationBaseline })) &&
    value.entries.every((entry) => record(entry) && keys(entry, ["parameter", "requested", "state", "after"]) &&
      isDeviceParameterValue(entry.parameter) && finite(entry.requested) && entry.requested >= entry.parameter.min && entry.requested <= entry.parameter.max &&
      ["pending", "applying", "applied", "restoring", "restored", "conflict"].includes(String(entry.state)) &&
      (entry.state === "conflict" ? entry.after === undefined || finite(entry.after) : entry.state === "pending" || entry.state === "applying" ? entry.after === undefined :
        finite(entry.after) && entry.after >= entry.parameter.min && entry.after <= entry.parameter.max)) &&
    new Set(value.entries.map((entry) => entry.parameter.index)).size === value.entries.length;
}

export const parameterApplicationIsOpen = (value: DeviceParameterApplication): boolean => value.status !== "restored" && value.status !== "kept";
