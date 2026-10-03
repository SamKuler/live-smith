import { modelMessageText } from "../../model/support/model-message-test-helpers.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";

import { MidiClip, MidiTrack } from "@ableton-extensions/sdk";

import type { UiMessage } from "../../../src/i18n/ui-message.js";
import type { DirectApiProfile } from "../../../src/model/profile.js";
import { saveMidiArtifact } from "../../../src/storage/midi-artifacts.js";
import { createSession } from "../../../src/storage/sessions.js";
import { appendSessionEvent, loadSessionEvents } from "../../../src/storage/events.js";
import { pendingArtifactParentFromEvents } from "../../../src/agent/artifact-contracts.js";
import { selectSessionArtifact } from "../../../src/app/session/session-artifacts.js";
import { SteeringChannel } from "../../../src/app/chat/steering.js";
import { handleAgentRequest } from "../../../src/app/agent-request.js";
import { runtimeProfileForSavedProfile } from "../../../src/app/model/model-request.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";

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

test("candidate parent binds to durable initial user across failed admission, Steer and the next queued-style request", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-candidate-request-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Artifacts", projectKey: "project", scope: { kind: "selection", identity: "set", label: "Set" } });
  const signal = new AbortController().signal;
  const save = (label: string) => saveMidiArtifact(directory, session.id, { connectionId: "generator", serverId: "midi", toolName: "make", label, bytes: midiFile(), signal });
  const a = { kind: "midi" as const, id: (await save("A")).id };
  const b = { kind: "midi" as const, id: (await save("B")).id };
  const select = (action: "prefer" | "continue", candidate: typeof a) => selectSessionArtifact({ storageDirectory: directory, sessionId: session.id, projectKey: "project", signal, selection: { action, candidate } });
  await select("continue", a); await select("prefer", b);
  const context = { application: { song: { handle: { id: 1n }, tempo: 120, tracks: [], returnTracks: [], scenes: [], cuePoints: [] } },
    environment: { storageDirectory: directory, tempDirectory: directory } } as never;
  const interaction = { presentation: liveContextPresentationFixture("Set"), summary: "Set", target: {}, scope: session.scope };
  const steering = new SteeringChannel();
  let steeringCompletion: Promise<void> | undefined;
  let admitted = 0; let turns = 0;
  const run = (appendUser = appendSessionEvent) => handleAgentRequest(context, directory, interaction, "Make a variation", runtimeProfileForSavedProfile(profile()), "project", session.id,
    { signal, steering, steeringSendId: "send-candidates", onDelta() {}, onProgress() {},
      async onSessionEvent(event) {
        if (event.kind === "user" && !event.steeringReceipt && admitted++ === 0) {
          await select("continue", b);
          steeringCompletion = steering.submit("artifact-steer", "Keep the rhythm");
        }
      }, confirmActions: async () => false, withActionExecutionLock: (operation) => operation() },
    async (request) => {
      turns += 1;
      if (turns === 1) return { content: "Read the source", toolCalls: [{ id: "inspect-source", name: "inspect_midi_artifact",
        arguments: JSON.stringify({ artifactRef: a.id, partId: "track-0-channel-1" }) }] };
      if (turns === 2) assert.equal(JSON.parse(modelMessageText(request.agentMessages.at(-1))).notes[0].pitch, 67);
      return { content: "Done", toolCalls: [] };
    }, appendUser);
  await assert.rejects(run(async () => { throw new Error("User write failed before commit"); }), /User write failed/);
  assert.deepEqual(pendingArtifactParentFromEvents(await loadSessionEvents(directory, session.id)), a);
  await run(); await steeringCompletion;
  let events = await loadSessionEvents(directory, session.id);
  const user = events.find((event) => event.kind === "user" && !event.steeringReceipt)!;
  assert.deepEqual(user.parentCandidate, a);
  assert.ok(events.some((event) => event.kind === "user" && event.steeringReceipt));
  for (const call of events.filter((event) => event.kind === "tool_call")) {
    assert.deepEqual(call.parentCandidate, a); assert.equal(call.requestEventId, user.id);
  }
  assert.deepEqual(pendingArtifactParentFromEvents(events), b);
  await run();
  events = await loadSessionEvents(directory, session.id);
  assert.deepEqual(events.filter((event) => event.kind === "user" && !event.steeringReceipt).at(-1)!.parentCandidate, b);
  assert.equal(pendingArtifactParentFromEvents(events), undefined);
  await select("continue", a);
  await assert.rejects(run(async (...args) => {
    await appendSessionEvent(...args); throw new Error("User receipt reply lost after commit");
  }), /User receipt reply lost/);
  assert.equal(pendingArtifactParentFromEvents(await loadSessionEvents(directory, session.id)), undefined,
    "a committed user receipt consumes the parent even when its caller loses the reply");
});

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
        const listed = JSON.parse(modelMessageText(request.agentMessages.at(-1)));
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
      assert.match(modelMessageText(request.agentMessages.at(-1)), /Created MIDI clip.*1 notes/s);
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
