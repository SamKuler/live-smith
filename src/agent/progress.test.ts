import assert from "node:assert/strict";
import test from "node:test";

import { progressLabelForActionPlan, progressLabelForToolCall } from "./progress.js";

test("progressLabelForToolCall names inspect targets", () => {
  assert.equal(
    progressLabelForToolCall({
      id: "1",
      name: "inspect_device",
      arguments: '{"trackName":"Future Bass","deviceName":"Operator","deviceIndex":0}',
    }),
    'Inspecting Operator[0] on "Future Bass"',
  );
});

test("progressLabelForActionPlan summarizes action counts", () => {
  assert.equal(
    progressLabelForActionPlan({
      message: "Apply",
      actions: [{ type: "create_midi_track", name: "Future Bass" }],
    }),
    "Applying 1 Live action",
  );
});

test("progress labels identify object-aware inspections", () => {
  assert.equal(
    progressLabelForToolCall({
      id: "tree",
      name: "inspect_device_tree",
      arguments: '{"trackName":"Drums","deviceName":"Drum Rack"}',
    }),
    'Inspecting Drum Rack device tree on "Drums"',
  );
  assert.equal(
    progressLabelForToolCall({ id: "mixer", name: "inspect_mixer", arguments: "{}" }),
    "Inspecting selected track mixer",
  );
  assert.equal(
    progressLabelForToolCall({
      id: "return-mixer",
      name: "inspect_mixer",
      arguments: '{"trackRole":"return","trackIndex":1,"trackName":"B-Reverb"}',
    }),
    'Inspecting mixer on Return track index 1 "B-Reverb"',
  );
  assert.equal(
    progressLabelForToolCall({ id: "object", name: "inspect_current_object", arguments: "{}" }),
    "Inspecting selected Live object",
  );
  assert.equal(
    progressLabelForToolCall({ id: "song", name: "inspect_song_info", arguments: "{}" }),
    "Inspecting song settings and markers",
  );
  assert.equal(
    progressLabelForToolCall({
      id: "audio",
      name: "analyze_audio_clip",
      arguments: '{"clipName":"Vocal"}',
    }),
    'Analyzing pre-FX audio for "Vocal"',
  );
  assert.equal(
    progressLabelForToolCall({
      id: "read-audio",
      name: "read_arrangement_audio",
      arguments: '{"clipName":"Reference"}',
    }),
    'Reading pre-FX audio for "Reference"',
  );
});
