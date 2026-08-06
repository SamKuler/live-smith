import {
  Device,
  RackDevice,
  type Chain,
  type Track,
} from "@ableton-extensions/sdk";

import type { LiveTarget } from "./target.js";

export interface NestedDevicePathSegment {
  chainIndex: number;
  deviceIndex: number;
}

export interface DevicePath {
  deviceIndex: number;
  nested?: NestedDevicePathSegment[];
}

export interface ResolvedDeviceTarget {
  device: Device<"1.0.0">;
  parent: Track<"1.0.0"> | Chain<"1.0.0">;
  path: DevicePath;
}

export interface DeviceTreeEntry extends ResolvedDeviceTarget {
  depth: number;
}

export function resolveDeviceTarget(
  track: Track<"1.0.0">,
  target: LiveTarget,
  expectedName: string,
  path?: DevicePath,
  legacyDeviceIndex?: number,
): ResolvedDeviceTarget {
  if (path && legacyDeviceIndex !== undefined) {
    throw new Error("Use either devicePath or deviceIndex, not both.");
  }

  if (path) {
    const resolved = resolveDevicePath(track, path);
    assertExpectedDeviceName(resolved.device, expectedName, pathLabel(path));
    return resolved;
  }

  if (target.object instanceof Device) {
    const selectedPath = findDevicePath(track, target.object);
    if (!selectedPath) {
      throw new Error(
        `Selected device "${safeDeviceName(target.object)}" is not inside track "${track.name}".`,
      );
    }
    const resolved = resolveDevicePath(track, selectedPath);
    assertExpectedDeviceName(resolved.device, expectedName, "the selected device");
    return resolved;
  }

  if (legacyDeviceIndex !== undefined) {
    const pathAtIndex = { deviceIndex: legacyDeviceIndex };
    const resolved = resolveDevicePath(track, pathAtIndex);
    assertExpectedDeviceName(resolved.device, expectedName, `deviceIndex ${legacyDeviceIndex}`);
    return resolved;
  }

  const matches = collectDeviceTree(track).filter(
    ({ device }) => sameName(device.name, expectedName),
  );
  if (!matches.length) {
    throw new Error(
      `Could not find device "${expectedName}" on track "${track.name}". Available devices: ${deviceTreeList(track)}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Found ${matches.length} devices named "${expectedName}" on track "${track.name}". Specify devicePath. Available devices: ${deviceTreeList(track)}`,
    );
  }
  return matches[0]!;
}

export function resolveDevicePath(
  track: Track<"1.0.0">,
  path: DevicePath,
): ResolvedDeviceTarget {
  assertIndex(path.deviceIndex, "devicePath.deviceIndex");
  const topLevel = track.devices[path.deviceIndex];
  if (!topLevel) {
    throw new Error(
      `Could not find ${pathLabel(path)} on track "${track.name}". Available devices: ${deviceTreeList(track)}`,
    );
  }

  let parent: Track<"1.0.0"> | Chain<"1.0.0"> = track;
  let device: Device<"1.0.0"> = topLevel;
  const normalizedNested: NestedDevicePathSegment[] = [];
  for (const [index, segment] of (path.nested ?? []).entries()) {
    assertIndex(segment.chainIndex, `devicePath.nested[${index}].chainIndex`);
    assertIndex(segment.deviceIndex, `devicePath.nested[${index}].deviceIndex`);
    if (!(device instanceof RackDevice)) {
      throw new Error(
        `${pathLabel({ deviceIndex: path.deviceIndex, nested: normalizedNested })} resolves to "${safeDeviceName(device)}", which is not a Rack device.`,
      );
    }
    const chain = device.chains[segment.chainIndex];
    if (!chain) {
      throw new Error(
        `Could not find chainIndex ${segment.chainIndex} inside "${safeDeviceName(device)}". It has ${device.chains.length} chains.`,
      );
    }
    const nestedDevice = chain.devices[segment.deviceIndex];
    if (!nestedDevice) {
      throw new Error(
        `Could not find deviceIndex ${segment.deviceIndex} in chainIndex ${segment.chainIndex} of "${safeDeviceName(device)}". The chain has ${chain.devices.length} devices.`,
      );
    }
    normalizedNested.push({ ...segment });
    parent = chain;
    device = nestedDevice;
  }

  return {
    device,
    parent,
    path: {
      deviceIndex: path.deviceIndex,
      ...(normalizedNested.length ? { nested: normalizedNested } : {}),
    },
  };
}

export function findDevicePath(
  track: Track<"1.0.0">,
  selected: Device<"1.0.0">,
): DevicePath | undefined {
  return collectDeviceTree(track).find(({ device }) => sameObject(device, selected))?.path;
}

export function collectDeviceTree(track: Track<"1.0.0">): DeviceTreeEntry[] {
  const entries: DeviceTreeEntry[] = [];
  track.devices.forEach((device, deviceIndex) => {
    collectDevice(entries, track, device, { deviceIndex }, 0);
  });
  return entries;
}

export function devicePathLabel(path: DevicePath): string {
  return pathLabel(path);
}

function collectDevice(
  entries: DeviceTreeEntry[],
  parent: Track<"1.0.0"> | Chain<"1.0.0">,
  device: Device<"1.0.0">,
  path: DevicePath,
  depth: number,
): void {
  entries.push({ device, parent, path, depth });
  if (!(device instanceof RackDevice)) return;
  device.chains.forEach((chain, chainIndex) => {
    chain.devices.forEach((nestedDevice, deviceIndex) => {
      collectDevice(
        entries,
        chain,
        nestedDevice,
        {
          deviceIndex: path.deviceIndex,
          nested: [
            ...(path.nested ?? []),
            { chainIndex, deviceIndex },
          ],
        },
        depth + 1,
      );
    });
  });
}

function assertExpectedDeviceName(
  device: Device<"1.0.0">,
  expectedName: string,
  location: string,
): void {
  if (!sameName(device.name, expectedName)) {
    throw new Error(
      `Device at ${location} is "${safeDeviceName(device)}", not "${expectedName}".`,
    );
  }
}

function assertIndex(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function sameObject(
  left: Device<"1.0.0">,
  right: Device<"1.0.0">,
): boolean {
  if (left === right) return true;
  const leftId = objectHandleId(left);
  const rightId = objectHandleId(right);
  return leftId !== undefined && rightId !== undefined && leftId === rightId;
}

function objectHandleId(value: object): string | undefined {
  const id = (value as { handle?: { id?: unknown } }).handle?.id;
  return id === undefined || id === null ? undefined : String(id);
}

function safeDeviceName(device: Device<"1.0.0">): string {
  try {
    return device.name;
  } catch {
    return "unknown device";
  }
}

function pathLabel(path: DevicePath): string {
  return `devicePath ${JSON.stringify(path)}`;
}

function deviceTreeList(track: Track<"1.0.0">): string {
  return collectDeviceTree(track)
    .map(({ device, path }) => `${pathLabel(path)}: ${safeDeviceName(device)}`)
    .join(", ") || "none";
}
