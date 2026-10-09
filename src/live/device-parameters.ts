import { uiMessage, UiMessageError } from "../i18n/ui-message.js";
import type { Device, DeviceParameter, ExtensionContext, RackDevice, Track } from "@ableton-extensions/sdk";
import { createStorageId } from "../storage/id.js";
import { isDeviceParameterSnapshot, isDeviceParameterValue, isDeviceParameterWrites, MAX_DEVICE_PARAMETERS,
  sameParameterLayout, sameParameterNumber, type DeviceParameterSnapshot, type DeviceParameterTarget,
  type DeviceParameterValue, type DeviceParameterWrite } from "../agent/device-parameter-contracts.js";
import { throwIfAborted } from "../runtime/host.js";
import { collectDeviceTree, type DevicePath, type ResolvedDeviceTarget } from "./device-tree.js";
import { songTrackEntries } from "./resolve.js";

const runtimes = new WeakMap<object, string>();
function runtimeFor(song: object): string {
  let id = runtimes.get(song);
  if (!id) { id = createStorageId("live"); runtimes.set(song, id); }
  return id;
}
type Api = ExtensionContext<"1.0.0">;
export type DeviceParameterDestination = Pick<DeviceParameterTarget, "runtimeId" | "songId" | "trackId" | "deviceId">;
export interface ResolvedParameterDevice { track: Track<"1.0.0">; resolved: ResolvedDeviceTarget; target: DeviceParameterTarget }

export function parameterHandleId(value: { handle: { id: unknown } }): string {
  const id = value.handle.id;
  if (typeof id !== "bigint" && typeof id !== "number" && typeof id !== "string") throw new UiMessageError(uiMessage("Device parameter identity is unavailable."));
  return String(id);
}

function deviceDisplayPath(track: Track<"1.0.0">, path: DevicePath): string {
  let device = track.devices[path.deviceIndex]!;
  const labels = [`${path.deviceIndex + 1}. ${device.name}`];
  for (const segment of path.nested ?? []) {
    const chain = (device as RackDevice<"1.0.0">).chains[segment.chainIndex]!;
    labels[labels.length - 1] += ` [${segment.chainIndex + 1}]`;
    device = chain.devices[segment.deviceIndex]!;
    labels.push(`${segment.deviceIndex + 1}. ${device.name}`);
  }
  return labels.join(" / ");
}

export function parameterDeviceTargets(context: Api): ResolvedParameterDevice[] {
  const song = context.application.song;
  const runtimeId = runtimeFor(song);
  return songTrackEntries(song).flatMap((entry) => collectDeviceTree(entry.track).map((resolved) => ({
    track: entry.track, resolved, target: { runtimeId, songId: parameterHandleId(song), trackId: parameterHandleId(entry.track), deviceId: parameterHandleId(resolved.device),
      trackName: entry.track.name, trackRole: entry.role, ...("index" in entry ? { trackIndex: entry.index } : {}),
      deviceName: resolved.device.name, devicePath: deviceDisplayPath(entry.track, resolved.path) },
  })));
}

export function resolveParameterDevice(context: Api, target: DeviceParameterDestination): ResolvedParameterDevice {
  if (target.runtimeId !== runtimeFor(context.application.song) || target.songId !== parameterHandleId(context.application.song)) throw new UiMessageError(uiMessage("The saved device binding belongs to another Live runtime. Choose the destination device explicitly."));
  const matches = parameterDeviceTargets(context).filter((entry) => entry.target.trackId === target.trackId && entry.target.deviceId === target.deviceId);
  if (matches.length !== 1) throw new UiMessageError(uiMessage("The destination device is no longer available. Choose the destination device explicitly."));
  return matches[0]!;
}

function parameterMetadata(parameter: DeviceParameter<"1.0.0">, index: number, value: number): DeviceParameterValue {
  const result: DeviceParameterValue = { index, name: parameter.name, handleId: parameterHandleId(parameter), min: parameter.min, max: parameter.max,
    isQuantized: parameter.isQuantized, valueItems: parameter.valueItems.map(({ name, shortName }) => ({ name, shortName })), value };
  if (!isDeviceParameterValue(result)) throw new UiMessageError(uiMessage("Could not capture parameter {index} on this device. Its value or metadata is unavailable.", { index }));
  return result;
}

export async function captureParameterDevice(context: Api, target: DeviceParameterDestination, signal?: AbortSignal): Promise<DeviceParameterSnapshot> {
  const bound = resolveParameterDevice(context, target);
  const observed = await captureDeviceParameters(bound.resolved.device, signal);
  const current = resolveParameterDevice(context, target);
  if (parameterHandleId(current.resolved.device) !== parameterHandleId(bound.resolved.device)) throw new UiMessageError(uiMessage("The device changed during capture."));
  const result = { target: current.target, parameters: observed };
  if (!isDeviceParameterSnapshot(result)) throw new UiMessageError(uiMessage("A complete device parameter snapshot could not be captured."));
  return result;
}

export async function captureDeviceParameters(device: Device<"1.0.0">, signal?: AbortSignal): Promise<DeviceParameterValue[]> {
  const parameters = [...device.parameters];
  if (!parameters.length || parameters.length > MAX_DEVICE_PARAMETERS) throw new UiMessageError(uiMessage("The device must expose between 1 and {maximum} parameters.", { maximum: MAX_DEVICE_PARAMETERS }));
  const result: DeviceParameterValue[] = [];
  for (let offset = 0; offset < parameters.length; offset += 16) {
    throwIfAborted(signal);
    result.push(...await Promise.all(parameters.slice(offset, offset + 16).map(async (parameter, index) =>
      parameterMetadata(parameter, offset + index, await parameter.getValue()))));
  }
  throwIfAborted(signal);
  assertDeviceParameterLayout(device, result);
  return result;
}

export function assertDeviceParameterLayout(device: Device<"1.0.0">, observed: readonly DeviceParameterValue[]): void {
  const current = device.parameters;
  if (current.length !== observed.length || observed.some((entry, index) => {
    const parameter = current[index]!;
    const metadata = parameterMetadata(parameter, index, entry.value);
    return metadata.handleId !== entry.handleId || !sameParameterLayout([entry], [metadata]);
  })) throw new UiMessageError(uiMessage("The device parameter layout changed. Capture the device again before applying."));
}

export async function observeParameterWrites(device: Device<"1.0.0">, writes: readonly DeviceParameterWrite[], signal?: AbortSignal): Promise<DeviceParameterValue[]> {
  if (!isDeviceParameterWrites(writes)) throw new UiMessageError(uiMessage("Device parameter writes are invalid."));
  const parameters = await captureDeviceParameters(device, signal);
  for (const write of writes) {
    const parameter = parameters[write.parameterIndex];
    if (!parameter || parameter.name !== write.parameterName || write.value < parameter.min || write.value > parameter.max) {
      throw new UiMessageError(uiMessage("Parameter {index} no longer matches its observed name or range.", { index: write.parameterIndex }));
    }
  }
  return parameters;
}

export interface ParameterWriteHooks {
  beforeWrite?(index: number, parameter: DeviceParameterValue, value: number): Promise<void>;
  afterWrite?(index: number, value: number): Promise<void>;
  writeNotStarted?(index: number): Promise<void>;
}

export class DeviceParameterWriteError extends Error {
  constructor(readonly completed: string[], readonly writesStarted: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Device parameter application failed.", { cause });
  }
}

/** Side effects and external edits can change later parameters; never silently overwrite them. */
export async function executeParameterWrites(device: Device<"1.0.0">, writes: readonly DeviceParameterWrite[], input: ParameterWriteHooks & {
  signal?: AbortSignal; expected?: readonly DeviceParameterValue[]; assertCurrent(): void;
}): Promise<{ results: string[]; mutationCount: number }> {
  const observed = await observeParameterWrites(device, writes, input.signal);
  if (input.expected && (!sameParameterLayout(input.expected, observed) || input.expected.some((parameter, index) =>
    parameter.handleId !== observed[index]!.handleId || !sameParameterNumber(parameter.value, observed[index]!.value)))) {
    throw new UiMessageError(uiMessage("Device parameters changed after preflight. Inspect the device before applying."));
  }
  const completed: string[] = [];
  let writesStarted = 0;
  let preparingIndex: number | undefined;
  const currentParameter = (before: DeviceParameterValue) => {
    const parameters = device.parameters;
    const parameter = parameters[before.index];
    if (parameters.length !== observed.length || !parameter) throw new UiMessageError(uiMessage("The device parameter layout changed during application."));
    const metadata = parameterMetadata(parameter, before.index, before.value);
    if (metadata.handleId !== before.handleId || !sameParameterLayout([before], [metadata])) throw new UiMessageError(uiMessage("The device parameter identity or range changed during application."));
    return parameter;
  };
  try {
    for (const [index, write] of writes.entries()) {
      throwIfAborted(input.signal); input.assertCurrent();
      const before = observed[write.parameterIndex]!;
      const parameter = currentParameter(before);
      if (!sameParameterNumber(await parameter.getValue(), before.value)) throw new UiMessageError(uiMessage('Parameter "{name}" changed before its write. Inspect the device before continuing.', { name: before.name }));
      if (sameParameterNumber(before.value, write.value)) continue;
      preparingIndex = index;
      await input.beforeWrite?.(index, before, write.value);
      throwIfAborted(input.signal); input.assertCurrent(); currentParameter(before);
      if (!sameParameterNumber(await parameter.getValue(), before.value)) throw new UiMessageError(uiMessage('Parameter "{name}" changed while preparing its write.', { name: before.name }));
      throwIfAborted(input.signal); input.assertCurrent(); currentParameter(before);
      // Keep the receipt in-flight until both the SDK acknowledgement and readback succeed.
      preparingIndex = undefined;
      writesStarted += 1;
      await parameter.setValue(write.value);
      const after = await parameter.getValue();
      currentParameter(before);
      if (!Number.isFinite(after) || after < before.min || after > before.max) throw new UiMessageError(uiMessage('The value written to "{name}" could not be verified.', { name: before.name }));
      await input.afterWrite?.(index, after);
      completed.push(`Set [${before.index}] "${before.name}" to ${after}.`);
    }
    return { results: completed, mutationCount: writesStarted };
  } catch (error) {
    if (preparingIndex !== undefined) await input.writeNotStarted?.(preparingIndex).catch(() => undefined);
    throw new DeviceParameterWriteError(completed, writesStarted, error);
  }
}
