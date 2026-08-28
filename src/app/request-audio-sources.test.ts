import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  saveSessionAttachment,
  sessionAttachmentRefFromStored,
  type AudioSessionAttachmentRef,
  type SessionAttachmentRef,
} from "../storage/attachments.js";
import { resolveSampleSource } from "../live/sample-source.js";
import { AgentPlanExecutionError } from "../live/executor.js";
import {
  createRequestAudioSampleSources,
  mergeRequestAudioImportProgress,
  prepareRequestAudioSampleSources,
  requestAudioSampleSourceInstructions,
} from "./request-audio-sources.js";

test("request audio locators are request-scoped, ordered, and hide attachment IDs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-request-source-"));
  const refs = await saveAudioRefs(directory, "session-a", [waveBytes(), waveBytes()]);
  const stagedNames: string[] = [];
  try {
    assert.equal(refs[0]?.fileName, refs[1]?.fileName);
    const sources = createRequestAudioSampleSources({
      context: requestContext(directory, async (stagingPath) => {
        const name = path.basename(stagingPath);
        stagedNames.push(name);
        return `/project/${name}`;
      }),
      storageDirectory: directory,
      sessionId: "session-a",
      requestId: "event-current",
      refs,
      signal: new AbortController().signal,
    });
    const instructions = requestAudioSampleSourceInstructions(sources);

    assert.match(instructions, /Audio input 1/);
    assert.match(instructions, /Audio input 2/);
    assert.match(instructions, /event-current/);
    assert.doesNotMatch(instructions, new RegExp(refs[0]!.id));
    assert.doesNotMatch(instructions, new RegExp(refs[1]!.id));
    assert.equal(
      resolveSampleSource(
        {} as never,
        { kind: "request_audio_attachment", requestId: "event-current", audioIndex: 1 },
        {},
        sources,
      ).label,
      refs[1]!.fileName,
    );
    assert.throws(
      () => resolveSampleSource(
        {} as never,
        { kind: "request_audio_attachment", requestId: "event-old", audioIndex: 1 },
        {},
        sources,
      ),
      /not available as a SampleSource/i,
    );
    await prepareRequestAudioSampleSources({
      tracks: new Map(),
      actionTracks: new Map(),
      actionObjects: new Map([...sources.values()].map((source, index) => [
        index,
        { sampleSource: source },
      ])),
    }, new AbortController().signal);
    assert.equal(new Set(stagedNames).size, 2);
    assert.equal(stagedNames.every((name) => path.extname(name) === ".wav"), true);
    assert.throws(
      () => resolveSampleSource(
        {} as never,
        { kind: "request_audio_attachment", requestId: "event-current", audioIndex: 2 },
        {},
        sources,
      ),
      /not available as a SampleSource/i,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("request audio preparation imports verified WAV and MP3 bytes once and removes staging files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-request-import-"));
  const refs = await saveAudioRefs(directory, "session-b", [waveBytes(), mp3Bytes()]);
  const stagedPaths: string[] = [];
  const stagedBytes: Uint8Array[] = [];
  const order: string[] = [];
  try {
    const sources = createRequestAudioSampleSources({
      context: requestContext(directory, async (stagingPath) => {
        order.push("import");
        stagedPaths.push(stagingPath);
        stagedBytes.push(new Uint8Array(await fs.readFile(stagingPath)));
        const fileMode = (await fs.stat(stagingPath)).mode & 0o777;
        const directoryMode = (await fs.stat(path.dirname(stagingPath))).mode & 0o777;
        assert.equal(fileMode, 0o600);
        assert.equal(directoryMode, 0o700);
        return `/Live Project/Samples/Imported/${path.basename(stagingPath)}`;
      }),
      storageDirectory: directory,
      sessionId: "session-b",
      requestId: "event-import",
      refs,
      signal: new AbortController().signal,
    });
    const bindings = {
      tracks: new Map(),
      actionTracks: new Map(),
      actionObjects: new Map([
        [0, { sampleSource: [...sources.values()][0]! }],
        [1, { sampleSource: [...sources.values()][0]! }],
        [2, { sampleSource: [...sources.values()][1]! }],
      ]),
    };

    const first = await prepareRequestAudioSampleSources(
      bindings,
      new AbortController().signal,
      () => order.push("boundary"),
    );
    const second = await prepareRequestAudioSampleSources(
      bindings,
      new AbortController().signal,
    );

    assert.equal(first.results.length, 2);
    assert.equal(first.keys.length, 2);
    assert.equal(second.results.length, 0);
    assert.deepEqual(stagedPaths.map((item) => path.extname(item)), [".wav", ".mp3"]);
    assert.deepEqual(
      stagedBytes.map((bytes) => Buffer.from(bytes)),
      [Buffer.from(waveBytes()), Buffer.from(mp3Bytes())],
    );
    const managedPaths = [...sources.values()].map((source) => source.filePath);
    assert.deepEqual(managedPaths.map((item) => path.extname(item)), [".wav", ".mp3"]);
    assert.equal(new Set(managedPaths).size, 2);
    assert.deepEqual(order, [
      "boundary",
      "import",
      "boundary",
      "boundary",
      "import",
      "boundary",
    ]);
    for (const stagingPath of stagedPaths) {
      await assert.rejects(fs.stat(path.dirname(stagingPath)), { code: "ENOENT" });
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("request audio preparation reports an earlier import when a later source fails", async () => {
  let firstPrepares = 0;
  const first = fakeRequestSource("event-partial", 0, async () => {
    firstPrepares += 1;
    return true;
  });
  const second = fakeRequestSource("event-partial", 1, async () => {
    throw new Error("second import failed");
  });
  const bindings = {
    tracks: new Map(),
    actionTracks: new Map(),
    actionObjects: new Map([
      [0, { sampleSource: first }],
      [1, { sampleSource: second }],
    ]),
  };

  await assert.rejects(
    prepareRequestAudioSampleSources(bindings, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof AgentPlanExecutionError);
      assert.equal(error.completedMutationCount, 1);
      assert.equal(error.completedResults.length, 1);
      assert.deepEqual(error.completedActionKeys, []);
      return true;
    },
  );
  assert.equal(firstPrepares, 1);

  const merged = mergeRequestAudioImportProgress(
    {
      results: ["Imported audio input 1."],
      keys: ["live-action-step:request-audio-import:event-partial:0"],
    },
    new AgentPlanExecutionError(
      ["Created Drum Chain.", "Inserted Simpler."],
      new Error("sample replacement failed"),
      0,
      undefined,
      "Drums",
      [["live-action-step:drum-pad:create-chain"], ["live-action-step:drum-pad:insert-simpler"]],
      2,
    ),
  );
  assert.ok(merged instanceof AgentPlanExecutionError);
  assert.deepEqual(merged.completedActionKeys, [[
    "live-action-step:request-audio-import:event-partial:0",
    "live-action-step:drum-pad:create-chain",
    "live-action-step:drum-pad:insert-simpler",
  ]]);
  assert.equal(merged.completedMutationCount, 3);
});

test("request audio import failures hide staging and project paths", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-request-redaction-"));
  const [ref] = await saveAudioRefs(directory, "session-c", [waveBytes()]);
  let stagingDirectory = "";
  let importCalls = 0;
  try {
    const sources = createRequestAudioSampleSources({
      context: requestContext(directory, async (stagingPath) => {
        importCalls += 1;
        stagingDirectory = path.dirname(stagingPath);
        throw new Error(
          `Could not copy ${stagingPath} to /Live Project/secret/reference.wav`,
        );
      }),
      storageDirectory: directory,
      sessionId: "session-c",
      requestId: "event-redacted",
      refs: [ref!],
      signal: new AbortController().signal,
    });
    const bindings = {
      tracks: new Map(),
      actionTracks: new Map(),
      actionObjects: new Map([[0, { sampleSource: [...sources.values()][0]! }]]),
    };

    await assert.rejects(
      prepareRequestAudioSampleSources(
        bindings,
        new AbortController().signal,
        () => {
          throw new Error("import boundary blocked");
        },
      ),
      /import boundary blocked/,
    );
    assert.equal(importCalls, 0);

    await assert.rejects(
      [...sources.values()][0]!.prepare(),
      (error: unknown) => {
        assert.equal(
          (error as Error).message,
          "Live Smith could not import the current audio attachment into the Live project.",
        );
        assert.doesNotMatch((error as Error).message, /request-redaction|\/Live Project\//);
        return true;
      },
    );
    assert.equal(importCalls, 1);
    await assert.rejects(fs.stat(stagingDirectory), { code: "ENOENT" });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function requestContext(
  temporaryDirectory: string,
  importIntoProject: (filePath: string) => Promise<string>,
) {
  return {
    environment: { tempDirectory: temporaryDirectory },
    resources: { importIntoProject },
  } as never;
}

async function saveAudioRefs(
  directory: string,
  sessionId: string,
  files: readonly Uint8Array[],
): Promise<AudioSessionAttachmentRef[]> {
  const pending: SessionAttachmentRef[] = [];
  for (const bytes of files) {
    const stored = await saveSessionAttachment(directory, sessionId, {
      fileName: "reference.wav",
      bytes,
    }, { preSavePendingAttachmentRefs: pending });
    pending.push(sessionAttachmentRefFromStored(stored));
  }
  return pending.filter(
    (ref): ref is AudioSessionAttachmentRef => ref.kind === "audio",
  );
}

function fakeRequestSource(
  requestId: string,
  audioIndex: number,
  prepare: () => Promise<boolean>,
) {
  return {
    kind: "request_audio_attachment" as const,
    requestId,
    audioIndex,
    filePath: "/project/imported.wav",
    label: `Audio ${audioIndex + 1}`,
    identity: `request-audio:${requestId}:${audioIndex}`,
    prepare,
  };
}

function waveBytes(): Uint8Array {
  const sampleRate = 8_000;
  const output = Buffer.alloc(44 + sampleRate);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(output.byteLength - 8, 4);
  output.write("WAVEfmt ", 8, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate, 28);
  output.writeUInt16LE(1, 32);
  output.writeUInt16LE(8, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(sampleRate, 40);
  return output;
}

function mp3Bytes(): Uint8Array {
  const frameBytes = Math.floor(144 * 128_000 / 44_100);
  const frame = new Uint8Array(frameBytes);
  frame.set([0xff, 0xfb, 0x90, 0]);
  const bytes = new Uint8Array(frameBytes * 2);
  bytes.set(frame);
  bytes.set(frame, frameBytes);
  return bytes;
}
