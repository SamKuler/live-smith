import assert from "node:assert/strict";
import test from "node:test";

import { agentActionJsonSchemas } from "./action-schema.js";
import { liveSmithTools } from "./tool-definitions.js";

test("apply_live_actions exposes every validated action schema", () => {
  const actionTypes = agentActionJsonSchemas().map((schema) => {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    return (properties.type?.enum as string[])[0];
  });

  assert.deepEqual(actionTypes.sort(), [
    "clear_arrangement_range",
    "configure_drum_pad",
    "create_arrangement_audio_clip",
    "create_audio_track",
    "create_cue_point",
    "create_midi_clip",
    "create_midi_track",
    "create_scene",
    "create_session_audio_clip",
    "create_session_midi_clip",
    "create_take_lane",
    "delete_clip",
    "delete_cue_point",
    "delete_device",
    "delete_scene",
    "delete_session_clip",
    "delete_track",
    "duplicate_device",
    "duplicate_scene",
    "duplicate_track",
    "insert_chain_device",
    "insert_device",
    "quantize_midi_notes",
    "rename_cue_point",
    "rename_scene",
    "rename_take_lane",
    "rename_track",
    "replace_midi_clip_segment",
    "replace_simpler_sample",
    "scale_midi_velocity",
    "set_audio_clip_warp",
    "set_clip_properties",
    "set_device_parameter",
    "set_tempo",
    "set_track_arm",
    "set_track_mixer_parameter",
    "set_track_mute",
    "set_track_solo",
    "shift_midi_notes",
    "transpose_midi_notes",
  ]);

  const applyTool = liveSmithTools().find(
    (tool) => tool.function.name === "apply_live_actions",
  );
  const parameters = applyTool?.function.parameters as {
    properties?: {
      actions?: { items?: { anyOf?: unknown[] } };
      targets?: { additionalProperties?: unknown };
      resolvesPriorFailure?: { type?: unknown };
    };
  };
  assert.equal(parameters.properties?.actions?.items?.anyOf?.length, actionTypes.length);
  assert.ok(parameters.properties?.targets?.additionalProperties);
  assert.equal(parameters.properties?.resolvesPriorFailure?.type, "boolean");

  for (const type of ["create_midi_clip", "create_arrangement_audio_clip"]) {
    const schema = agentActionJsonSchemas().find(
      (candidate) =>
        (candidate.properties as { type?: { enum?: string[] } }).type?.enum?.[0] === type,
    );
    const properties = schema?.properties as Record<string, Record<string, unknown>>;
    assert.equal(properties.laneIndex?.type, "integer");
    assert.equal(properties.laneIndex?.minimum, 0);
    assert.equal(properties.laneIndex?.maximum, 4095);
    assert.equal(properties.laneName?.type, "string");
  }
});

test("Live tools expose object-aware inspection without raw filesystem inputs", () => {
  const tools = new Map(
    liveSmithTools().map((tool) => [tool.function.name, tool.function]),
  );

  for (const name of [
    "inspect_current_object",
    "inspect_take_lane",
    "inspect_device_tree",
    "inspect_mixer",
    "inspect_clip",
    "analyze_audio_clip",
  ]) {
    assert.ok(tools.has(name), `${name} should be available`);
  }

  const serialized = JSON.stringify([...tools.values()]);
  assert.doesNotMatch(serialized, /filePath|absolute path/i);

  const inspectDevice = tools.get("inspect_device")?.parameters as {
    properties?: Record<string, unknown>;
  };
  assert.ok(inspectDevice.properties?.parameterOffset);
  assert.ok(inspectDevice.properties?.valueItemOffset);

  const inspectTree = tools.get("inspect_device_tree")?.parameters as {
    properties?: Record<string, unknown>;
  };
  assert.ok(inspectTree.properties?.itemOffset);
  assert.ok(inspectTree.properties?.parameterLimit);

  const inspectLane = tools.get("inspect_take_lane")?.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  assert.ok(inspectLane.properties?.itemOffset);
  assert.deepEqual(inspectLane.required, ["laneIndex"]);

  const inspectSong = tools.get("inspect_song_info")?.parameters as {
    properties?: Record<string, unknown>;
  };
  assert.ok(inspectSong.properties?.itemOffset);
  assert.ok(inspectSong.properties?.itemLimit);

  const inspectClip = tools.get("inspect_clip")?.parameters as {
    properties?: Record<string, unknown>;
  };
  assert.ok(inspectClip.properties?.itemOffset);
  assert.ok(inspectClip.properties?.itemLimit);

  for (const name of [
    "inspect_track",
    "inspect_device",
    "inspect_device_tree",
    "inspect_mixer",
  ]) {
    const parameters = tools.get(name)?.parameters as {
      properties?: Record<string, unknown>;
    };
    assert.ok(parameters.properties?.trackRole, `${name} trackRole`);
    assert.ok(parameters.properties?.trackIndex, `${name} trackIndex`);
  }

  const analyzeAudio = tools.get("analyze_audio_clip")?.parameters as {
    properties?: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(analyzeAudio.properties ?? {}).sort(), [
    "clipName",
    "startBeat",
    "trackName",
  ]);
});

test("audio-capable Live tools expose bounded Arrangement audio input", () => {
  const ordinary = new Set(
    liveSmithTools().map((tool) => tool.function.name),
  );
  assert.equal(ordinary.has("read_arrangement_audio"), false);

  const tools = new Map(
    liveSmithTools({ readArrangementAudio: true }).map((tool) => [
      tool.function.name,
      tool.function,
    ]),
  );
  const readAudio = tools.get("read_arrangement_audio")?.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  assert.ok(readAudio);
  assert.deepEqual(Object.keys(readAudio.properties ?? {}).sort(), [
    "clipName",
    "clipStartBeat",
    "endBeat",
    "startBeat",
    "trackName",
  ]);
  assert.doesNotMatch(JSON.stringify(readAudio), /filePath|absolute path/i);
  assert.deepEqual(readAudio.required, ["startBeat", "endBeat"]);
});
