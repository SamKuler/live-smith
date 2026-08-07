import assert from "node:assert/strict";
import test from "node:test";

import { actionDiffGroups } from "./action-diff.js";

test("actionDiffGroups preserves authored order and original action numbers", () => {
  const groups = actionDiffGroups([
    { type: "delete_track", trackName: "Scratch" },
    { type: "create_midi_track", name: "Replacement" },
    { type: "set_tempo", tempo: 132 },
    { type: "delete_scene", sceneIndex: 7, sceneName: "Draft" },
  ]);

  assert.deepEqual(
    groups.map((group) => ({ title: group.title, rows: group.rows })),
    [
      { title: "Delete", rows: ['1. - track "Scratch"'] },
      { title: "Create", rows: ['2. + MIDI track "Replacement"'] },
      { title: "Song", rows: ["3. ~ Tempo = 132 BPM"] },
      {
        title: "Delete",
        rows: ['4. - Session View Scene 7 "Draft"'],
      },
    ],
  );
});

test("actionDiffGroups includes every supported mutating action", () => {
  const groups = actionDiffGroups([
    { type: "create_midi_track", name: "Future Bass" },
    {
      type: "insert_device",
      trackName: "Future Bass",
      deviceName: "Operator",
      index: 0,
    },
    {
      type: "set_device_parameter",
      trackName: "Future Bass",
      deviceName: "Operator",
      deviceIndex: 0,
      parameterName: "Volume",
      value: 0.7,
    },
    {
      type: "create_midi_clip",
      trackName: "Future Bass",
      startBeat: 0,
      durationBeats: 8,
      notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 96 }],
    },
    {
      type: "replace_midi_clip_segment",
      trackName: "Future Bass",
      clipName: "Full arrangement",
      startBeat: 0,
      segmentStartTime: 16,
      segmentDurationBeats: 16,
      notes: [{ pitch: 67, startTime: 16, duration: 1, velocity: 96 }],
    },
    { type: "set_tempo", tempo: 128 },
    { type: "rename_track", trackName: "Future Bass", newName: "Bass" },
    { type: "duplicate_track", trackName: "Bass" },
    { type: "set_track_mute", trackName: "Bass", mute: true },
    { type: "set_track_solo", trackName: "Bass", solo: false },
    { type: "delete_clip", trackName: "Bass", clipName: "Draft", startBeat: 16 },
    { type: "delete_track", trackName: "Scratch" },
  ]);

  assert.deepEqual(
    groups.map((group) => group.title),
    [
      "Create",
      "Insert Devices",
      "Set Parameters",
      "Write MIDI",
      "Song",
      "Track Changes",
      "Delete",
    ],
  );
  assert.match(
    groups.find((group) => group.title === "Write MIDI")?.rows[0] ?? "",
    /create or replace.*beat 0.*1 notes.*8 beats/i,
  );
  assert.match(
    groups.find((group) => group.title === "Write MIDI")?.rows[1] ?? "",
    /replace.*Full arrangement.*relative beats 16-32.*1 notes/i,
  );
  assert.deepEqual(groups.at(-1)?.rows, [
    '11. - Arrangement clip "Draft" on track "Bass" at beat 16',
    '12. - track "Scratch"',
  ]);
});

test("actionDiffGroups resolves existing refs to readable current labels", () => {
  const groups = actionDiffGroups(
    [
      { type: "rename_track", trackRef: "pads", newName: "Dream Pads" },
      { type: "insert_device", trackRef: "pads", deviceName: "Auto Filter" },
    ],
    { pads: { trackName: "1-MIDI" } },
  );

  assert.match(
    groups.find((group) => group.title === "Track Changes")?.rows[0] ?? "",
    /1-MIDI.*ref pads.*Dream Pads/,
  );
  assert.match(
    groups.find((group) => group.title === "Insert Devices")?.rows[0] ?? "",
    /Dream Pads.*ref pads/,
  );
});

test("actionDiffGroups labels actions that consume a creator ref", () => {
  const groups = actionDiffGroups([
    { type: "create_midi_track", ref: "instrument", name: "AI Instrument" },
    { type: "insert_device", trackRef: "instrument", deviceName: "Auto Filter" },
  ]);

  assert.match(groups[0]?.rows[0] ?? "", /AI Instrument.*ref instrument/);
  assert.match(groups[1]?.rows[0] ?? "", /AI Instrument.*ref instrument/);
});

test("actionDiffGroups discloses Rack, sample, mixer, arm, and device lifecycle changes", () => {
  const groups = actionDiffGroups([
    {
      type: "insert_chain_device",
      trackName: "Drums",
      rackName: "Drum Rack",
      rackPath: { deviceIndex: 0 },
      chainIndex: 0,
      deviceName: "Simpler",
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
    {
      type: "set_track_mixer_parameter",
      trackName: "Drums",
      parameter: "send",
      sendIndex: 0,
      value: 0.5,
    },
    { type: "set_track_arm", trackName: "Drums", arm: true },
    {
      type: "delete_device",
      trackName: "Drums",
      deviceName: "Old Rack",
      devicePath: { deviceIndex: 2 },
    },
  ]);

  assert.match(
    groups.find((group) => group.title === "Insert Devices")?.rows[0] ?? "",
    /Simpler.*chain 0.*Drum Rack/i,
  );
  assert.match(
    groups.find((group) => group.title === "Rack & Samples")?.rows[0] ?? "",
    /fill empty.*pad 36.*selected Live object/i,
  );
  assert.match(
    groups.find((group) => group.title === "Set Parameters")?.rows[0] ?? "",
    /send\[0\].*0\.5/i,
  );
  assert.match(
    groups.find((group) => group.title === "Track Changes")?.rows[0] ?? "",
    /Arm.*Drums/i,
  );
  assert.match(
    groups.find((group) => group.title === "Delete")?.rows[0] ?? "",
    /Old Rack.*deviceIndex.*2/i,
  );
});

test("actionDiffGroups discloses Arrangement and Session clip writes and destructive ranges", () => {
  const groups = actionDiffGroups([
    {
      type: "create_session_midi_clip",
      trackName: "Lead",
      slotIndex: 1,
      durationBeats: 8,
      name: "Lead Loop",
      notes: [],
    },
    {
      type: "create_arrangement_audio_clip",
      trackName: "Audio",
      source: { kind: "selected" },
      startBeat: 16,
      durationBeats: 8,
      name: "Vocal",
    },
    {
      type: "create_session_audio_clip",
      trackName: "Audio",
      source: { kind: "selected" },
      slotIndex: 2,
      name: "Warped Loop",
      isWarped: true,
      loopSettings: {
        looping: true,
        startMarker: 0,
        endMarker: 8,
        loopStart: 2,
        loopEnd: 6,
      },
    },
    {
      type: "set_audio_clip_warp",
      trackName: "Audio",
      startBeat: 16,
      clipName: "Vocal",
      warping: true,
      warpMode: "complex_pro",
    },
    {
      type: "delete_session_clip",
      trackName: "Lead",
      slotIndex: 1,
      clipName: "Draft",
    },
    {
      type: "clear_arrangement_range",
      trackName: "Audio",
      startBeat: 32,
      endBeat: 64,
    },
  ]);

  assert.match(
    groups.find((group) => group.title === "Write MIDI")?.rows[0] ?? "",
    /Session MIDI.*slot 1/i,
  );
  assert.match(
    groups.find((group) => group.title === "Write Audio")?.rows[0] ?? "",
    /Vocal.*beat 16.*8 beats.*selected/i,
  );
  assert.match(
    groups.find((group) => group.title === "Write Audio")?.rows[1] ?? "",
    /create or replace.*Warped Loop.*slot 2.*warped=true.*loop=2-6.*deletes and recreates/i,
  );
  assert.match(
    groups.find((group) => group.title === "Clip Changes")?.rows[0] ?? "",
    /warping=true.*complex_pro/i,
  );
  assert.equal(
    groups.find((group) => group.title === "Delete")?.rows.length,
    2,
  );
  assert.match(
    groups.find((group) => group.title === "Delete")?.rows[1] ?? "",
    /32.*64.*truncate/i,
  );
});

test("actionDiffGroups shows exact arrangement and Simpler sample-source locators", () => {
  const groups = actionDiffGroups([
    {
      type: "replace_simpler_sample",
      trackName: "Drums",
      simplerName: "Target Simpler",
      simplerPath: { deviceIndex: 0 },
      source: {
        kind: "arrangement_audio_clip",
        trackName: "Audio",
        clipName: "Kick Source",
        startBeat: 64,
      },
    },
    {
      type: "configure_drum_pad",
      trackName: "Drums",
      rackName: "Drum Rack",
      rackPath: { deviceIndex: 1 },
      receivingNote: 36,
      mode: "fill_empty_pad",
      source: {
        kind: "simpler",
        trackName: "Sources",
        deviceName: "Source Simpler",
        devicePath: {
          deviceIndex: 2,
          nested: [{ chainIndex: 0, deviceIndex: 1 }],
        },
      },
    },
  ]);

  const rows = groups.find((group) => group.title === "Rack & Samples")?.rows ?? [];
  assert.match(rows[0] ?? "", /Kick Source.*beat 64.*Audio/i);
  assert.match(rows[1] ?? "", /Source Simpler.*deviceIndex.*2.*chainIndex.*0/i);
});

test("actionDiffGroups distinguishes Session View Scenes from Arrangement Cue Points", () => {
  const groups = actionDiffGroups([
    { type: "rename_scene", sceneIndex: 0, sceneName: "Intro", newName: "Verse" },
    { type: "duplicate_scene", sceneIndex: 0 },
    { type: "create_cue_point", timeBeat: 16, name: "Drop" },
    { type: "rename_cue_point", timeBeat: 16, cueName: "Drop", newName: "Drop 1" },
    { type: "create_take_lane", trackName: "Vocals", name: "Take 3" },
    {
      type: "rename_take_lane",
      trackName: "Vocals",
      laneIndex: 0,
      laneName: "Take 1",
      newName: "Main Take",
    },
    { type: "delete_scene", sceneIndex: 1, sceneName: "Draft" },
    { type: "delete_cue_point", timeBeat: 32, cueName: "Old Drop" },
  ]);

  const rowsFor = (title: string) => groups
    .filter((group) => group.title === title)
    .flatMap((group) => group.rows);
  assert.equal(rowsFor("Create").length, 2);
  assert.match(
    rowsFor("Create").join("\n"),
    /Arrangement Cue Point.*Drop/i,
  );
  assert.match(
    rowsFor("Song").join("\n"),
    /Session View Scene 0.*Verse.*Duplicate Session View Scene.*Arrangement Cue Point.*Drop 1/is,
  );
  assert.match(
    rowsFor("Track Changes")[0] ?? "",
    /Take Lane 0.*Vocals.*Main Take/i,
  );
  assert.match(
    rowsFor("Delete").join("\n"),
    /Session View Scene 1.*Draft.*Arrangement Cue Point.*Old Drop/is,
  );
});
