import * as fs from "node:fs/promises";
import { MidiClip, MidiTrack } from "@ableton-extensions/sdk";
import type { TestContext } from "node:test";
import { createHostAbortController } from "../../../../src/runtime/host.js";
import { createSession } from "../../../../src/storage/sessions.js";
import { runtimeProfileForSavedProfile } from "../../../../src/app/model/model-request.js";
import { configureMidiContinuation } from "../../../../src/app/midi/midi-continuation.js";
import { midiModelGenerator } from "../../../../src/app/midi/midi-continuation-generators.js";
import { loadAgentSettings, saveSavedProfile } from "../../../../src/storage/settings.js";

export function sdkObject<T>(prototype: object, values: Record<string, unknown>): T {
  return Object.defineProperties(Object.create(prototype), Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, writable: true, configurable: true }])));
}
export async function continuationHarness(t: TestContext) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-midi-continuation-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profile = { id: "midi-profile", name: "MIDI model", defaultModel: "midi-model",
    connection: { kind: "direct-api" as const, apiFamily: "openai" as const, apiMode: "responses" as const, baseUrl: "https://example.test/v1", apiKey: "test-key" },
    models: [{ model: "midi-model", parameters: { maxOutputTokens: 4096, reasoning: { mode: "default" as const } }, advanced: {} }] };
  await saveSavedProfile(directory, profile);
  const session = await createSession(directory, { title: "Next section", projectKey: "set", scope: { kind: "selection", identity: "set", label: "Live Set" }, creativeBrief: "Keep the sparse bass and bright lead roles." });
  const clips = [48, 72].map((pitch, index) => sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: BigInt(index + 10) }, name: `Source ${index + 1}`, startTime: 0, endTime: 8, duration: 8,
    startMarker: 0, endMarker: 8, looping: false, loopStart: 0, loopEnd: 8, muted: false,
    notes: [{ pitch, startTime: 0, duration: 2, velocity: 100, selected: false }],
  }));
  const tracks = clips.map((clip, index) => sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: BigInt(index + 1) }, name: index ? "Lead" : "Bass", arrangementClips: [clip], clipSlots: [],
    devices: [], takeLanes: [], mute: false, solo: false, arm: false, mutedViaSolo: false, groupTrack: null, isGrouped: false, isFoldable: false, color: 0,
  }));
  const song = { handle: { id: 1n }, tempo: 120, tracks, returnTracks: [], scenes: [] };
  const context = { application: { song } } as never;
  const controller = createHostAbortController();
  const input = { context, storageDirectory: directory, sessionId: session.id, projectKey: "set", signal: controller.signal };
  const generator = midiModelGenerator(await loadAgentSettings(directory), session);
  const buffer = await configureMidiContinuation({ ...input, expectedBufferId: null,
    sourceClips: tracks.map((track, index) => ({ trackId: String(track.handle.id), clipId: String(clips[index]!.handle.id) })),
    segmentBeats: 8, capacity: 2, generator, prompt: "Continue the rhythm." });
  return { ...input, directory, session, controller, profile, runtime: runtimeProfileForSavedProfile(profile), buffer, tracks, clips, song };
}
