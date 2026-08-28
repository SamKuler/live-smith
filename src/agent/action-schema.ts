import type { NoteDescription } from "@ableton-extensions/sdk";
import type { DevicePath } from "../live/device-tree.js";

export type SampleSource =
  | { kind: "selected" }
  | {
      kind: "arrangement_audio_clip";
      trackName: string;
      startBeat: number;
      clipName?: string;
    }
  | {
      kind: "session_audio_clip";
      trackName: string;
      slotIndex: number;
      clipName?: string;
    }
  | {
      kind: "simpler";
      trackName: string;
      deviceName: string;
      devicePath?: DevicePath;
      deviceIndex?: number;
    };

export interface ClipLoopSettingsInput {
  looping: boolean;
  startMarker: number;
  endMarker: number;
  loopStart: number;
  loopEnd: number;
}

type JsonSchema = Record<string, unknown>;

interface ActionField<Value, Required extends boolean> {
  required: Required;
  schema: JsonSchema;
  parse(value: unknown, key: string): Value | undefined;
}

type AnyActionField = ActionField<unknown, boolean>;
type ActionFields = Record<string, AnyActionField>;

type FieldValue<Field> = Field extends ActionField<infer Value, boolean>
  ? Value
  : never;
type RequiredFieldKeys<Fields extends ActionFields> = {
  [Key in keyof Fields]: Fields[Key] extends ActionField<unknown, true>
    ? Key
    : never;
}[keyof Fields];
type OptionalFieldKeys<Fields extends ActionFields> = Exclude<
  keyof Fields,
  RequiredFieldKeys<Fields>
>;
type ParsedFields<Fields extends ActionFields> = {
  [Key in RequiredFieldKeys<Fields>]: FieldValue<Fields[Key]>;
} & {
  [Key in OptionalFieldKeys<Fields>]?: FieldValue<Fields[Key]>;
};
type ParsedAction<Type extends string, Fields extends ActionFields> = {
  type: Type;
} & ParsedFields<Fields>;

interface ActionDescriptor<Type extends string, Fields extends ActionFields> {
  type: Type;
  schema: JsonSchema;
  example: ParsedAction<Type, Fields>;
  parse(record: Record<string, unknown>): ParsedAction<Type, Fields>;
}

const actionDescriptors = {
  create_midi_track: defineAction(
    "create_midi_track",
    { name: optionalString(), ref: optionalRef() },
    { type: "create_midi_track", name: "AI Chords", ref: "chords" },
  ),
  create_audio_track: defineAction(
    "create_audio_track",
    { name: optionalString(), ref: optionalRef() },
    { type: "create_audio_track", name: "AI Audio", ref: "audio" },
  ),
  create_scene: defineAction(
    "create_scene",
    { name: optionalString(), index: optionalInteger(-1) },
    { type: "create_scene", name: "Verse", index: -1 },
  ),
  rename_scene: defineAction(
    "rename_scene",
    {
      sceneIndex: requiredIntegerInRange(
        0,
        4095,
        "0-based Session View Scene index. This identifies the target Scene.",
      ),
      sceneName: optionalString(
        "Optional exact current Session View Scene name used only as a stale-state guard. Omit it unless observed; never send an empty value or put the desired new name here.",
      ),
      newName: requiredString(
        "Required desired new Session View Scene name.",
      ),
    },
    { type: "rename_scene", sceneIndex: 0, newName: "Verse" },
  ),
  duplicate_scene: defineAction(
    "duplicate_scene",
    {
      sceneIndex: requiredIntegerInRange(
        0,
        4095,
        "0-based Session View Scene index. This identifies the target Scene.",
      ),
      sceneName: optionalString(
        "Optional exact current Session View Scene name used only as a stale-state guard. Omit it unless observed.",
      ),
    },
    { type: "duplicate_scene", sceneIndex: 0 },
  ),
  delete_scene: defineAction(
    "delete_scene",
    {
      sceneIndex: requiredIntegerInRange(
        0,
        4095,
        "0-based Session View Scene index. This identifies the target Scene.",
      ),
      sceneName: optionalString(
        "Optional exact current Session View Scene name used only as a stale-state guard. Omit it unless observed.",
      ),
    },
    { type: "delete_scene", sceneIndex: 0, sceneName: "Draft" },
  ),
  create_cue_point: defineAction(
    "create_cue_point",
    { timeBeat: requiredNonNegativeNumber(), name: optionalString() },
    { type: "create_cue_point", timeBeat: 16, name: "Drop" },
  ),
  rename_cue_point: defineAction(
    "rename_cue_point",
    {
      timeBeat: requiredNonNegativeNumber(),
      cueName: optionalString(),
      newName: requiredString("New Cue Point name."),
    },
    { type: "rename_cue_point", timeBeat: 16, cueName: "Drop", newName: "Drop 1" },
  ),
  delete_cue_point: defineAction(
    "delete_cue_point",
    { timeBeat: requiredNonNegativeNumber(), cueName: optionalString() },
    { type: "delete_cue_point", timeBeat: 16, cueName: "Draft" },
  ),
  create_midi_clip: defineAction(
    "create_midi_clip",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      laneIndex: optionalIntegerInRange(
        0,
        4095,
        "0-based existing Take Lane index. Omit for the track's main Arrangement lane.",
      ),
      laneName: optionalString("Optional expected current Take Lane name guard."),
      startBeat: requiredNumber(),
      durationBeats: requiredPositiveNumber(),
      name: optionalString(),
      notes: requiredNotes(0),
    },
    {
      type: "create_midi_clip",
      trackName: "AI Chords",
      startBeat: 0,
      durationBeats: 8,
      name: "Verse Chords",
      notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 96 }],
    },
  ),
  create_session_midi_clip: defineAction(
    "create_session_midi_clip",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      slotIndex: requiredIntegerInRange(0, 4095),
      durationBeats: requiredPositiveNumber(),
      name: optionalString(),
      notes: requiredNotes(0),
    },
    {
      type: "create_session_midi_clip",
      trackName: "Lead",
      slotIndex: 0,
      durationBeats: 8,
      name: "Lead Loop",
      notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 96 }],
    },
  ),
  replace_midi_clip_segment: defineAction(
    "replace_midi_clip_segment",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      clipName: requiredString("Exact arrangement MIDI Clip name."),
      startBeat: requiredNumber("Exact arrangement Clip start beat."),
      segmentStartTime: requiredNonNegativeNumber(
        "Segment start in beats relative to the Clip.",
      ),
      segmentDurationBeats: requiredPositiveNumber(),
      notes: requiredNotes(0),
    },
    {
      type: "replace_midi_clip_segment",
      trackName: "AI Chords",
      clipName: "Full arrangement",
      startBeat: 0,
      segmentStartTime: 0,
      segmentDurationBeats: 16,
      notes: [{ pitch: 60, startTime: 0, duration: 4, velocity: 96 }],
    },
  ),
  transpose_midi_notes: defineAction(
    "transpose_midi_notes",
    {
      ...midiTransformClipFields(),
      semitones: requiredIntegerInRange(-127, 127),
    },
    {
      type: "transpose_midi_notes",
      trackName: "Lead",
      clipName: "Lead Loop",
      slotIndex: 0,
      semitones: 12,
    },
  ),
  quantize_midi_notes: defineAction(
    "quantize_midi_notes",
    {
      ...midiTransformClipFields(),
      gridBeats: requiredPositiveNumber(),
      strength: requiredNumberInRange(0, 1),
    },
    {
      type: "quantize_midi_notes",
      trackName: "Lead",
      clipName: "Lead Loop",
      slotIndex: 0,
      gridBeats: 0.25,
      strength: 1,
    },
  ),
  scale_midi_velocity: defineAction(
    "scale_midi_velocity",
    {
      ...midiTransformClipFields(),
      factor: requiredNumberInRange(0.01, 16),
    },
    {
      type: "scale_midi_velocity",
      trackName: "Lead",
      clipName: "Lead Loop",
      slotIndex: 0,
      factor: 0.85,
    },
  ),
  shift_midi_notes: defineAction(
    "shift_midi_notes",
    {
      ...midiTransformClipFields(),
      offsetBeats: requiredNumber(),
    },
    {
      type: "shift_midi_notes",
      trackName: "Lead",
      clipName: "Lead Loop",
      slotIndex: 0,
      offsetBeats: 0.25,
    },
  ),
  insert_device: defineAction(
    "insert_device",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      deviceName: requiredString(),
      index: optionalInteger(0),
    },
    {
      type: "insert_device",
      trackName: "Lead",
      deviceName: "Auto Filter",
    },
  ),
  insert_chain_device: defineAction(
    "insert_chain_device",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      rackName: requiredString("Exact Rack name from inspect_device_tree."),
      rackPath: optionalDevicePath(),
      chainIndex: requiredIntegerInRange(0, 4095),
      deviceName: requiredString("Exact built-in Live device name."),
      index: optionalInteger(0),
    },
    {
      type: "insert_chain_device",
      trackName: "Drums",
      rackName: "Drum Rack",
      rackPath: { deviceIndex: 0 },
      chainIndex: 0,
      deviceName: "Simpler",
    },
  ),
  set_device_parameter: defineAction(
    "set_device_parameter",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      deviceName: requiredString(),
      deviceIndex: optionalInteger(
        0,
        "Optional 0-based position in the track device chain. Use this when multiple devices have the same name.",
      ),
      devicePath: optionalDevicePath(),
      parameterName: requiredString(
        "Exact parameter name from inspect_device, not a guessed UI concept.",
      ),
      value: requiredNumber(),
    },
    {
      type: "set_device_parameter",
      trackName: "Lead",
      deviceName: "Auto Filter",
      deviceIndex: 1,
      parameterName: "Frequency",
      value: 0.6,
    },
  ),
  duplicate_device: defineAction(
    "duplicate_device",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      deviceName: requiredString(),
      deviceIndex: optionalInteger(0),
      devicePath: optionalDevicePath(),
    },
    {
      type: "duplicate_device",
      trackName: "Lead",
      deviceName: "Serum",
      devicePath: { deviceIndex: 0 },
    },
  ),
  delete_device: defineAction(
    "delete_device",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      deviceName: requiredString(),
      deviceIndex: optionalInteger(0),
      devicePath: optionalDevicePath(),
    },
    {
      type: "delete_device",
      trackName: "Lead",
      deviceName: "Unused Device",
      devicePath: { deviceIndex: 2 },
    },
  ),
  replace_simpler_sample: defineAction(
    "replace_simpler_sample",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      simplerName: requiredString("Exact Simpler name from inspect_device_tree."),
      simplerPath: optionalDevicePath(),
      source: requiredSampleSource(),
    },
    {
      type: "replace_simpler_sample",
      trackName: "Bass",
      simplerName: "Simpler",
      simplerPath: { deviceIndex: 0 },
      source: { kind: "selected" },
    },
  ),
  configure_drum_pad: defineAction(
    "configure_drum_pad",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      rackName: requiredString("Exact Drum Rack name from inspect_device_tree."),
      rackPath: optionalDevicePath(),
      receivingNote: requiredIntegerInRange(0, 127),
      mode: requiredEnum([
        "fill_empty_pad",
        "replace_existing_simpler",
      ] as const),
      simplerPath: optionalDevicePath(),
      source: requiredSampleSource(),
    },
    {
      type: "configure_drum_pad",
      trackName: "Drums",
      rackName: "Drum Rack",
      rackPath: { deviceIndex: 0 },
      receivingNote: 36,
      mode: "fill_empty_pad",
      source: { kind: "selected" },
    },
  ),
  create_arrangement_audio_clip: defineAction(
    "create_arrangement_audio_clip",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      laneIndex: optionalIntegerInRange(
        0,
        4095,
        "0-based existing Take Lane index. Omit for the track's main Arrangement lane.",
      ),
      laneName: optionalString("Optional expected current Take Lane name guard."),
      source: requiredSampleSource(),
      startBeat: requiredNumber(),
      durationBeats: optionalPositiveNumber(),
      name: optionalString(),
      isWarped: optionalBoolean(),
      loopSettings: optionalClipLoopSettings(),
    },
    {
      type: "create_arrangement_audio_clip",
      trackName: "Audio",
      source: { kind: "selected" },
      startBeat: 0,
      durationBeats: 8,
      name: "Audio Loop",
      isWarped: true,
    },
  ),
  create_session_audio_clip: defineAction(
    "create_session_audio_clip",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      source: requiredSampleSource(),
      slotIndex: requiredIntegerInRange(0, 4095),
      name: optionalString(),
      isWarped: optionalBoolean(),
      loopSettings: optionalClipLoopSettings(),
    },
    {
      type: "create_session_audio_clip",
      trackName: "Audio",
      source: { kind: "selected" },
      slotIndex: 0,
      name: "Audio Loop",
      isWarped: true,
    },
  ),
  set_tempo: defineAction(
    "set_tempo",
    { tempo: requiredNumberInRange(20, 999, "BPM value (20-999).") },
    { type: "set_tempo", tempo: 120 },
  ),
  rename_track: defineAction(
    "rename_track",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      newName: requiredString("New name for the track."),
    },
    { type: "rename_track", trackName: "Track 1", newName: "Bass" },
  ),
  delete_track: defineAction(
    "delete_track",
    { trackName: optionalString(), trackRef: optionalRef() },
    { type: "delete_track", trackName: "Track 1" },
  ),
  duplicate_track: defineAction(
    "duplicate_track",
    { trackName: optionalString(), trackRef: optionalRef() },
    { type: "duplicate_track", trackName: "Lead" },
  ),
  set_track_mute: defineAction(
    "set_track_mute",
    { trackName: optionalString(), trackRef: optionalRef(), mute: requiredBoolean() },
    { type: "set_track_mute", trackName: "Drums", mute: true },
  ),
  set_track_solo: defineAction(
    "set_track_solo",
    { trackName: optionalString(), trackRef: optionalRef(), solo: requiredBoolean() },
    { type: "set_track_solo", trackName: "Lead", solo: true },
  ),
  set_track_arm: defineAction(
    "set_track_arm",
    { trackName: optionalString(), trackRef: optionalRef(), arm: requiredBoolean() },
    { type: "set_track_arm", trackName: "Lead", arm: true },
  ),
  set_track_mixer_parameter: defineAction(
    "set_track_mixer_parameter",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      parameter: requiredEnum(["volume", "panning", "send"] as const),
      sendIndex: optionalInteger(0),
      value: requiredNumber(),
    },
    {
      type: "set_track_mixer_parameter",
      trackName: "Lead",
      parameter: "volume",
      value: 0.75,
    },
  ),
  create_take_lane: defineAction(
    "create_take_lane",
    { trackName: optionalString(), trackRef: optionalRef(), name: optionalString() },
    { type: "create_take_lane", trackName: "Vocals", name: "Take 3" },
  ),
  rename_take_lane: defineAction(
    "rename_take_lane",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      laneIndex: requiredIntegerInRange(0, 4095),
      laneName: optionalString(),
      newName: requiredString("New Take Lane name."),
    },
    {
      type: "rename_take_lane",
      trackName: "Vocals",
      laneIndex: 0,
      laneName: "Take 1",
      newName: "Main Take",
    },
  ),
  set_clip_properties: defineAction(
    "set_clip_properties",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      clipName: optionalString(),
      startBeat: optionalNumber(),
      slotIndex: optionalInteger(0),
      newName: optionalString(),
      looping: optionalBoolean(),
      muted: optionalBoolean(),
      color: optionalInteger(0),
    },
    {
      type: "set_clip_properties",
      trackName: "Lead",
      slotIndex: 0,
      clipName: "Lead Loop",
      newName: "Lead Loop v2",
      looping: true,
    },
  ),
  set_audio_clip_warp: defineAction(
    "set_audio_clip_warp",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      clipName: optionalString(),
      startBeat: optionalNumber(),
      slotIndex: optionalInteger(0),
      warping: optionalBoolean(),
      warpMode: optionalEnum(
        ["beats", "tones", "texture", "repitch", "complex", "complex_pro"] as const,
      ),
    },
    {
      type: "set_audio_clip_warp",
      trackName: "Audio",
      startBeat: 0,
      clipName: "Vocal",
      warping: true,
      warpMode: "complex_pro",
    },
  ),
  clear_arrangement_range: defineAction(
    "clear_arrangement_range",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      startBeat: requiredNumber(),
      endBeat: requiredNumber(),
    },
    {
      type: "clear_arrangement_range",
      trackName: "Audio",
      startBeat: 0,
      endBeat: 16,
    },
  ),
  delete_clip: defineAction(
    "delete_clip",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      clipName: optionalString(),
      startBeat: requiredNumber("Arrangement start beat to disambiguate."),
    },
    { type: "delete_clip", trackName: "Lead", clipName: "Intro", startBeat: 0 },
  ),
  delete_session_clip: defineAction(
    "delete_session_clip",
    {
      trackName: optionalString(),
      trackRef: optionalRef(),
      slotIndex: requiredIntegerInRange(0, 4095),
      clipName: optionalString(),
    },
    {
      type: "delete_session_clip",
      trackName: "Lead",
      slotIndex: 0,
      clipName: "Draft",
    },
  ),
};

type ActionDescriptorUnion = (typeof actionDescriptors)[keyof typeof actionDescriptors];
type ActionFromDescriptor<Descriptor> = Descriptor extends ActionDescriptor<
  infer Type,
  infer Fields
>
  ? ParsedAction<Type, Fields>
  : never;
export type AgentAction = ActionFromDescriptor<ActionDescriptorUnion>;

export function parseAgentAction(action: unknown): AgentAction {
  if (!isRecord(action) || typeof action.type !== "string") {
    throw new Error("Invalid action: missing type.");
  }

  const descriptor = actionDescriptors[
    action.type as keyof typeof actionDescriptors
  ] as ActionDescriptor<string, ActionFields> | undefined;
  if (!descriptor) {
    throw new Error(`Unsupported action type: ${action.type}`);
  }
  try {
    return descriptor.parse(action) as AgentAction;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message} Valid ${descriptor.type} example: ${JSON.stringify(descriptor.example)}.`,
      { cause: error },
    );
  }
}

export function agentActionJsonSchemas(): JsonSchema[] {
  return Object.values(actionDescriptors).map((descriptor) => descriptor.schema);
}

export function agentActionPromptExamples(): string[] {
  return Object.values(actionDescriptors).map(
    (descriptor) => `- ${descriptor.type}: ${JSON.stringify(descriptor.example)}`,
  );
}

export function agentActionExample(actionType: string): string | undefined {
  const descriptor = actionDescriptors[
    actionType as keyof typeof actionDescriptors
  ] as ActionDescriptor<string, ActionFields> | undefined;
  return descriptor ? JSON.stringify(descriptor.example) : undefined;
}

function defineAction<Type extends string, Fields extends ActionFields>(
  type: Type,
  fields: Fields,
  example: ParsedAction<Type, Fields>,
): ActionDescriptor<Type, Fields> {
  const fieldCodec = defineFieldCodec(fields);
  const schema: JsonSchema = {
    type: "object",
    properties: {
      type: { type: "string", enum: [type] },
      ...fieldCodec.properties,
    },
    required: ["type", ...fieldCodec.required],
    additionalProperties: false,
  };

  const descriptor: ActionDescriptor<Type, Fields> = {
    type,
    schema,
    example,
    parse(record) {
      return {
        type,
        ...fieldCodec.parse(record, ["type"], `Action ${type}`),
      } as ParsedAction<Type, Fields>;
    },
  };
  descriptor.parse(example);
  return descriptor;
}

function defineFieldCodec<Fields extends ActionFields>(fields: Fields) {
  const entries = Object.entries(fields);
  const fieldKeys = new Set(Object.keys(fields));
  return {
    properties: Object.fromEntries(
      entries.map(([key, field]) => [key, field.schema]),
    ) as Record<string, JsonSchema>,
    required: entries
      .filter(([, field]) => field.required)
      .map(([key]) => key),
    parse(
      record: Record<string, unknown>,
      extraAllowedKeys: string[],
      entityName: string,
    ): ParsedFields<Fields> {
      const allowedKeys = new Set([...fieldKeys, ...extraAllowedKeys]);
      for (const key of Object.keys(record)) {
        if (!allowedKeys.has(key)) {
          throw new Error(`${entityName} does not support property ${key}.`);
        }
      }

      const parsed: Record<string, unknown> = {};
      for (const [key, field] of entries) {
        const value = field.parse(record[key], key);
        if (value !== undefined) parsed[key] = value;
      }
      return parsed as ParsedFields<Fields>;
    },
  };
}

function requiredString(description?: string): ActionField<string, true> {
  return requiredField(
    { type: "string", minLength: 1, ...(description ? { description } : {}) },
    (value, key) => {
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Action requires string ${key}.`);
      }
      return value.trim();
    },
  );
}

function midiTransformClipFields() {
  return {
    trackName: optionalString(),
    trackRef: optionalRef(),
    clipName: optionalString(),
    startBeat: optionalNumber(),
    slotIndex: optionalInteger(0),
  };
}

function optionalRef(): ActionField<string, false> {
  return optionalField(
    {
      type: "string",
      pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
      description: "Plan-local stable track reference.",
    },
    (value, key) => {
      if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) {
        throw new Error(
          `Action ${key} must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$.`,
        );
      }
      return value;
    },
  );
}

function optionalString(description?: string): ActionField<string, false> {
  return optionalField({
    type: "string",
    minLength: 1,
    ...(description ? { description } : {}),
  }, (value, key) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(
        `${key} must be a non-empty string when provided; omit the field instead of sending an empty string.`,
      );
    }
    return value.trim();
  });
}

function requiredNumber(description?: string): ActionField<number, true> {
  return requiredField(
    { type: "number", ...(description ? { description } : {}) },
    finiteNumber,
  );
}

function requiredPositiveNumber(): ActionField<number, true> {
  return requiredField({ type: "number", exclusiveMinimum: 0 }, (value, key) => {
    const parsed = finiteNumber(value, key);
    if (parsed <= 0) throw new Error(`${key} must be positive.`);
    return parsed;
  });
}

function optionalPositiveNumber(): ActionField<number, false> {
  return optionalField({ type: "number", exclusiveMinimum: 0 }, (value, key) => {
    const parsed = finiteNumber(value, key);
    if (parsed <= 0) throw new Error(`${key} must be positive.`);
    return parsed;
  });
}

function requiredNonNegativeNumber(
  description?: string,
): ActionField<number, true> {
  return requiredField(
    { type: "number", minimum: 0, ...(description ? { description } : {}) },
    (value, key) => {
      const parsed = finiteNumber(value, key);
      if (parsed < 0) throw new Error(`${key} must not be negative.`);
      return parsed;
    },
  );
}

function requiredNumberInRange(
  minimum: number,
  maximum: number,
  description?: string,
): ActionField<number, true> {
  return requiredField(
    {
      type: "number",
      minimum,
      maximum,
      ...(description ? { description } : {}),
    },
    (value, key) => {
      const parsed = finiteNumber(value, key);
      if (parsed < minimum || parsed > maximum) {
        throw new Error(`${key} must be between ${minimum} and ${maximum}.`);
      }
      return parsed;
    },
  );
}

function optionalInteger(
  minimum: number,
  description?: string,
): ActionField<number, false> {
  return optionalField(
    {
      type: "integer",
      minimum,
      ...(description ? { description } : {}),
    },
    (value, key) => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`${key} must be an integer from ${minimum} onward.`);
      }
      return value;
    },
  );
}

function optionalDevicePath(): ActionField<DevicePath, false> {
  return optionalField(devicePathSchema(), parseDevicePath);
}

function requiredSampleSource(): ActionField<SampleSource, true> {
  return requiredField(
    {
      oneOf: [
        {
          type: "object",
          properties: { kind: { type: "string", enum: ["selected"] } },
          required: ["kind"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["arrangement_audio_clip"] },
            trackName: { type: "string", minLength: 1 },
            startBeat: { type: "number" },
            clipName: { type: "string", minLength: 1 },
          },
          required: ["kind", "trackName", "startBeat"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["session_audio_clip"] },
            trackName: { type: "string", minLength: 1 },
            slotIndex: { type: "integer", minimum: 0 },
            clipName: { type: "string", minLength: 1 },
          },
          required: ["kind", "trackName", "slotIndex"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["simpler"] },
            trackName: { type: "string", minLength: 1 },
            deviceName: { type: "string", minLength: 1 },
            devicePath: devicePathSchema(),
            deviceIndex: { type: "integer", minimum: 0 },
          },
          required: ["kind", "trackName", "deviceName"],
          additionalProperties: false,
        },
      ],
      description: "Observed Live sample source. Filesystem paths are never accepted.",
    },
    parseSampleSource,
  );
}

function requiredEnum<const Values extends readonly string[]>(
  values: Values,
): ActionField<Values[number], true> {
  return requiredField({ type: "string", enum: [...values] }, (value, key) => {
    if (typeof value !== "string" || !values.includes(value)) {
      throw new Error(`${key} must be one of ${values.join(", ")}.`);
    }
    return value as Values[number];
  });
}

function optionalEnum<const Values extends readonly string[]>(
  values: Values,
): ActionField<Values[number], false> {
  return optionalField({ type: "string", enum: [...values] }, (value, key) => {
    if (typeof value !== "string" || !values.includes(value)) {
      throw new Error(`${key} must be one of ${values.join(", ")}.`);
    }
    return value as Values[number];
  });
}

function optionalClipLoopSettings(): ActionField<ClipLoopSettingsInput, false> {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      looping: { type: "boolean" },
      startMarker: { type: "number" },
      endMarker: { type: "number" },
      loopStart: { type: "number" },
      loopEnd: { type: "number" },
    },
    required: ["looping", "startMarker", "endMarker", "loopStart", "loopEnd"],
    additionalProperties: false,
  };
  return optionalField(schema, (value, key) => {
    if (!isRecord(value)) throw new Error(`${key} must be an object.`);
    assertRecordKeys(
      value,
      ["looping", "startMarker", "endMarker", "loopStart", "loopEnd"],
      key,
    );
    if (typeof value.looping !== "boolean") {
      throw new Error(`${key}.looping must be a boolean.`);
    }
    return {
      looping: value.looping,
      startMarker: finiteNumber(value.startMarker, `${key}.startMarker`),
      endMarker: finiteNumber(value.endMarker, `${key}.endMarker`),
      loopStart: finiteNumber(value.loopStart, `${key}.loopStart`),
      loopEnd: finiteNumber(value.loopEnd, `${key}.loopEnd`),
    };
  });
}

function devicePathSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      deviceIndex: { type: "integer", minimum: 0 },
      nested: {
        type: "array",
        items: {
          type: "object",
          properties: {
            chainIndex: { type: "integer", minimum: 0 },
            deviceIndex: { type: "integer", minimum: 0 },
          },
          required: ["chainIndex", "deviceIndex"],
          additionalProperties: false,
        },
      },
    },
    required: ["deviceIndex"],
    additionalProperties: false,
  };
}

function parseDevicePath(value: unknown, key: string): DevicePath {
  if (!isRecord(value)) throw new Error(`${key} must be an object.`);
  assertRecordKeys(value, ["deviceIndex", "nested"], key);
  const deviceIndex = integerInRange(
    value.deviceIndex,
    `${key}.deviceIndex`,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (value.nested !== undefined && !Array.isArray(value.nested)) {
    throw new Error(`${key}.nested must be an array.`);
  }
  const nested = (value.nested ?? []).map((item, index) => {
    if (!isRecord(item)) throw new Error(`${key}.nested[${index}] must be an object.`);
    assertRecordKeys(item, ["chainIndex", "deviceIndex"], `${key}.nested[${index}]`);
    return {
      chainIndex: integerInRange(
        item.chainIndex,
        `${key}.nested[${index}].chainIndex`,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      deviceIndex: integerInRange(
        item.deviceIndex,
        `${key}.nested[${index}].deviceIndex`,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    };
  });
  return { deviceIndex, ...(nested.length ? { nested } : {}) };
}

function parseSampleSource(value: unknown, key: string): SampleSource {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error(`${key} requires a source object with kind.`);
  }
  switch (value.kind) {
    case "selected":
      assertRecordKeys(value, ["kind"], key);
      return { kind: "selected" };
    case "arrangement_audio_clip": {
      assertRecordKeys(value, ["kind", "trackName", "startBeat", "clipName"], key);
      return {
        kind: "arrangement_audio_clip",
        trackName: parseInlineString(value.trackName, `${key}.trackName`),
        startBeat: finiteNumber(value.startBeat, `${key}.startBeat`),
        ...parseInlineOptionalString(value.clipName, `${key}.clipName`),
      };
    }
    case "session_audio_clip": {
      assertRecordKeys(value, ["kind", "trackName", "slotIndex", "clipName"], key);
      return {
        kind: "session_audio_clip",
        trackName: parseInlineString(value.trackName, `${key}.trackName`),
        slotIndex: integerInRange(
          value.slotIndex,
          `${key}.slotIndex`,
          0,
          Number.MAX_SAFE_INTEGER,
        ),
        ...parseInlineOptionalString(value.clipName, `${key}.clipName`),
      };
    }
    case "simpler": {
      assertRecordKeys(
        value,
        ["kind", "trackName", "deviceName", "devicePath", "deviceIndex"],
        key,
      );
      return {
        kind: "simpler",
        trackName: parseInlineString(value.trackName, `${key}.trackName`),
        deviceName: parseInlineString(value.deviceName, `${key}.deviceName`),
        ...(value.devicePath === undefined
          ? {}
          : { devicePath: parseDevicePath(value.devicePath, `${key}.devicePath`) }),
        ...(value.deviceIndex === undefined
          ? {}
          : {
              deviceIndex: integerInRange(
                value.deviceIndex,
                `${key}.deviceIndex`,
                0,
                Number.MAX_SAFE_INTEGER,
              ),
            }),
      };
    }
    default:
      throw new Error(`${key}.kind is unsupported.`);
  }
}

function parseInlineString(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value.trim();
}

function parseInlineOptionalString(
  value: unknown,
  key: string,
): { clipName?: string } {
  return value === undefined ? {} : { clipName: parseInlineString(value, key) };
}

function assertRecordKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((name) => !allowedSet.has(name));
  if (unknown) throw new Error(`${label} does not support property ${unknown}.`);
}

function requiredBoolean(): ActionField<boolean, true> {
  return requiredField({ type: "boolean" }, (value, key) => {
    if (typeof value !== "boolean") {
      throw new Error(`Action requires boolean ${key}.`);
    }
    return value;
  });
}

function requiredNotes(minimumItems: number): ActionField<NoteDescription[], true> {
  const maximumItems = 4096;
  const noteCodec = defineFieldCodec({
    pitch: requiredIntegerInRange(0, 127),
    startTime: requiredNumber(),
    duration: requiredPositiveNumber(),
    velocity: requiredIntegerInRange(1, 127),
    muted: optionalBoolean(),
    probability: optionalNumber(),
    velocityDeviation: optionalNumber(),
    releaseVelocity: optionalNumber(),
  });
  return requiredField(
    {
      type: "array",
      minItems: minimumItems,
      maxItems: maximumItems,
      items: {
        type: "object",
        properties: noteCodec.properties,
        required: noteCodec.required,
        additionalProperties: false,
      },
    },
    (value) => {
      if (!Array.isArray(value) || value.length < minimumItems) {
        throw new Error(`MIDI action requires at least ${minimumItems} notes.`);
      }
      if (value.length > maximumItems) {
        throw new Error(`MIDI action supports at most ${maximumItems} notes.`);
      }
      return value.map((note) => {
        if (!isRecord(note)) throw new Error("Invalid note.");
        return noteCodec.parse(note, [], "Note") as NoteDescription;
      });
    },
  );
}

function requiredIntegerInRange(
  minimum: number,
  maximum: number,
  description?: string,
): ActionField<number, true> {
  return requiredField(
    {
      type: "integer",
      minimum,
      maximum,
      ...(description ? { description } : {}),
    },
    (value, key) => integerInRange(value, key, minimum, maximum),
  );
}

function optionalIntegerInRange(
  minimum: number,
  maximum: number,
  description?: string,
): ActionField<number, false> {
  return optionalField(
    {
      type: "integer",
      minimum,
      maximum,
      ...(description ? { description } : {}),
    },
    (value, key) => integerInRange(value, key, minimum, maximum),
  );
}

function optionalBoolean(): ActionField<boolean, false> {
  return optionalField({ type: "boolean" }, (value, key) => {
    if (typeof value !== "boolean") {
      throw new Error(`${key} must be a boolean when provided.`);
    }
    return value;
  });
}

function optionalNumber(): ActionField<number, false> {
  return optionalField({ type: "number" }, (value, key) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${key} must be a finite number when provided.`);
    }
    return value;
  });
}

function requiredField<Value>(
  schema: JsonSchema,
  parser: (value: unknown, key: string) => Value,
): ActionField<Value, true> {
  return {
    required: true,
    schema,
    parse(value, key) {
      return parser(value, key);
    },
  };
}

function optionalField<Value>(
  schema: JsonSchema,
  parser: (value: unknown, key: string) => Value,
): ActionField<Value, false> {
  return {
    required: false,
    schema,
    parse(value, key) {
      return value === undefined ? undefined : parser(value, key);
    },
  };
}

function finiteNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Action requires number ${key}.`);
  }
  return value;
}

function integerInRange(
  value: unknown,
  key: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
