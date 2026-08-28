import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { AudioClip, AudioTrack, MidiTrack, Simpler } from "@ableton-extensions/sdk";

import type { DirectApiProfile } from "../model/profile.js";
import { saveSessionAttachment } from "../storage/attachments.js";
import { loadSessionEvents } from "../storage/events.js";
import { createSession } from "../storage/sessions.js";
import { handleAgentRequest } from "./agent-request.js";
import { runtimeProfileForSavedProfile } from "./model-request.js";

test("an audio-capable agent renders another track range into the next model turn", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-agent-audio-"));
  const renderedPath = path.join(directory, "private-render.wav");
  await fs.writeFile(renderedPath, waveBytes());
  const midiTrack = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: 1n },
    name: "1-MIDI",
    arrangementClips: [],
    clipSlots: [],
  });
  const audioClip = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    handle: { id: 3n },
    name: "track.mp3",
    startTime: 0,
    endTime: 108,
    duration: 108,
    startMarker: 0,
    endMarker: 108,
    looping: false,
    loopStart: 0,
    loopEnd: 108,
    muted: false,
    filePath: "/private/source/track.mp3",
    warping: true,
    warpMode: "complex",
    warpMarkers: [],
  });
  const audioTrack = sdkObject<AudioTrack<"1.0.0">>(AudioTrack.prototype, {
    handle: { id: 2n },
    name: "Reference",
    arrangementClips: [audioClip],
    clipSlots: [],
  });
  const session = await createSession(directory, {
    title: "Transcribe melody",
    projectKey: "project-a",
    scope: { kind: "track", identity: "1", label: "1-MIDI" },
  });
  const renderedRanges: unknown[] = [];
  const modelInputs: unknown[] = [];
  let modelCalls = 0;

  try {
    const result = await handleAgentRequest(
      {
        application: { song: { tempo: 130, tracks: [midiTrack, audioTrack] } },
        resources: {
          renderPreFxAudio: async (...args: unknown[]) => {
            renderedRanges.push(args);
            return renderedPath;
          },
        },
      } as never,
      directory,
      {
        summary: 'MIDI track "1-MIDI"',
        target: { track: midiTrack },
        scope: { kind: "track", identity: "1", label: "1-MIDI" },
      },
      "Read beats 0 to 108 from Reference and transcribe the melody.",
      runtimeProfileForSavedProfile(audioProfile()),
      "project-a",
      session.id,
      {
        signal: new AbortController().signal,
        onDelta: () => {},
        onProgress: () => {},
        onSessionEvent: () => {},
        confirmActions: async () => true,
      },
      async (request) => {
        modelCalls += 1;
        assert.equal(
          request.tools.some((tool) =>
            tool.type === "function" &&
            tool.function.name === "read_arrangement_audio"
          ),
          true,
        );
        if (modelCalls === 1) {
          return {
            content: "I will read the requested range.",
            toolCalls: [{
              id: "read-reference",
              name: "read_arrangement_audio",
              arguments: JSON.stringify({
                trackName: "Reference",
                clipName: "track.mp3",
                clipStartBeat: 0,
                startBeat: 0,
                endBeat: 108,
              }),
            }],
          };
        }
        const toolResult = request.agentMessages.find((message) =>
          message.role === "tool" && message.toolCallId === "read-reference"
        );
        assert.equal(toolResult?.role, "tool");
        if (toolResult?.modelInputPart) modelInputs.push(toolResult.modelInputPart);
        return { content: "I received the rendered audio.", toolCalls: [] };
      },
    );

    assert.equal(result, "I received the rendered audio.");
    assert.equal(modelCalls, 2);
    assert.deepEqual(renderedRanges, [[audioTrack, 0, 108]]);
    assert.deepEqual(
      modelInputs.map((part) => (part as { type?: unknown }).type),
      ["audio"],
    );
    const serializedEvents = JSON.stringify(await loadSessionEvents(directory, session.id));
    assert.doesNotMatch(serializedEvents, /private-render|\/private\/source|base64|UklGR/);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("a hidden audio tool call cannot read Live audio for an unsupported protocol", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-agent-audio-gate-"));
  const session = await createSession(directory, {
    title: "Unsupported audio",
    projectKey: "project-a",
    scope: { kind: "track", identity: "1", label: "Audio" },
  });
  let renderCalls = 0;
  let modelCalls = 0;

  try {
    const result = await handleAgentRequest(
      {
        application: { song: { tracks: [] } },
        resources: {
          renderPreFxAudio: async () => {
            renderCalls += 1;
            throw new Error("must not render");
          },
        },
      } as never,
      directory,
      {
        summary: "Audio track",
        target: {},
        scope: { kind: "track", identity: "1", label: "Audio" },
      },
      "Read this audio.",
      runtimeProfileForSavedProfile(responsesAudioProfile()),
      "project-a",
      session.id,
      {
        signal: new AbortController().signal,
        onDelta: () => {},
        onProgress: () => {},
        onSessionEvent: () => {},
        confirmActions: async () => true,
      },
      async (request) => {
        modelCalls += 1;
        assert.equal(
          request.tools.some((tool) =>
            tool.type === "function" &&
            tool.function.name === "read_arrangement_audio"
          ),
          false,
        );
        if (modelCalls === 1) {
          return {
            content: null,
            toolCalls: [{
              id: "forged-read",
              name: "read_arrangement_audio",
              arguments: JSON.stringify({
                trackName: "Audio",
                startBeat: 0,
                endBeat: 4,
              }),
            }],
          };
        }
        assert.match(
          request.agentMessages.at(-1)?.content ?? "",
          /not available for the active model Profile/i,
        );
        return { content: "Audio input is unavailable.", toolCalls: [] };
      },
    );

    assert.equal(result, "Audio input is unavailable.");
    assert.equal(renderCalls, 0);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("request audio is imported and revalidated before every Live action in the plan", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-request-audio-plan-"));
  const session = await createSession(directory, {
    title: "Use attached sample",
    projectKey: "project-a",
    scope: { kind: "track", identity: "2", label: "Instrument" },
  });
  await saveSessionAttachment(directory, session.id, {
    fileName: "reference.wav",
    bytes: waveBytes(),
  }, { preSavePendingAttachmentRefs: [] });

  const order: string[] = [];
  let tempo = 120;
  let replacedPath = "";
  const simpler = sdkObject<Simpler<"1.0.0">>(Simpler.prototype, {
    handle: { id: 3n },
    name: "Simpler",
    parameters: [],
    sample: null,
    replaceSample: async (filePath: string) => {
      order.push("replace");
      replacedPath = filePath;
      return {};
    },
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: 2n },
    name: "Instrument",
    devices: [simpler],
    arrangementClips: [],
    clipSlots: [],
    takeLanes: [],
  });
  const song = Object.defineProperties({
    handle: { id: 1n },
    tracks: [track],
    returnTracks: [],
    scenes: [],
    cuePoints: [],
    gridQuantization: 6,
    gridIsTriplet: false,
    scaleMode: false,
    scaleName: "",
    rootNote: 0,
    scaleIntervals: [],
  }, {
    tempo: {
      enumerable: true,
      get: () => tempo,
      set: (value: number) => {
        order.push("tempo");
        tempo = value;
      },
    },
  });
  let modelCalls = 0;

  try {
    const result = await handleAgentRequest(
      {
        environment: { storageDirectory: directory, tempDirectory: directory },
        application: { song },
        resources: {
          importIntoProject: async (stagingPath: string) => {
            order.push("import");
            assert.equal(
              Buffer.compare(await fs.readFile(stagingPath), Buffer.from(waveBytes())),
              0,
            );
            return "/Live Project/Samples/Imported/reference.wav";
          },
        },
      } as never,
      directory,
      {
        summary: 'MIDI track "Instrument" with Simpler',
        target: { track },
        scope: { kind: "track", identity: "2", label: "Instrument" },
      },
      "Set the tempo and load the attached audio into Simpler.",
      runtimeProfileForSavedProfile(audioProfile()),
      "project-a",
      session.id,
      {
        signal: new AbortController().signal,
        onDelta: () => {},
        onProgress: () => {},
        onSessionEvent: () => {},
        confirmActions: async () => {
          order.push("confirm");
          return true;
        },
        withActionExecutionLock: async (operation) => {
          order.push("lock");
          return operation();
        },
      },
      async (request) => {
        modelCalls += 1;
        if (modelCalls === 1) {
          const locatorText = request.requestAudioSampleSourceInstructions?.match(
            /Audio input 1: (\{[^\n]+\})/,
          )?.[1];
          assert.ok(locatorText);
          const locator = JSON.parse(locatorText);
          return {
            content: "Applying both changes.",
            toolCalls: [{
              id: "apply-attached-sample",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Set tempo and load current audio input 1",
                actions: [
                  { type: "set_tempo", tempo: 128 },
                  {
                    type: "replace_simpler_sample",
                    trackName: "Instrument",
                    simplerName: "Simpler",
                    source: locator,
                  },
                ],
              }),
            }],
          };
        }
        assert.match(
          request.agentMessages.at(-1)?.content ?? "",
          /Imported current request audio input 1.*Set tempo.*Loaded sample/s,
        );
        return { content: "The attached sample is loaded.", toolCalls: [] };
      },
    );

    assert.equal(result, "The attached sample is loaded.");
    assert.equal(tempo, 128);
    assert.equal(replacedPath, "/Live Project/Samples/Imported/reference.wav");
    assert.deepEqual(order, ["confirm", "lock", "import", "tempo", "replace"]);
    const serializedEvents = JSON.stringify(await loadSessionEvents(directory, session.id));
    assert.doesNotMatch(serializedEvents, /live-smith-request-audio-|\/Live Project\//);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("post-import target drift records the project copy and blocks every Live action", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-request-audio-drift-"));
  const session = await createSession(directory, {
    title: "Reject changed target",
    projectKey: "project-a",
    scope: { kind: "track", identity: "12", label: "Instrument" },
  });
  await saveSessionAttachment(directory, session.id, {
    fileName: "reference.wav",
    bytes: waveBytes(),
  }, { preSavePendingAttachmentRefs: [] });

  let replaceCalls = 0;
  let modelCalls = 0;
  const simpler = sdkObject<Simpler<"1.0.0">>(Simpler.prototype, {
    handle: { id: 13n },
    name: "Simpler",
    parameters: [],
    sample: null,
    replaceSample: async () => {
      replaceCalls += 1;
      return {};
    },
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: 12n },
    name: "Instrument",
    devices: [simpler],
    arrangementClips: [],
    clipSlots: [],
    takeLanes: [],
    mute: false,
    solo: false,
    mutedViaSolo: false,
    arm: false,
    groupTrack: null,
  });

  try {
    const result = await handleAgentRequest(
      {
        environment: { storageDirectory: directory, tempDirectory: directory },
        application: {
          song: { handle: { id: 11n }, tracks: [track], returnTracks: [] },
        },
        resources: {
          importIntoProject: async () => {
            track.name = "Changed Instrument";
            return "/Live Project/Secret/reference.wav";
          },
        },
      } as never,
      directory,
      {
        summary: 'MIDI track "Instrument" with Simpler',
        target: { track },
        scope: { kind: "track", identity: "12", label: "Instrument" },
      },
      "Load the attached audio into Simpler.",
      runtimeProfileForSavedProfile(audioProfile()),
      "project-a",
      session.id,
      {
        signal: new AbortController().signal,
        onDelta: () => {},
        onProgress: () => {},
        onSessionEvent: () => {},
        confirmActions: async () => true,
        withActionExecutionLock: (operation) => operation(),
      },
      async (request) => {
        modelCalls += 1;
        if (modelCalls === 1) {
          const locatorText = request.requestAudioSampleSourceInstructions?.match(
            /Audio input 1: (\{[^\n]+\})/,
          )?.[1];
          assert.ok(locatorText);
          return {
            content: "Loading the attachment.",
            toolCalls: [{
              id: "apply-drifted-sample",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Load current audio input 1",
                actions: [{
                  type: "replace_simpler_sample",
                  trackName: "Instrument",
                  simplerName: "Simpler",
                  source: JSON.parse(locatorText),
                }],
              }),
            }],
          };
        }
        return { content: "The target changed, so I stopped.", toolCalls: [] };
      },
    );

    assert.match(result, /unfinished Live work/i);
    assert.equal(modelCalls, 2);
    assert.equal(replaceCalls, 0);
    const serializedEvents = JSON.stringify(await loadSessionEvents(directory, session.id));
    assert.match(serializedEvents, /Imported current request audio input 1/);
    assert.match(serializedEvents, /partially completed/i);
    assert.doesNotMatch(
      serializedEvents,
      /live-smith-request-audio-|\/Live Project\/Secret/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function audioProfile(): DirectApiProfile {
  return {
    id: "audio-profile",
    name: "Audio Profile",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "chat-completions",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
    },
    defaultModel: "audio-model",
    models: [{
      model: "audio-model",
      parameters: {
        maxOutputTokens: 4096,
        reasoning: { mode: "default" },
      },
      advanced: { capabilityOverrides: { inputs: { audio: true } } },
    }],
  };
}

function responsesAudioProfile(): DirectApiProfile {
  const profile = audioProfile();
  return {
    ...profile,
    id: "responses-audio-profile",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
    },
  };
}

function waveBytes(): Uint8Array {
  const sampleRate = 8_000;
  const dataBytes = sampleRate;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataBytes, 40);
  return bytes;
}

function sdkObject<T extends object>(
  prototype: object,
  properties: Record<string, unknown>,
): T {
  return Object.defineProperties(
    Object.create(prototype),
    Object.fromEntries(Object.entries(properties).map(([key, value]) => [
      key,
      { configurable: true, enumerable: true, writable: true, value },
    ])),
  ) as T;
}
