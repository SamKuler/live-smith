import {
  AudioTrack,
  ClipSlot,
  DataModelObject,
  MidiTrack,
  Track,
  type Clip,
  type DataModelObject as DataModelObjectType,
  type ArrangementSelection,
  type ClipSlotSelection,
  type ExtensionContext,
} from "@ableton-extensions/sdk";

type Api = ExtensionContext<"1.0.0">;

export interface LiveTarget {
  track?: Track<"1.0.0">;
  clip?: Clip<"1.0.0">;
  object?: DataModelObjectType<"1.0.0">;
}

export function firstSelectedTrack(
  context: Api,
  selection: ArrangementSelection,
): Track<"1.0.0"> | undefined {
  for (const handle of selection.selected_lanes) {
    const object = context.getObjectFromHandle(handle, DataModelObject);
    const track = findTrackAncestor(object);
    if (track) return track;
  }
  return undefined;
}

export function firstSelectedSlotTrack(
  context: Api,
  selection: ClipSlotSelection,
): Track<"1.0.0"> | undefined {
  for (const handle of selection.selected_clip_slots) {
    const slot = context.getObjectFromHandle(handle, ClipSlot);
    const track = findTrackAncestor(slot);
    if (track) return track;
  }
  return undefined;
}

export function findTrackAncestor(
  object: DataModelObject<"1.0.0"> | null,
): Track<"1.0.0"> | undefined {
  let current: DataModelObject<"1.0.0"> | null = object;
  while (current) {
    if (current instanceof Track) return current;
    current = current.parent;
  }
  return undefined;
}

export function trackTypeLabel(track: Track<"1.0.0">): string {
  if (track instanceof AudioTrack) return "Audio";
  if (track instanceof MidiTrack) return "MIDI";
  return "Generic";
}
