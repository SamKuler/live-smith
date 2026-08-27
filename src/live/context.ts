import {
  AudioClip,
  Clip,
  ClipSlot,
  DataModelObject,
  DrumRack,
  MidiClip,
  RackDevice,
  Sample,
  Scene,
  Simpler,
  TakeLane,
  Track,
  WarpMode,
  type ArrangementSelection,
  type ClipSlotSelection,
  type ExtensionContext,
  type Handle,
} from "@ableton-extensions/sdk";

import {
  findTrackAncestor,
  firstSelectedSlotTrack,
  firstSelectedTrack,
  trackTypeLabel,
  type LiveTarget,
} from "./target.js";
import { summarizeMidiNotes } from "./midi-notes.js";
import type { ConversationScope } from "../model/contracts.js";

type Api = ExtensionContext<"1.0.0">;

export interface LiveInteractionContext {
  summary: string;
  target: LiveTarget;
  scope: ConversationScope;
  /** Selection handles are invocation-scoped and are never persisted with a Session. */
  selectionContext?: {
    refresh(context: Api): LiveInteractionContext | undefined;
  };
}

export function objectInteractionContext(
  context: Api,
  handle: Handle,
): LiveInteractionContext {
  const object = context.getObjectFromHandle(handle, DataModelObject);
  return interactionContextForObject(object);
}

export function interactionContextForScope(
  context: Api,
  scope: ConversationScope,
): LiveInteractionContext | undefined {
  const object = findObjectForScope(context, scope);
  return object ? interactionContextForObject(object) : undefined;
}

function interactionContextForObject(
  object: DataModelObject<"1.0.0">,
): LiveInteractionContext {
  const clip = object instanceof Clip ? object : undefined;
  const track = findTrackAncestor(object);
  return {
    summary: summarizeObject(object),
    target: makeTarget(track, clip, object),
    scope: scopeForObject(object, track, clip),
  };
}

function findObjectForScope(
  context: Api,
  scope: ConversationScope,
): DataModelObject<"1.0.0"> | undefined {
  if (scope.kind === "selection") return undefined;
  const matches = (object: DataModelObject<"1.0.0">) =>
    object.handle.id.toString() === scope.identity;
  const song = context.application.song;

  for (const track of song.tracks ?? []) {
    if (matches(track)) return track;
    for (const clip of track.arrangementClips) {
      if (matches(clip)) return clip;
    }
    for (const takeLane of track.takeLanes) {
      if (matches(takeLane)) return takeLane;
      for (const clip of takeLane.clips) {
        if (matches(clip)) return clip;
      }
    }
    for (const slot of track.clipSlots) {
      if (matches(slot)) return slot;
      if (slot.clip && matches(slot.clip)) return slot.clip;
    }
    for (const device of track.devices) {
      const match = findDeviceObject(device, matches);
      if (match) return match;
    }
  }

  for (const scene of song.scenes ?? []) {
    if (matches(scene)) return scene;
  }
  return undefined;
}

function findDeviceObject(
  device: DataModelObject<"1.0.0">,
  matches: (object: DataModelObject<"1.0.0">) => boolean,
): DataModelObject<"1.0.0"> | undefined {
  if (matches(device)) return device;
  if (device instanceof Simpler && device.sample && matches(device.sample)) {
    return device.sample;
  }
  if (device instanceof RackDevice) {
    for (const chain of device.chains) {
      for (const nestedDevice of chain.devices) {
        const match = findDeviceObject(nestedDevice, matches);
        if (match) return match;
      }
    }
  }
  return undefined;
}

export function arrangementSelectionInteractionContext(
  context: Api,
  selection: ArrangementSelection,
): LiveInteractionContext {
  const snapshot: ArrangementSelection = {
    selected_lanes: [...selection.selected_lanes],
    time_selection_start: selection.time_selection_start,
    time_selection_end: selection.time_selection_end,
  };
  const track = firstSelectedTrack(context, snapshot);
  return {
    summary: summarizeArrangementSelection(context, snapshot),
    target: makeTarget(track),
    selectionContext: {
      refresh: (currentContext) =>
        arrangementLanesAreCurrent(currentContext, snapshot.selected_lanes)
          ? arrangementSelectionInteractionContext(currentContext, snapshot)
          : undefined,
    },
    scope: track
      ? scopeForTrack(track)
      : {
          kind: "selection",
          identity: snapshot.selected_lanes.map((handle) => handle.id.toString()).join(","),
          label: "Arrangement selection",
        },
  };
}

export function clipSlotSelectionInteractionContext(
  context: Api,
  selection: ClipSlotSelection,
): LiveInteractionContext {
  const snapshot: ClipSlotSelection = {
    selected_clip_slots: [...selection.selected_clip_slots],
  };
  const slots = snapshot.selected_clip_slots.map((handle, index) => {
    const slot = context.getObjectFromHandle(handle, ClipSlot);
    const slotTrack = findTrackAncestor(slot);
    if (!slotTrack) {
      throw new Error("A selected Clip Slot has no owning Track.");
    }
    const slotIndex = slotTrack.clipSlots.findIndex(
      (candidate) => candidate.handle.id === slot.handle.id,
    );
    if (slotIndex < 0) {
      throw new Error(
        `A selected Clip Slot is no longer present on track "${slotTrack.name}".`,
      );
    }
    const clip = slot.clip;
    return `Selected slot ${index + 1}: ${trackTypeLabel(slotTrack)} track "${slotTrack.name}", slotIndex=${slotIndex}: ${clip ? summarizeClip(clip) : "empty"}`;
  });
  const targetClip =
    snapshot.selected_clip_slots.length === 1
      ? context.getObjectFromHandle(snapshot.selected_clip_slots[0]!, ClipSlot).clip
      : undefined;
  const track = firstSelectedSlotTrack(context, snapshot);

  return {
    summary: ["Session clip-slot selection:", ...slots].join("\n"),
    target: makeTarget(track, targetClip ?? undefined),
    selectionContext: {
      refresh: (currentContext) =>
        clipSlotsAreCurrent(currentContext, snapshot.selected_clip_slots)
          ? clipSlotSelectionInteractionContext(currentContext, snapshot)
          : undefined,
    },
    scope: targetClip
      ? scopeForClip(targetClip)
      : track
        ? scopeForTrack(track)
        : {
            kind: "selection",
            identity: snapshot.selected_clip_slots
              .map((handle) => handle.id.toString())
              .join(","),
            label: "Clip slot selection",
          },
  };
}

function arrangementLanesAreCurrent(
  context: Api,
  handles: readonly Handle[],
): boolean {
  const current = new Set<string>();
  for (const track of context.application.song.tracks ?? []) {
    current.add(track.handle.id.toString());
    for (const takeLane of track.takeLanes) {
      current.add(takeLane.handle.id.toString());
    }
  }
  return handles.every((handle) => current.has(handle.id.toString()));
}

function clipSlotsAreCurrent(
  context: Api,
  handles: readonly Handle[],
): boolean {
  const current = new Set<string>();
  for (const track of context.application.song.tracks ?? []) {
    for (const slot of track.clipSlots) {
      current.add(slot.handle.id.toString());
    }
  }
  return handles.every((handle) => current.has(handle.id.toString()));
}

function scopeForObject(
  object: DataModelObject<"1.0.0">,
  track: Track<"1.0.0"> | undefined,
  clip: Clip<"1.0.0"> | undefined,
): ConversationScope {
  if (clip) return scopeForClip(clip);
  if (object instanceof Track && track) return scopeForTrack(track);
  const label = "name" in object && typeof object.name === "string" && object.name
    ? object.name
    : object.constructor.name;
  return {
    kind: "object",
    identity: object.handle.id.toString(),
    label,
  };
}

function scopeForTrack(track: Track<"1.0.0">): ConversationScope {
  return {
    kind: "track",
    identity: track.handle.id.toString(),
    label: track.name || "Selected track",
  };
}

function scopeForClip(clip: Clip<"1.0.0">): ConversationScope {
  return {
    kind: "clip",
    identity: clip.handle.id.toString(),
    label: clip.name || "Selected clip",
  };
}

function summarizeArrangementSelection(
  context: Api,
  selection: ArrangementSelection,
): string {
  const start = selection.time_selection_start;
  const end = selection.time_selection_end;
  const lanes = selection.selected_lanes.map((handle, index) => {
    const object = context.getObjectFromHandle(handle, DataModelObject);
    if (object instanceof Track) {
      const overlapping = object.arrangementClips.filter(
        (clip) => clip.endTime > start && clip.startTime < end,
      );
      return [
        `Lane ${index + 1}: ${trackTypeLabel(object)} track "${object.name}"`,
        `  ${trackStateSummary(object)}`,
        `  clips in range=${overlapping.length}`,
        ...overlapping.slice(0, 6).map((clip) => `  - ${summarizeClip(clip)}`),
      ].join("\n");
    }

    if (object instanceof TakeLane) {
      const overlapping = object.clips.filter(
        (clip) => clip.endTime > start && clip.startTime < end,
      );
      return [
        `Lane ${index + 1}: take lane "${object.name}"`,
        `  clips in range=${overlapping.length}`,
        ...overlapping.slice(0, 6).map((clip) => `  - ${summarizeClip(clip)}`),
      ].join("\n");
    }

    return `Lane ${index + 1}: ${object.constructor.name}`;
  });

  return [
    `Arrangement selection: beats ${start} to ${end} (${end - start} beats)`,
    ...lanes,
  ].join("\n");
}

function summarizeObject(object: DataModelObject<"1.0.0">): string {
  if (object instanceof Clip) return summarizeClip(object);
  if (object instanceof Track) return summarizeTrack(object);
  if (object instanceof ClipSlot) {
    return object.clip
      ? `Clip slot containing:\n${summarizeClip(object.clip)}`
      : "Empty clip slot.";
  }
  if (object instanceof Scene) {
    return `Scene ${sceneStateSummary(object)}`;
  }
  if (object instanceof Simpler) {
    return `Simpler "${object.name}", sample=${object.sample ? audioFileLabel(object.sample.filePath) : "none"}`;
  }
  if (object instanceof Sample) return `Sample file: ${audioFileLabel(object.filePath)}`;
  if (object instanceof DrumRack) {
    return `Drum Rack "${object.name}" with ${object.chains.length} chains.`;
  }
  return `Live object: ${object.constructor.name}`;
}

function summarizeTrack(track: Track<"1.0.0">): string {
  return [
    `${trackTypeLabel(track)} track "${track.name}"`,
    trackStateSummary(track),
    `arrangement clips=${track.arrangementClips.length}`,
    `clip slots=${track.clipSlots.length}`,
    `devices=${track.devices.map((device) => device.name).join(", ") || "none"}`,
  ].join("\n");
}

function summarizeClip(clip: Clip<"1.0.0">): string {
  const base = [
    `${clip instanceof MidiClip ? "MIDI" : clip instanceof AudioClip ? "Audio" : "Unknown"} clip "${clip.name}"`,
    `start=${clip.startTime}, end=${clip.endTime}, duration=${clip.duration}`,
    `startMarker=${clip.startMarker}, endMarker=${clip.endMarker}`,
    `looping=${clip.looping}, muted=${clip.muted}, color=${clip.color}`,
  ];

  if (clip instanceof MidiClip) {
    base.push(summarizeMidiNotes(clip.notes));
  }

  if (clip instanceof AudioClip) {
    base.push(
      `file=${audioFileLabel(clip.filePath)}`,
      `warping=${clip.warping}, warpMode=${warpModeLabel(clip.warpMode)}, warpMarkers=${clip.warpMarkers.length}`,
    );
  }

  return base.join("\n");
}

export function trackStateSummary(track: Track<"1.0.0">): string {
  const groupTrack = track.groupTrack;
  return [
    `mute=${track.mute}`,
    `solo=${track.solo}`,
    `mutedViaSolo=${track.mutedViaSolo}`,
    `armed=${track.arm}`,
    `groupTrack=${groupTrack ? `"${groupTrack.name}"` : "none"}`,
  ].join(", ");
}

export function sceneStateSummary(scene: Scene<"1.0.0">): string {
  return `"${scene.name}" tempo=${scene.tempo} signature=${scene.signatureNumerator}/${scene.signatureDenominator}`;
}

export function warpModeLabel(mode: WarpMode): string {
  switch (mode) {
    case WarpMode.Beats: return "beats";
    case WarpMode.Tones: return "tones";
    case WarpMode.Texture: return "texture";
    case WarpMode.Repitch: return "repitch";
    case WarpMode.Complex: return "complex";
    case WarpMode.ComplexPro: return "complex_pro";
    default: return String(mode);
  }
}

export function audioFileLabel(filePath: string | undefined): string {
  const parts = (filePath ?? "")
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean);
  return parts.at(-1) ?? "unknown";
}

function makeTarget(
  track: Track<"1.0.0"> | undefined,
  clip?: Clip<"1.0.0"> | undefined,
  object?: DataModelObject<"1.0.0"> | undefined,
): LiveTarget {
  return {
    ...(track ? { track } : {}),
    ...(clip ? { clip } : {}),
    ...(object ? { object } : {}),
  };
}
