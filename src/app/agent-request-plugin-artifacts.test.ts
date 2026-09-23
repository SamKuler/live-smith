import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";

import { MidiClip, MidiTrack } from "@ableton-extensions/sdk";

import type { UiMessage } from "../i18n/ui-message.js";
import type { DirectApiProfile } from "../model/profile.js";
import { saveMidiArtifact } from "../storage/midi-artifacts.js";
import { createSession } from "../storage/sessions.js";
import { handleAgentRequest } from "./agent-request.js";
import { runtimeProfileForSavedProfile } from "./model-request.js";
import { liveContextPresentationFixture } from "./live-context.test-harness.js";

function midiFile(): Uint8Array {
  const track = new Uint8Array([
    0x00, 0x90, 67, 104,
    0x87, 0x40, 0x80, 67, 0x40,
    0x00, 0xff, 0x2f, 0x00,
  ]);
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.byteLength, ...track,
  ]);
}

test("saved Plugin MIDI imports through ordinary confirmed Live action safeguards", async (t) => {
  const directory = await fs.mkdtemp(path.join("/private/tmp", "live-smith-plugin-midi-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, {
    title: "Plugin MIDI",
    projectKey: "project",
    scope: { kind: "track", identity: "2", label: "Lead" },
  });
  const signal = new AbortController().signal;
  const artifact = await saveMidiArtifact(directory, session.id, {
    pluginId: "audio-to-midi",
    serverId: "local",
    toolName: "transcribe",
    label: "Lead transcription",
    bytes: midiFile(),
    signal,
  });
  const created: Array<{ startBeat: number; durationBeats: number; clip: MidiClip<"1.0.0"> }> = [];
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: 2n },
    name: "Lead",
    devices: [],
    arrangementClips: [],
    clipSlots: [],
    takeLanes: [],
    groupTrack: null,
    mute: false,
    solo: false,
    mutedViaSolo: false,
    arm: false,
    createMidiClip: async (startBeat: number, durationBeats: number) => {
      const clip = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
        handle: { id: BigInt(100 + created.length) },
        name: "",
        startTime: startBeat,
        duration: durationBeats,
        startMarker: 0,
        endMarker: durationBeats,
        looping: false,
        loopStart: 0,
        loopEnd: durationBeats,
        color: 0,
        muted: false,
        notes: [],
      });
      created.push({ startBeat, durationBeats, clip });
      track.arrangementClips.push(clip);
      return clip;
    },
  });
  const song = {
    handle: { id: 1n },
    tempo: 120,
    tracks: [track],
    returnTracks: [],
    scenes: [],
    cuePoints: [],
  };
  let modelTurns = 0;
  let confirmations = 0;
  const result = await handleAgentRequest(
    { application: { song }, environment: { storageDirectory: directory, tempDirectory: directory } } as never,
    directory,
    {
      presentation: liveContextPresentationFixture("Lead"),
      summary: 'MIDI track "Lead"',
      target: { track },
      scope: { kind: "track", identity: "2", label: "Lead" },
    },
    "Import the saved transcription at beat 8.",
    runtimeProfileForSavedProfile(profile()),
    "project",
    session.id,
    {
      signal,
      onDelta() {},
      onProgress() {},
      onSessionEvent() {},
      confirmActions: async (plan) => {
        confirmations += 1;
        assert.deepEqual(plan.actions, [{
          type: "create_midi_clip",
          trackName: "Lead",
          startBeat: 8,
          durationBeats: 2,
          name: "Lead transcription",
          notes: [{ pitch: 67, startTime: 0, duration: 2, velocity: 104 }],
        }]);
        return true;
      },
      withActionExecutionLock: (operation) => operation(),
    },
    async (request) => {
      modelTurns += 1;
      const tools = new Map(request.tools.filter((tool) => tool.type === "function")
        .map((tool) => [tool.function.name, tool.function]));
      assert.ok(tools.has("list_session_artifacts"));
      const applySchema = JSON.stringify(tools.get("apply_live_actions")?.parameters);
      assert.match(applySchema, /create_midi_clip_from_artifact/);
      if (modelTurns === 1) {
        return { content: "Checking saved artifacts.", toolCalls: [{
          id: "list-artifacts",
          name: "list_session_artifacts",
          arguments: "{}",
        }] };
      }
      if (modelTurns === 2) {
        const listed = JSON.parse(request.agentMessages.at(-1)!.content!);
        assert.equal(listed[0].artifactRef, artifact.id);
        return { content: "Importing the transcription.", toolCalls: [{
          id: "import-artifact",
          name: "apply_live_actions",
          arguments: JSON.stringify({
            message: "Create the transcribed MIDI Clip",
            actions: [{
              type: "create_midi_clip_from_artifact",
              trackName: "Lead",
              startBeat: 8,
              name: "Lead transcription",
              artifactRef: artifact.id,
            }],
          }),
        }] };
      }
      assert.match(request.agentMessages.at(-1)?.content ?? "", /Created MIDI clip.*1 notes/s);
      return { content: "The transcription is in Live.", toolCalls: [] };
    },
  );

  assert.equal(result, "The transcription is in Live.");
  assert.equal(modelTurns, 3);
  assert.equal(confirmations, 1);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.startBeat, 8);
  assert.equal(created[0]!.durationBeats, 2);
  assert.equal(created[0]!.clip.name, "Lead transcription");
  assert.deepEqual(created[0]!.clip.notes, [{ pitch: 67, startTime: 0, duration: 2, velocity: 104 }]);
});

test("damaged saved MIDI metadata does not block a normal send and surfaces a warning", async (t) => {
  const directory = await fs.mkdtemp(path.join("/private/tmp", "live-smith-plugin-midi-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, {
    title: "Plugin MIDI", projectKey: "project",
    scope: { kind: "selection", identity: "selection", label: "Selection" },
  });
  const signal = new AbortController().signal;
  const artifact = await saveMidiArtifact(directory, session.id, {
    pluginId: "audio-to-midi", serverId: "local", toolName: "transcribe",
    label: "Missing MIDI", bytes: midiFile(), signal,
  });
  await fs.rm(path.join(directory, "live-smith-midi", session.id, `${artifact.id}.mid`));
  const progress: UiMessage[] = [];
  const result = await handleAgentRequest(
    { application: { song: { handle: { id: 1n }, tempo: 120, tracks: [],
      returnTracks: [], scenes: [], cuePoints: [] } },
      environment: { storageDirectory: directory, tempDirectory: directory } } as never,
    directory,
    { presentation: liveContextPresentationFixture("Selection"), summary: "Selection",
      target: {}, scope: { kind: "selection", identity: "selection", label: "Selection" } },
    "Answer without using MIDI artifacts.",
    runtimeProfileForSavedProfile(profile()),
    "project",
    session.id,
    { signal, onDelta() {}, onProgress(message) { progress.push(message); }, onSessionEvent() {},
      confirmActions: async () => false, withActionExecutionLock: (operation) => operation() },
    async () => ({ content: "Done.", toolCalls: [] }),
  );
  assert.equal(result, "Done.");
  assert.ok(progress.some((message) => typeof message === "object" &&
    message.source === "{count} saved MIDI artifacts are unavailable; their metadata was preserved." &&
    message.values.count === 1));
  assert.ok((await fs.readdir(path.join(directory, "live-smith-midi", session.id)))
    .includes(`${artifact.id}.midi.json`));
});

function profile(): DirectApiProfile {
  return {
    id: "profile",
    name: "Profile",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "chat-completions",
      baseUrl: "https://example.test/v1",
      apiKey: "fixture-key",
    },
    defaultModel: "model",
    models: [{
      model: "model",
      parameters: { maxOutputTokens: 4096, reasoning: { mode: "default" } },
      advanced: {},
    }],
  };
}

function sdkObject<T extends object>(prototype: object, properties: Record<string, unknown>): T {
  return Object.defineProperties(
    Object.create(prototype),
    Object.fromEntries(Object.entries(properties).map(([key, value]) => [
      key,
      { configurable: true, enumerable: true, writable: true, value },
    ])),
  ) as T;
}
