import assert from "node:assert/strict";
import test from "node:test";

import { actionDiffGroups } from "./action-diff.js";

test("Session MIDI confirmation distinguishes empty-slot creation from replacement", () => {
  const action = {
    type: "create_session_midi_clip" as const,
    trackRef: "lead",
    slotIndex: 2,
    durationBeats: 4,
    name: "Alternative",
    notes: [],
  };
  const groups = actionDiffGroups([
    action,
    { ...action, requireEmpty: false },
    { ...action, requireEmpty: true },
  ], { lead: { trackName: "Lead" } });
  assert.deepEqual(groups, [{
    title: "Write MIDI",
    rows: [
      '1. ± Create or replace Session MIDI clip "Alternative" in slot 2 on track "Lead" (ref lead) (0 notes, 4 beats)',
      '2. ± Create or replace Session MIDI clip "Alternative" in slot 2 on track "Lead" (ref lead) (0 notes, 4 beats)',
      '3. + Create Session MIDI clip "Alternative" in empty slot 2 on track "Lead" (ref lead) (0 notes, 4 beats)',
    ],
  }]);
});

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

test("actionDiffGroups labels Return and Main target refs", () => {
  const groups = actionDiffGroups(
    [
      { type: "insert_device", trackRef: "bus", deviceName: "Utility" },
      {
        type: "set_track_mixer_parameter",
        trackRef: "main",
        parameter: "volume",
        value: 0.8,
      },
    ],
    {
      bus: { trackRole: "return", trackIndex: 0, trackName: "A-Reverb" },
      main: { trackRole: "main", trackName: "Master Bus" },
    },
  );

  assert.match(groups[0]?.rows[0] ?? "", /Return track index 0.*A-Reverb.*ref bus/i);
  assert.match(groups[1]?.rows[0] ?? "", /Main track.*Master Bus.*ref main/i);

  const unnamed = actionDiffGroups(
    [
      { type: "insert_device", trackRef: "bus", deviceName: "Utility" },
      { type: "insert_device", trackRef: "main", deviceName: "Limiter" },
    ],
    {
      bus: { trackRole: "return", trackIndex: 0 },
      main: { trackRole: "main" },
    },
  );
  assert.match(unnamed[0]?.rows[0] ?? "", /Return track index 0 \(ref bus\)/);
  assert.match(unnamed[0]?.rows[1] ?? "", /Main track \(ref main\)/);
});

test("actionDiffGroups labels actions that consume a creator ref", () => {
  const groups = actionDiffGroups([
    { type: "create_midi_track", ref: "instrument", name: "AI Instrument" },
    { type: "insert_device", trackRef: "instrument", deviceName: "Auto Filter" },
  ]);

  assert.match(groups[0]?.rows[0] ?? "", /AI Instrument.*ref instrument/);
  assert.match(groups[1]?.rows[0] ?? "", /AI Instrument.*ref instrument/);
});

test("actionDiffGroups discloses whole-Clip MIDI transforms", () => {
  const groups = actionDiffGroups([
    {
      type: "transpose_midi_notes",
      trackName: "Lead",
      clipName: "Verse",
      startBeat: 8,
      semitones: -12,
    },
    {
      type: "quantize_midi_notes",
      trackName: "Lead",
      slotIndex: 0,
      gridBeats: 0.25,
      strength: 0.75,
    },
  ]);

  assert.equal(groups[0]?.title, "Transform MIDI");
  assert.match(groups[0]?.rows[0] ?? "", /Verse.*arrangement beat 8.*-12 semitones/i);
  assert.match(groups[0]?.rows[1] ?? "", /Session slot 0.*0\.25-beat grid.*0\.75/i);
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
      type: "create_rack_chain",
      trackName: "Drums",
      rackName: "Instrument Rack",
      rackPath: { deviceIndex: 1 },
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
    {
      type: "set_chain_mixer_parameter",
      trackName: "Drums",
      rackName: "Instrument Rack",
      rackPath: { deviceIndex: 1 },
      chainIndex: 2,
      parameter: "panning",
      value: 0.4,
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
    /Append empty Chain.*Instrument Rack.*deviceIndex.*1/i,
  );
  assert.match(
    groups.find((group) => group.title === "Rack & Samples")?.rows[1] ?? "",
    /fill empty.*pad 36.*selected Live object/i,
  );
  assert.match(
    groups.find((group) => group.title === "Set Parameters")?.rows[0] ?? "",
    /send\[0\].*0\.5/i,
  );
  assert.match(
    groups.find((group) => group.title === "Set Parameters")?.rows[1] ?? "",
    /Instrument Rack.*chain 2 mixer panning.*0\.4/i,
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
      type: "create_midi_clip",
      trackName: "Lead",
      laneIndex: 2,
      laneName: "Alternate",
      startBeat: 8,
      durationBeats: 4,
      name: "Lead alt",
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
      type: "create_arrangement_audio_clip",
      trackName: "Audio",
      laneIndex: 1,
      laneName: "Double",
      source: { kind: "selected" },
      startBeat: 24,
      durationBeats: 8,
      name: "Vocal double",
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
    groups.find((group) => group.title === "Write MIDI")?.rows[1] ?? "",
    /Lead alt.*Take Lane 2.*Alternate.*beat 8.*empty range/i,
  );
  assert.match(
    groups.find((group) => group.title === "Write Audio")?.rows[0] ?? "",
    /Vocal.*beat 16.*8 beats.*selected/i,
  );
  assert.match(
    groups.find((group) => group.title === "Write Audio")?.rows[1] ?? "",
    /Take Lane 1.*Double.*Vocal double.*beat 24.*empty lane range/i,
  );
  assert.match(
    groups.find((group) => group.title === "Write Audio")?.rows[2] ?? "",
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
    {
      type: "replace_simpler_sample",
      trackName: "Drums",
      simplerName: "Target Simpler",
      source: {
        kind: "request_audio_attachment",
        requestId: "event-current",
        audioIndex: 1,
      },
    },
  ]);

  const rows = groups.find((group) => group.title === "Rack & Samples")?.rows ?? [];
  assert.match(rows[0] ?? "", /Kick Source.*beat 64.*Audio/i);
  assert.match(rows[1] ?? "", /Source Simpler.*deviceIndex.*2.*chainIndex.*0/i);
  assert.match(rows[2] ?? "", /current request audio input 2/i);
  assert.doesNotMatch(rows[2] ?? "", /event-current/);
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
