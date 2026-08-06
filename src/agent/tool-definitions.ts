import type { ModelTool } from "../model/provider.js";
import { agentActionJsonSchemas } from "./action-schema.js";

export function liveSmithTools(): ModelTool[] {
  return [
    observationTool(
      "inspect_current_object",
      "Inspect the exact Live object used to open this Session, including its current type-specific state. This does not change the Set.",
    ),
    observationTool(
      "inspect_live_set",
      "Inspect the Live set structure, including tracks and the names of devices on each track. This does not change the set.",
    ),
    observationTool(
      "inspect_track",
      "Inspect a track, including clips and device names. Use this before editing a track if the exact device chain is unknown.",
      {
        trackName: {
          type: "string",
          description:
            "Optional track name. Omit it to inspect the current target track from the Live selection.",
        },
      },
    ),
    observationTool(
      "inspect_device",
      "Inspect a Live device and return its exact exposed parameter names, ranges, current values, defaults, and value items. Always use this before setting a device parameter unless the exact parameter list is already in the current context.",
      {
        trackName: {
          type: "string",
          description:
            "Optional track name. Omit it to use the current target track from the Live selection.",
        },
        deviceName: {
          type: "string",
          description: 'The Live device name, for example "Auto Filter".',
        },
        deviceIndex: {
          type: "integer",
          minimum: 0,
          description:
            "Optional 0-based position in the track device chain. Use this when multiple devices have the same name.",
        },
      },
      ["deviceName"],
    ),
    observationTool(
      "inspect_device_tree",
      "Inspect a complete top-level or nested device tree, including Rack chains, Drum Rack receiving notes, Simpler sample names, exact device paths, and exposed parameters. Omit the locator to inspect the selected Device or all devices on the selected Track.",
      {
        trackName: {
          type: "string",
          description: "Optional Track name. Omit it to use the selected object's owning Track.",
        },
        deviceName: {
          type: "string",
          description: "Optional expected Device name for selecting one device subtree.",
        },
        devicePath: devicePathSchema(),
      },
    ),
    observationTool(
      "inspect_mixer",
      "Inspect the selected or named Track mixer and return exact Volume, Panning, and Send parameter ranges and current values.",
      {
        trackName: {
          type: "string",
          description: "Optional Track name. Omit it to use the selected object's owning Track.",
        },
      },
    ),
    observationTool(
      "inspect_clip",
      "Inspect a MIDI or Audio Clip in Arrangement or Session View, including common properties and type-specific notes, warp state, or sample filename. Omit the locator to inspect the selected Clip.",
      {
        trackName: { type: "string" },
        clipName: { type: "string" },
        startBeat: {
          type: "number",
          description: "Arrangement Clip start beat. Do not combine with slotIndex.",
        },
        slotIndex: {
          type: "integer",
          minimum: 0,
          description: "0-based Session View Clip Slot index. Do not combine with startBeat.",
        },
      },
    ),
    observationTool(
      "inspect_midi_clip",
      "Inspect a MIDI clip and return its exact notes with pitch numbers, note names, start times, durations, and velocities. Use this before judging chord correctness or rewriting MIDI notes.",
      {
        trackName: {
          type: "string",
          description:
            "Optional track name. Omit it to use the current target track from the Live selection.",
        },
        clipName: {
          type: "string",
          description:
            "Optional clip name. Omit it to inspect the currently selected MIDI clip when available.",
        },
        startBeat: {
          type: "number",
          description:
            "Optional arrangement start beat for disambiguating clips with the same name.",
        },
        noteOffset: {
          type: "integer",
          minimum: 0,
          description:
            "0-based note offset for paginating long clips. Continue with the next offset reported by the tool until no later notes are omitted.",
        },
        noteLimit: {
          type: "integer",
          minimum: 1,
          maximum: 256,
          description: "Notes to return in this page. Defaults to 128 and is capped at 256.",
        },
      },
    ),
    observationTool(
      "inspect_song_info",
      "Inspect the song-level settings: tempo, scale, grid quantization, zero-based Scene indexes, and Cue Points. Use this before setting tempo or editing Scenes and Cue Points.",
    ),
    {
      type: "function",
      function: {
        name: "apply_live_actions",
        description:
          "Propose a batch of Live Set edits. The extension asks once for this batch. Use stable targets/trackRef dependencies inside one batch, or make staged calls when newly created Live state must be inspected. Device names are exact built-in names and are accepted or rejected by the current Live host during execution.",
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              minLength: 1,
              description: "Short explanation of the intended Live changes.",
            },
            targets: {
              type: "object",
              description:
                "Optional stable refs for existing tracks. Later actions use trackRef so renaming does not change identity.",
              propertyNames: {
                pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
              },
              additionalProperties: {
                type: "object",
                properties: {
                  trackName: {
                    type: "string",
                    minLength: 1,
                    description: "Current unambiguous Live track name.",
                  },
                },
                required: ["trackName"],
                additionalProperties: false,
              },
            },
            actions: {
              type: "array",
              minItems: 1,
              description: "Live actions to apply after user confirmation.",
              items: { anyOf: agentActionJsonSchemas() },
            },
          },
          required: ["message", "actions"],
          additionalProperties: false,
        },
      },
    },
  ];
}

function devicePathSchema(): Record<string, unknown> {
  return {
    type: "object",
    description: "Structural path returned by inspect_device_tree.",
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

function observationTool(
  name: string,
  description: string,
  properties: Record<string, Record<string, unknown>> = {},
  required: string[] = [],
): ModelTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      },
    },
  };
}
