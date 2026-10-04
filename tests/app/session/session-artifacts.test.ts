import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execPath } from "node:process";
import { audioStorageHarness as rawAudioStorageHarness, generationJobCases, waveBytes } from "../../storage/support/audio-storage-test-helpers.js";
import { midiBytes, noteTrack, sequentialNotes } from "../../attachments/support/midi-test-helpers.js";
import { savePluginAudioArtifact } from "../../../src/storage/audio-artifacts.js";
import { createAudioJob, loadAudioJob, updateAudioJob } from "../../../src/storage/audio-jobs.js";
import { saveAudioAsset } from "../../../src/storage/audio-assets.js";
import { saveMidiArtifact } from "../../../src/storage/midi-artifacts.js";
import { appendSessionEvent, loadSessionEvents, type SessionEvent } from "../../../src/storage/events.js";
import { createSession } from "../../../src/storage/sessions.js";
import { listSessionArtifacts, readSessionArtifact, readSessionMidiPartPreview, selectSessionArtifact, artifactGenerationsFromEvents } from "../../../src/app/session/session-artifacts.js";
import { isMidiPartPreview, isSessionArtifactDetail, isSessionArtifacts } from "../../../src/ui/client/wire-contracts/artifacts.js";
import { artifactKey, pendingArtifactParentFromEvents, isArtifactSelection } from "../../../src/agent/artifact-contracts.js";
import { createSessionArtifactToolset } from "../../../src/app/session/session-artifact-tools.js";
import { parseCommandInput } from "../../../src/app/chat/chat-bridge-http.js";
import { runAgentLoop } from "../../../src/agent/loop.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { fillMidiContinuation } from "../../../src/app/midi/midi-continuation.js";
import { generateMidiContinuationWithModel } from "../../../src/app/midi/midi-continuation-model.js";
import { continuationHarness } from "../midi/support/continuation-harness.js";
import { saveGlobalSettings } from "../../../src/storage/settings.js";
import { createRequestPluginTools } from "../../../src/app/plugins/request-plugin-tools.js";
import { runPluginParameterTool } from "../../../src/app/plugins/plugin-parameter-tool.js";

async function audioStorageHarness(...args: Parameters<typeof rawAudioStorageHarness>) {
  const h = await rawAudioStorageHarness(...args);
  return { ...h, save: async (...saveArgs: Parameters<typeof h.save>) => {
    const asset = await h.save(...saveArgs);
    const job = await loadAudioJob(h.storage, h.session.id, h.job.id);
    await updateAudioJob(h.storage, h.session.id, h.job.id, {
      outputAssets: [...job.outputAssets.filter((output) => output.id !== asset.id), asset],
    });
    return asset;
  } };
}

test("artifacts project owned audio/MIDI, parameters and parent from persisted Session events", async (t) => {
  const h = await audioStorageHarness(t);
  const audio = await h.save("vocals");
  const parent = { kind: "audio" as const, id: audio.id };
  const request = await appendSessionEvent(h.storage, h.session.id, { kind: "user", content: "Write a variation", parentCandidate: parent });
  const call = await appendSessionEvent(h.storage, h.session.id, { kind: "tool_call", name: "make_midi",
    content: JSON.stringify({ prompt: "Syncopated", seed: 12 }), parentCandidate: parent, requestEventId: request.id });
  const midi = await saveMidiArtifact(h.storage, h.session.id, { connectionId: "midi-generator", serverId: "midi", toolName: "make_midi",
    label: "Variation", bytes: midiBytes({ tracks: [noteTrack(), noteTrack({ channel: 2 })] }), signal: h.signal });
  const result = await appendSessionEvent(h.storage, h.session.id, { kind: "tool_result", name: "make_midi",
    content: JSON.stringify({ artifacts: [{ kind: "midi", artifactRef: midi.id }] }) });
  const input = { storageDirectory: h.storage, sessionId: h.session.id, projectKey: "test-project", signal: h.signal };
  await appendSessionEvent(h.storage, h.session.id, { kind: "candidate", content: "Preferred artifact selected.",
    candidateSelection: { action: "prefer", candidate: { kind: "midi", id: midi.id } } });
  await selectSessionArtifact({ ...input, selection: { action: "continue", candidate: parent } });
  await appendSessionEvent(h.storage, h.session.id, { kind: "compaction", content: "Checkpoint" });
  const restarted = await listSessionArtifacts(input);
  assert.equal(restarted.artifacts.length, 2);
  const candidate = restarted.artifacts.find((entry) => entry.ref.kind === "midi")!;
  assert.equal(candidate.sourceLabel, "Plugin-generated MIDI");
  assert.equal("preferred" in candidate, false); assert.equal("preferred" in restarted, false); assert.deepEqual(candidate.parent, parent);
  assert.deepEqual(candidate.generation, { toolName: "make_midi", callEventId: call.id, resultEventId: result.id,
    requestEventId: request.id, parameters: '{"prompt":"Syncopated","seed":12}', parametersTruncated: false });
  assert.equal(candidate.midi!.parts.length, 2);
  assert.deepEqual(candidate.midi!.notes.map((note) => note.pitch), [60, 60]);
  assert.deepEqual(restarted.continuation, parent);
  assert.equal(restarted.artifacts.find((entry) => entry.ref.kind === "audio")!.generation, undefined);
  assert.doesNotMatch(JSON.stringify(restarted), /connectionFingerprint|authorization|apiKey|\/private\//);
  assert.deepEqual(await listSessionArtifacts(input), restarted, "a fresh read rebuilds the same state without process-local candidate storage");
  const other = await createSession(h.storage, { title: "Other", projectKey: "test-project", scope: { kind: "selection", identity: "other", label: "Other" } });
  assert.deepEqual((await listSessionArtifacts({ ...input, sessionId: other.id })).artifacts, []);
  for (const ref of [parent, { kind: "midi" as const, id: midi.id }]) {
    await assert.rejects(selectSessionArtifact({ ...input, sessionId: other.id, selection: { action: "continue", candidate: ref } }));
  }
  assert.equal((await loadSessionEvents(h.storage, other.id)).length, 0);
});

test("pending continuation survives failed admission, preferences, read tools and compaction; initial user consumes it", async (t) => {
  const h = await audioStorageHarness(t); const audio = await h.save("vocals");
  const a = { kind: "audio" as const, id: audio.id }; const b = { kind: "midi" as const, id: "midi-b" };
  const input = { storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal };
  await selectSessionArtifact({ ...input, selection: { action: "continue", candidate: a } });
  await assert.rejects(selectSessionArtifact({ ...input, selection: { action: "continue", candidate: b } }));
  await appendSessionEvent(h.storage, h.session.id, { kind: "candidate", content: "Preferred B", candidateSelection: { action: "prefer", candidate: b } });
  await appendSessionEvent(h.storage, h.session.id, { kind: "tool_call", name: "get_audio_job", content: "{}" });
  await appendSessionEvent(h.storage, h.session.id, { kind: "compaction", content: "Checkpoint" });
  let events = await loadSessionEvents(h.storage, h.session.id);
  assert.deepEqual(pendingArtifactParentFromEvents(events), a);
  assert.ok(events.some((event) => event.candidateSelection?.action === "prefer"));
  assert.equal(isArtifactSelection({ action: "prefer", candidate: b }), true);
  await assert.rejects(selectSessionArtifact({ ...input, selection: { action: "prefer", candidate: a } }), /source or primary version/);
  await assert.rejects(appendSessionEvent(h.storage, h.session.id, { kind: "user", content: "Fail before commit", parentCandidate: { kind: "midi", id: "../bad" } }));
  assert.deepEqual(pendingArtifactParentFromEvents(await loadSessionEvents(h.storage, h.session.id)), a);
  const user = await appendSessionEvent(h.storage, h.session.id, { kind: "user", content: "Variation", parentCandidate: a });
  events = await loadSessionEvents(h.storage, h.session.id);
  assert.equal(pendingArtifactParentFromEvents(events), undefined);
  user.parentCandidate!.id = "changed-return-value";
  assert.deepEqual((await loadSessionEvents(h.storage, h.session.id)).at(-1)!.parentCandidate, a);
  await appendSessionEvent(h.storage, h.session.id, { kind: "candidate", content: "Prepare B", candidateSelection: { action: "continue", candidate: b } });
  await appendSessionEvent(h.storage, h.session.id, { kind: "tool_call", name: "generate", content: "{}", parentCandidate: a, requestEventId: user.id });
  assert.deepEqual(pendingArtifactParentFromEvents(await loadSessionEvents(h.storage, h.session.id)), b);
});

test("overlapping same-name calls keep provenance unknown instead of guessing", () => {
  const event = (id: string, kind: SessionEvent["kind"], content: string): SessionEvent => ({ id, kind, name: "make", content, createdAt: "2026-10-03T00:00:00Z" });
  const events = [event("a", "tool_call", '{"seed":1}'), event("b", "tool_call", '{"seed":2}'),
    event("ra", "tool_result", '{"artifacts":[{"kind":"midi","artifactRef":"midi-a"}]}'),
    event("rb", "tool_result", '{"artifacts":[{"kind":"midi","artifactRef":"midi-b"}]}')];
  assert.equal(artifactGenerationsFromEvents(events).size, 0);
});

test("a stopped chat tool cannot hide provenance from later successful requests", async (t) => {
  const h = await audioStorageHarness(t);
  const run = async (stop: boolean, label: string) => {
    const controller = createHostAbortController();
    await appendSessionEvent(h.storage, h.session.id, { kind: "user", content: label });
    let turns = 0;
    await runAgentLoop({ signal: controller.signal, maxConsecutiveFailures: 3,
      askModel: async () => ++turns === 1
        ? { content: null, toolCalls: [{ id: "make", name: "make_midi", arguments: JSON.stringify({ label }) }] }
        : { content: "Saved.", toolCalls: [] },
      externalTools: { names: ["make_midi"], execute: async () => {
        if (stop) { controller.abort(new Error("Stopped")); throw controller.signal.reason; }
        const artifact = await saveMidiArtifact(h.storage, h.session.id, { connectionId: "generator", serverId: "midi",
          toolName: "make_midi", label, bytes: midiBytes({ tracks: [noteTrack()] }), signal: controller.signal });
        return { content: JSON.stringify({ artifacts: [{ kind: "midi", artifactRef: artifact.id }] }) };
      } },
      observe: async () => assert.fail("No Live observation expected"), confirmActions: async () => false,
      executeActions: async () => assert.fail("No Live mutation expected"),
      onEvent: async (event) => { await appendSessionEvent(h.storage, h.session.id, event); },
    });
  };
  await assert.rejects(run(true, "Stopped generation"), /Stopped/);
  const stopped = await loadSessionEvents(h.storage, h.session.id);
  assert.deepEqual(stopped.map((event) => event.kind), ["user", "tool_call"]);
  await run(false, "First retry");
  await run(false, "Next generation");
  const catalog = await listSessionArtifacts({ storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal });
  assert.equal(catalog.artifacts.length, 2);
  for (const artifact of catalog.artifacts) {
    assert.equal(artifact.generation?.toolName, "make_midi");
    assert.deepEqual(JSON.parse(artifact.generation!.parameters), { label: artifact.label });
    assert.notEqual(artifact.generation!.callEventId, stopped[1]!.id);
  }
});

test("steering preserves an in-flight tool's provenance", () => {
  const events: SessionEvent[] = [
    { id: "request", kind: "user", content: "Generate", createdAt: "2026-10-03T00:00:00Z" },
    { id: "call", kind: "tool_call", name: "make", content: '{"seed":1}', createdAt: "2026-10-03T00:00:01Z" },
    { id: "steer", kind: "user", content: "Keep the rhythm", createdAt: "2026-10-03T00:00:02Z",
      steeringReceipt: { sendId: "send", id: "steer", sha256: "0".repeat(64) } },
    { id: "result", kind: "tool_result", name: "make", content: '{"artifacts":[{"kind":"midi","artifactRef":"midi-a"}]}', createdAt: "2026-10-03T00:00:03Z" },
  ];
  assert.equal(artifactGenerationsFromEvents(events).get("midi:midi-a")?.generation.callEventId, "call");
});

test("a stopped chat error permits the same Plugin tool to recover provenance from a manual panel call", async (t) => {
  const h = await audioStorageHarness(t);
  const serverPath = path.join(h.storage, "midi-server.mjs");
  const tool = { name: "make_midi", inputSchema: { type: "object", properties: { style: { type: "string" }, destination: { type: "string" } }, required: ["style", "destination"] },
    _meta: { "io.github.samkuler/live-smith-artifacts": { version: 1, inputs: [], outputs: [{ argument: "destination", kind: "midi", label: "Manual take" }] } } };
  await fs.writeFile(serverPath, `
    import fs from "node:fs/promises";
    import readline from "node:readline";
    const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
    readline.createInterface({ input: process.stdin }).on("line", async (line) => {
      const request = JSON.parse(line);
      if (request.method === "server/discover") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "legacy" } }) + "\\n");
      else if (request.method === "initialize") send(request.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "midi", version: "1" } });
      else if (request.method === "tools/list") send(request.id, { tools: [${JSON.stringify(tool)}] });
      else if (request.method === "tools/call") {
        await fs.writeFile(request.params.arguments.destination, new Uint8Array(${JSON.stringify([...midiBytes({ tracks: [noteTrack()] })])}));
        send(request.id, { content: [{ type: "text", text: "Saved" }] });
      }
    });
  `);
  await saveGlobalSettings(h.storage, { integrationConnections: { action: "upsert", expectedRevision: "0", connection: {
    id: "midi-generator", name: "MIDI generator", enabled: true, mcp: { type: "stdio", command: execPath, args: [serverPath] },
    secrets: {}, artifactInputApproved: false, artifactOutputApproved: true,
  } } });
  const authorize = async <T>(_signal: AbortSignal, operation: () => Promise<T>): Promise<T> => operation();
  const discovery = await createRequestPluginTools({ storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal, withAuthorization: authorize });
  const panel = discovery.catalogTools()[0]!.panel!;
  await discovery.close();
  const controller = createHostAbortController();
  await appendSessionEvent(h.storage, h.session.id, { kind: "user", content: "Generate MIDI" });
  await assert.rejects(runAgentLoop({ signal: controller.signal, maxConsecutiveFailures: 3,
    askModel: async () => ({ content: null, toolCalls: [{ id: "make", name: panel.toolName, arguments: '{"style":"chat"}' }] }),
    externalTools: { names: [panel.toolName], execute: async () => { controller.abort(new Error("Stopped")); throw controller.signal.reason; } },
    observe: async () => assert.fail("No Live observation expected"), confirmActions: async () => false,
    executeActions: async () => assert.fail("No Live mutation expected"),
    onEvent: async (event) => { await appendSessionEvent(h.storage, h.session.id, event); },
  }), /Stopped/);
  await appendSessionEvent(h.storage, h.session.id, { kind: "error", content: "Stopped" });
  assert.deepEqual(await runPluginParameterTool({ storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal,
    toolName: panel.toolName, signature: panel.signature, arguments: { style: "manual" }, withPluginAuthorization: authorize }), { failed: false });
  const events = await loadSessionEvents(h.storage, h.session.id);
  assert.deepEqual(events.map((event) => event.kind), ["user", "tool_call", "error", "tool_call", "tool_result"]);
  const catalog = await listSessionArtifacts({ storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal });
  assert.equal(catalog.artifacts[0]?.generation?.callEventId, events[3]!.id);
  assert.deepEqual(JSON.parse(catalog.artifacts[0]!.generation!.parameters), { style: "manual" });
});

test("Fill retains its enclosing lifecycle across recoverable model errors and cancelled inner calls", async (t) => {
  const h = await continuationHarness(t);
  const cancelled = createHostAbortController();
  const fill = (stop: boolean) => {
    const signal = stop ? cancelled.signal : h.signal;
    return fillMidiContinuation({ ...h, signal, bufferId: h.buffer.id,
      validateGenerator: async () => {}, onProgress: async () => {},
      generate: (buffer, onEvent) => {
        let turns = 0;
        return generateMidiContinuationWithModel({
        storageDirectory: h.directory, buffer, signal, runtimeProfile: h.runtime, onEvent, onProgress: async () => {},
        readTools: createSessionArtifactToolset({ storageDirectory: h.directory, sessionId: h.session.id, signal }),
        beforeCommit: () => {}, beforeSave: async () => {
          if (stop) { cancelled.abort(new Error("Stopped Fill")); throw cancelled.signal.reason; }
        },
        requestTurn: async () => ++turns === 1
          ? { content: null, toolCalls: Array.from({ length: 9 }, (_, index) => ({ id: `excess-${index}`, name: "save_midi_artifact", arguments: "{}" })) }
          : ({ content: null, toolCalls: [{ id: "save", name: "save_midi_artifact", arguments: JSON.stringify({
          label: `Section ${buffer.nextSequence + 1}`, tracks: [{ name: "Bass", channel: 1,
            notes: [{ pitch: 48, startTime: 0, duration: 4, velocity: 90 }] }],
        }) }] }),
        });
      },
    });
  };
  await assert.rejects(fill(true), /Stopped Fill/);
  const stopped = await loadSessionEvents(h.directory, h.session.id);
  assert.deepEqual(stopped.map((event) => [event.kind, event.name]), [
    ["tool_call", "fill_midi_continuation"], ["error", undefined],
    ["tool_call", "save_midi_artifact"], ["tool_result", "fill_midi_continuation"],
  ]);
  const filled = await fill(false);
  const events = await loadSessionEvents(h.directory, h.session.id);
  assert.equal(events.some((event) => event.kind === "user"), false);
  const request = events.filter((event) => event.kind === "tool_call" && event.name === "fill_midi_continuation").at(-1)!;
  const generations = artifactGenerationsFromEvents(events);
  for (const [index, section] of filled.queue.entries()) {
    const generation = generations.get(`midi:${section.artifactRef}`);
    assert.equal(generation?.generation.requestEventId, request.id);
    assert.equal(generation?.parent?.id, index ? filled.queue[index - 1]!.artifactRef : h.buffer.sourceArtifactRef);
  }
});

test("an unscoped error cannot disambiguate overlapping same-name calls", () => {
  const event = (id: string, kind: SessionEvent["kind"], content: string): SessionEvent => ({ id, kind, name: "make", content, createdAt: "2026-10-03T00:00:00Z" });
  const events = [event("a", "tool_call", '{"seed":1}'), event("b", "tool_call", '{"seed":2}'),
    { id: "error", kind: "error" as const, content: "A tool failed", createdAt: "2026-10-03T00:00:00Z" },
    event("later", "tool_call", '{"seed":3}'),
    event("ra", "tool_result", '{"artifacts":[{"kind":"midi","artifactRef":"midi-a"}]}'),
    event("rb", "tool_result", '{"artifacts":[{"kind":"midi","artifactRef":"midi-b"}]}'),
    event("rc", "tool_result", '{"artifacts":[{"kind":"midi","artifactRef":"midi-c"}]}')];
  assert.equal(artifactGenerationsFromEvents(events).size, 0);
});

for (const content of ['{"status":"failed"}', "The tool did not return a confirmed result."]) {
  test(`an enclosing terminal result closes unfinished child calls: ${content}`, () => {
    const event = (id: string, kind: SessionEvent["kind"], name: string, content: string, requestEventId?: string): SessionEvent => ({
      id, kind, name, content, createdAt: "2026-10-03T00:00:00Z", ...(requestEventId ? { requestEventId } : {}),
    });
    const events = [event("parent-a", "tool_call", "workflow", "{}"), event("child-a", "tool_call", "make", "{}", "parent-a"),
      event("ended-a", "tool_result", "workflow", content), event("parent-b", "tool_call", "workflow", "{}"),
      event("child-b", "tool_call", "make", "{}", "parent-b"),
      event("result-b", "tool_result", "make", '{"artifacts":[{"kind":"midi","artifactRef":"midi-b"}]}')];
    assert.equal(artifactGenerationsFromEvents(events).get("midi:midi-b")?.generation.callEventId, "child-b");
  });
}

test("saved MIDI inspection pages exact notes without provider calls and rejects foreign parts", async (t) => {
  const h = await audioStorageHarness(t);
  const saved = await saveMidiArtifact(h.storage, h.session.id, { connectionId: "generator", serverId: "midi", toolName: "make",
    label: "Long pattern", bytes: midiBytes({ tracks: [sequentialNotes(300)] }), signal: h.signal });
  const tools = createSessionArtifactToolset({ storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal });
  const inspect = (args: unknown) => tools.callTool({ id: "inspect", name: "inspect_midi_artifact", arguments: JSON.stringify(args) });
  const first = JSON.parse((await inspect({ artifactRef: saved.id, partId: "track-0-channel-1" })).content);
  assert.equal(first.notes.length, 256); assert.equal(first.nextOffset, 256); assert.equal(first.part.noteCount, 300);
  const second = JSON.parse((await inspect({ artifactRef: saved.id, partId: "track-0-channel-1", offset: first.nextOffset })).content);
  assert.equal(second.notes.length, 44); assert.equal(second.nextOffset, undefined);
  assert.equal(second.notes[0].startTime, 256 / 480);
  for (const patch of [{ artifactRef: "other-session-artifact" }, { partId: "track-99-channel-1" }, { offset: -1 }, { offset: 301 }, { path: "private" }]) {
    assert.equal((await inspect({ artifactRef: saved.id, partId: "track-0-channel-1", ...patch })).invalidArguments, true);
  }
  const listing = await listSessionArtifacts({ storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal });
  assert.equal(listing.artifacts[0]!.midi!.notes.length, 256); assert.equal(listing.artifacts[0]!.midi!.omittedNoteCount, 44);
  assert.equal(artifactKey(listing.artifacts[0]!.ref), `midi:${saved.id}`);
  const exact = await readSessionArtifact({ storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal,
    artifact: { kind: "midi", id: saved.id } });
  assert.equal(exact.artifact.midi!.notes.length, 300);
  assert.equal(exact.artifact.midi!.omittedNoteCount, 0);
  assert.equal(exact.artifact.midi!.notes.at(-1)!.startTime, 299 / 480);
  assert.equal(isSessionArtifactDetail(exact), true);
  assert.equal(isSessionArtifacts(listing), true);
  assert.equal(isSessionArtifactDetail({ ...exact, artifact: listing.artifacts[0] }), false);
  assert.equal(isSessionArtifacts({ ...listing, artifacts: [exact.artifact] }), false);
  assert.equal(isSessionArtifactDetail({ ...exact, artifact: { ...exact.artifact, midi: {
    ...exact.artifact.midi, notes: Array(4097).fill(exact.artifact.midi!.notes[0]), noteCount: 4097,
  } } }), false);
});

test("artifact commands admit only exact Session references and selection semantics", () => {
  const command = { kind: "select_artifact", sessionId: "session", selection: { action: "continue", candidate: { kind: "midi", id: "midi-one" } } };
  assert.deepEqual(parseCommandInput(command), command);
  assert.throws(() => parseCommandInput({ ...command, selection: { ...command.selection, action: "prefer" } }));
  assert.throws(() => parseCommandInput({ ...command, parameters: { secret: true } }));
  assert.throws(() => parseCommandInput({ ...command, selection: { action: "generate", candidate: command.selection.candidate } }));
  assert.throws(() => parseCommandInput({ ...command, selection: { action: "prefer", candidate: { kind: "midi", id: "../other" } } }));
});

test("MIDI part previews read the owned source beyond the bounded catalog overview", async (t) => {
  const h = await audioStorageHarness(t);
  const saved = await saveMidiArtifact(h.storage, h.session.id, { connectionId: "generator", serverId: "midi", toolName: "make",
    label: "Two parts", bytes: midiBytes({ tracks: [sequentialNotes(300), noteTrack({ startTicks: 480, channel: 2, pitch: 72 })] }), signal: h.signal });
  const input = { storageDirectory: h.storage, sessionId: h.session.id, projectKey: "test-project", signal: h.signal };
  const catalog = await listSessionArtifacts(input);
  assert.equal(catalog.artifacts[0]!.midi!.notes.length, 256);
  assert.equal(catalog.artifacts[0]!.midi!.omittedNoteCount, 45);
  assert.ok(catalog.artifacts[0]!.midi!.notes.every((note) => note.partId === "track-0-channel-1"));

  const later = await readSessionMidiPartPreview({ ...input, artifactRef: saved.id, partId: "track-1-channel-2" });
  assert.deepEqual(later, { sessionId: h.session.id, artifactRef: saved.id, partId: "track-1-channel-2",
    notes: [{ partId: "track-1-channel-2", pitch: 72, startTime: 1, duration: 1, velocity: 96 }], omittedNoteCount: 0 });
  assert.equal(isMidiPartPreview(later), true);
  const earlier = await readSessionMidiPartPreview({ ...input, artifactRef: saved.id, partId: "track-0-channel-1" });
  assert.equal(earlier.notes.length, 300); assert.equal(earlier.omittedNoteCount, 0);
  assert.equal(isMidiPartPreview(earlier), true);
  assert.deepEqual(earlier.notes.map((note) => note.startTime), Array.from({ length: 300 }, (_, index) => index / 480));
  assert.deepEqual(await listSessionArtifacts(input), catalog);
  assert.deepEqual(await loadSessionEvents(h.storage, h.session.id), []);

  const other = await createSession(h.storage, { title: "Other", projectKey: "test-project", scope: { kind: "selection", identity: "other", label: "Other" } });
  for (const patch of [{ sessionId: other.id }, { sessionId: "unknown" }, { projectKey: "foreign-project" },
    { artifactRef: "unknown" }, { partId: "track-1-channel-1" }, { partId: "track-99-channel-2" }]) {
    await assert.rejects(readSessionMidiPartPreview({ ...input, artifactRef: saved.id, partId: "track-1-channel-2", ...patch }));
  }
  for (const patch of [{ sessionId: "../other" }, { artifactRef: "../other" }, { partId: "" },
    { omittedNoteCount: -1 }, { omittedNoteCount: 1.5 }, { omittedNoteCount: 1 }, { notes: Array(4097).fill(later.notes[0]) },
    { notes: [{ ...later.notes[0], partId: "track-0-channel-1" }] },
    ...[{ pitch: 128 }, { startTime: -1 }, { duration: NaN }].map((note) => ({ notes: [{ ...later.notes[0], ...note }] }))]) {
    assert.equal(isMidiPartPreview({ ...later, ...patch }), false);
  }
});


test("MIDI revisions form one logical library item before pagination and exact reads preserve version provenance", async (t) => {
  const h = await audioStorageHarness(t);
  const input = { storageDirectory: h.storage, sessionId: h.session.id, projectKey: "test-project", signal: h.signal };
  const save = (label: string, pitch: number, revisionOf?: string) => saveMidiArtifact(h.storage, h.session.id, {
    connectionId: "generator", serverId: "midi", toolName: "make", label,
    bytes: midiBytes({ tracks: [noteTrack({ pitch })] }), ...(revisionOf ? { revisionOf } : {}), signal: h.signal,
  });
  const original = await save("Theme", 60);
  let latest = original;
  for (let version = 2; version <= 27; version++) latest = await save(`Theme ${version}`, 60 + version, latest.id);
  const audio = await h.save("vocals");
  for (let index = 0; index < 24; index++) await save(`Work ${index}`, 48);
  const first = await listSessionArtifacts(input);
  const second = await listSessionArtifacts({ ...input, offset: 24 });
  assert.equal(first.total, 26); assert.equal(first.artifacts.length, 24); assert.equal(second.artifacts.length, 2);
  assert.equal(isSessionArtifacts(first), true); assert.equal(isSessionArtifacts(second), true);
  const all = [...first.artifacts, ...second.artifacts];
  assert.equal(new Set(all.map((artifact) => artifact.version?.groupId ?? artifactKey(artifact.ref))).size, 26);
  const work = all.find((artifact) => artifact.version?.groupId === original.id)!;
  assert.equal(work.ref.id, latest.id); assert.equal(work.version!.number, 27);
  assert.deepEqual(work.versions!.map((version) => version.number), Array.from({ length: 27 }, (_, index) => index + 1));
  assert.equal(work.midi!.notes[0]!.pitch, 87);
  const exact = await readSessionArtifact({ ...input, artifact: { kind: "midi", id: original.id } });
  assert.equal(isSessionArtifactDetail(exact), true); assert.equal(exact.artifact.ref.id, original.id);
  assert.equal(exact.artifact.version!.number, 1); assert.equal(exact.artifact.midi!.notes[0]!.pitch, 60);
  assert.deepEqual(exact.artifact.versions, work.versions);
  const audioDetail = await readSessionArtifact({ ...input, artifact: { kind: "audio", id: audio.id } });
  assert.deepEqual(audioDetail.artifact, all.find((artifact) => artifact.ref.id === audio.id));
  assert.doesNotMatch(JSON.stringify(exact), /sha256|byteLength|connectionId|storageDirectory|bytes/);
  const other = await createSession(h.storage, { title: "Other", projectKey: "test-project", scope: { kind: "selection", identity: "other", label: "Other" } });
  for (const patch of [{ sessionId: other.id }, { projectKey: "foreign-project" },
    { artifact: { kind: "midi" as const, id: "missing" } }, { artifact: { kind: "audio" as const, id: original.id } }]) {
    await assert.rejects(readSessionArtifact({ ...input, artifact: { kind: "midi", id: original.id }, ...patch }));
  }
  assert.deepEqual(await loadSessionEvents(h.storage, h.session.id), []);
  const selected = { ...exact, artifact: { ...exact.artifact, versions: [{ ...exact.artifact.versions![0], number: 0 }] } };
  assert.equal(isSessionArtifactDetail(selected), false);
});

test("unreadable MIDI revisions fall back to the newest readable version without duplicate items", async (t) => {
  const h = await audioStorageHarness(t);
  const input = { storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal };
  const save = (revisionOf?: string) => saveMidiArtifact(h.storage, h.session.id, { connectionId: "generator", serverId: "midi", toolName: "make",
    label: "Theme", bytes: midiBytes({ tracks: [noteTrack()] }), ...(revisionOf ? { revisionOf } : {}), signal: h.signal });
  const original = await save(); const revision = await save(original.id);
  const blob = path.join(h.storage, "live-smith-midi", h.session.id, `${revision.id}.mid`);
  const bytes = await fs.readFile(blob); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; await fs.writeFile(blob, bytes);
  const catalog = await listSessionArtifacts(input);
  assert.equal(catalog.total, 1); assert.equal(catalog.unavailableCount, 1);
  assert.equal(catalog.artifacts[0]!.ref.id, original.id);
  assert.deepEqual(catalog.artifacts[0]!.versions!.map((version) => version.id), [original.id, revision.id]);
  await assert.rejects(readSessionArtifact({ ...input, artifact: { kind: "midi", id: revision.id } }));
});


test("primary versions persist independently per work, drive defaults, and preserve exact reads and continuation", async (t) => {
  const h = await audioStorageHarness(t);
  const input = { storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal };
  const save = (label: string, revisionOf?: string) => saveMidiArtifact(h.storage, h.session.id, {
    connectionId: "generator", serverId: "midi", toolName: "make", label,
    bytes: midiBytes({ tracks: [noteTrack()] }), signal: h.signal, ...(revisionOf ? { revisionOf } : {}),
  });
  const a1 = await save("Theme A"); const a2 = await save("Theme A revised", a1.id);
  const b1 = await save("Theme B"); const b2 = await save("Theme B revised", b1.id);
  const ref = (id: string) => ({ kind: "midi" as const, id });
  await selectSessionArtifact({ ...input, selection: { action: "continue", candidate: ref(a2.id) } });
  for (const original of [a1, b1]) await selectSessionArtifact({ ...input,
    selection: { action: "primary", group: ref(original.id), candidate: ref(original.id) } });
  const list = await listSessionArtifacts(input);
  assert.deepEqual(new Set(list.artifacts.map((entry) => entry.ref.id)), new Set([a1.id, b1.id]));
  assert.ok(list.artifacts.every((entry) => entry.primary?.id === entry.ref.id));
  assert.deepEqual(list.continuation, ref(a2.id));
  const tools = createSessionArtifactToolset({ storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal });
  const modelList = JSON.parse((await tools.callTool({ id: "list-primary", name: "list_session_artifacts", arguments: "{}" })).content);
  assert.deepEqual(modelList.filter((entry: { defaultForWork: boolean }) => entry.defaultForWork)
    .map((entry: { artifactRef: string }) => entry.artifactRef).sort(), [a1.id, b1.id].sort());
  assert.deepEqual(modelList.find((entry: { artifactRef: string }) => entry.artifactRef === a2.id).primary, ref(a1.id));
  const exact = await readSessionArtifact({ ...input, artifact: ref(a2.id) });
  assert.equal(exact.artifact.ref.id, a2.id); assert.deepEqual(exact.artifact.primary, ref(a1.id));
  assert.equal(isSessionArtifactDetail(exact), true);
  assert.equal(isSessionArtifactDetail({ ...exact, artifact: { ...exact.artifact, primary: ref(b1.id) } }), false);
  const savedEvents = await loadSessionEvents(h.storage, h.session.id);
  assert.equal(savedEvents.filter((event) => event.candidateSelection?.action === "primary").length, 2);
  assert.ok(savedEvents.every((event) => event.kind === "candidate"));
  await appendSessionEvent(h.storage, h.session.id, { kind: "candidate", content: "Legacy preference",
    candidateSelection: { action: "prefer", candidate: ref(b2.id) } });
  assert.deepEqual((await listSessionArtifacts(input)).artifacts, list.artifacts);
  await selectSessionArtifact({ ...input, selection: { action: "primary", group: ref(a1.id), candidate: null } });
  const cleared = await listSessionArtifacts(input);
  assert.equal(cleared.artifacts.find((entry) => entry.version?.groupId === a1.id)!.ref.id, a2.id);
  assert.equal(cleared.artifacts.find((entry) => entry.version?.groupId === a1.id)!.primary, undefined);
  assert.equal(cleared.artifacts.find((entry) => entry.version?.groupId === b1.id)!.ref.id, b1.id);
  assert.deepEqual(cleared.continuation, ref(a2.id));
});

test("primary commands reject other works and Sessions; unavailable saved primaries fall back to newest", async (t) => {
  const h = await audioStorageHarness(t);
  const input = { storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal };
  const save = (revisionOf?: string) => saveMidiArtifact(h.storage, h.session.id, { connectionId: "generator", serverId: "midi", toolName: "make",
    label: "Theme", bytes: midiBytes({ tracks: [noteTrack()] }), signal: h.signal, ...(revisionOf ? { revisionOf } : {}) });
  const original = await save(); const revision = await save(original.id); const unrelated = await save();
  const ref = (id: string) => ({ kind: "midi" as const, id });
  const group = ref(original.id);
  const other = await createSession(h.storage, { title: "Other", projectKey: "test-project", scope: { kind: "selection", identity: "other", label: "Other" } });
  await assert.rejects(selectSessionArtifact({ ...input, selection: { action: "primary", group, candidate: ref(unrelated.id) } }));
  await assert.rejects(selectSessionArtifact({ ...input, selection: { action: "primary", group: ref("missing"), candidate: null } }));
  await assert.rejects(selectSessionArtifact({ ...input, sessionId: other.id, selection: { action: "primary", group, candidate: ref(original.id) } }));
  assert.equal((await loadSessionEvents(h.storage, h.session.id)).length, 0);
  await selectSessionArtifact({ ...input, selection: { action: "primary", group, candidate: ref(original.id) } });
  const blob = path.join(h.storage, "live-smith-midi", h.session.id, `${original.id}.mid`);
  const bytes = await fs.readFile(blob); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; await fs.writeFile(blob, bytes);
  const fallback = (await listSessionArtifacts(input)).artifacts.find((entry) => entry.version?.groupId === original.id)!;
  assert.equal(fallback.ref.id, revision.id); assert.equal(fallback.primary, undefined);
  await appendSessionEvent(h.storage, h.session.id, { kind: "candidate", content: "Stale primary",
    candidateSelection: { action: "primary", group, candidate: ref(unrelated.id) } });
  assert.equal((await listSessionArtifacts(input)).artifacts.find((entry) => entry.version?.groupId === original.id)!.primary, undefined);
});

test("audio candidate versions share the generic work catalog and primary contract while stems remain independent", async (t) => {
  const h = await audioStorageHarness(t, generationJobCases.find((entry) => entry.input.provider === "sunoapi")!.input);
  const first = await h.save("music"); const second = await h.save("music_alternative");
  const midi = await saveMidiArtifact(h.storage, h.session.id, { connectionId: "generator", serverId: "midi", toolName: "make",
    label: "MIDI work", bytes: midiBytes({ tracks: [noteTrack()] }), signal: h.signal });
  const input = { storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal };
  const initial = await listSessionArtifacts(input);
  assert.equal(initial.total, 2);
  const audio = initial.artifacts.find((entry) => entry.ref.kind === "audio")!;
  assert.equal(audio.ref.id, second.id);
  assert.deepEqual(audio.version, { groupId: first.id, number: 2, groupLabel: "music · Music" });
  assert.deepEqual(audio.versions!.map((entry) => [entry.id, entry.number, entry.derivedFromId]), [[first.id, 1, undefined], [second.id, 2, undefined]]);
  const primary = { kind: "audio" as const, id: first.id };
  await selectSessionArtifact({ ...input, selection: { action: "primary", group: primary, candidate: primary } });
  const selected = await listSessionArtifacts(input);
  assert.equal(isSessionArtifacts(selected), true);
  assert.equal(selected.artifacts.find((entry) => entry.ref.kind === "audio")!.ref.id, first.id);
  assert.equal(selected.artifacts.find((entry) => entry.ref.kind === "midi")!.ref.id, midi.id);
  const exact = await readSessionArtifact({ ...input, artifact: { kind: "audio", id: second.id } });
  assert.equal(exact.artifact.ref.id, second.id); assert.deepEqual(exact.artifact.primary, primary);
  const stems = await audioStorageHarness(t); await stems.save("vocals"); await stems.save("drums");
  assert.equal((await listSessionArtifacts({ storageDirectory: stems.storage, sessionId: stems.session.id, signal: stems.signal })).total, 2);
});

test("artifact command parser admits scoped primary set and clear without accepting malformed histories", () => {
  const group = { kind: "audio", id: "audio-work" }; const candidate = { kind: "audio", id: "audio-version" };
  for (const value of [candidate, null]) {
    const command = { kind: "select_artifact", sessionId: "session", selection: { action: "primary", group, candidate: value } };
    assert.deepEqual(parseCommandInput(command), command); assert.equal(isArtifactSelection(command.selection), true);
  }
  for (const selection of [
    { action: "primary", candidate }, { action: "primary", group, candidate: { kind: "midi", id: "midi-version" } },
    { action: "primary", group: { ...group, id: "../work" }, candidate }, { action: "continue", group, candidate },
    { action: "primary", group, candidate, extra: true },
  ]) assert.throws(() => parseCommandInput({ kind: "select_artifact", sessionId: "session", selection }));
});


test("Plugin audio uses the same version group as its built-in source without fabricated jobs", async (t) => {
  const h = await rawAudioStorageHarness(t, generationJobCases[0]!.input);
  const { version: _version, ...source } = await h.save("music");
  await fs.writeFile(path.join(h.directory, `${source.id}.asset.json`), JSON.stringify(source));
  await updateAudioJob(h.storage, h.session.id, h.job.id, { outputAssets: [source] });
  const parent = { kind: "audio" as const, id: source.id };
  const call = await appendSessionEvent(h.storage, h.session.id, { kind: "tool_call", name: "transform_audio", content: '{"amount":0.5}', parentCandidate: parent });
  const plugin = await savePluginAudioArtifact(h.storage, h.session.id, { connectionId: "audio-transform", serverId: "audio", toolName: "transform_audio",
    label: "Transformed theme", bytes: waveBytes(), format: "wav", revisionOf: parent, signal: h.signal });
  const result = await appendSessionEvent(h.storage, h.session.id, { kind: "tool_result", name: "transform_audio",
    content: JSON.stringify({ _meta: { "io.github.samkuler/live-smith-artifacts": { version: 1, artifacts: [{ kind: "audio", artifactRef: plugin.id }] } } }) });
  const input = { storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal };
  const catalog = await listSessionArtifacts(input);
  assert.equal(catalog.total, 1); assert.equal(catalog.artifacts[0]!.ref.id, plugin.id);
  assert.equal(catalog.artifacts[0]!.audio!.jobId, undefined);
  assert.equal(catalog.artifacts[0]!.version!.derivedFromId, source.id);
  assert.deepEqual(catalog.artifacts[0]!.versions!.map((entry) => entry.id), [source.id, plugin.id]);
  assert.deepEqual(catalog.artifacts[0]!.parent, parent);
  assert.deepEqual(catalog.artifacts[0]!.generation, { toolName: "transform_audio", callEventId: call.id, resultEventId: result.id,
    parameters: '{"amount":0.5}', parametersTruncated: false });
  assert.equal(isSessionArtifacts(catalog), true);
  await selectSessionArtifact({ ...input, selection: { action: "primary", group: parent, candidate: parent } });
  assert.equal((await listSessionArtifacts(input)).artifacts[0]!.ref.id, source.id);
  const exact = await readSessionArtifact({ ...input, artifact: { kind: "audio", id: plugin.id } });
  assert.equal(exact.artifact.ref.id, plugin.id); assert.deepEqual(exact.artifact.primary, parent);
  const blob = path.join(h.storage, "live-smith-audio-artifacts", h.session.id, `${plugin.id}.audio`);
  await fs.rm(blob);
  await selectSessionArtifact({ ...input, selection: { action: "primary", group: parent, candidate: null } });
  const fallback = await listSessionArtifacts(input);
  assert.equal(fallback.artifacts[0]!.ref.id, source.id);
});

test("audio recovery receipts become public artifacts only after output ownership commits", async (t) => {
  const h = await rawAudioStorageHarness(t);
  const asset = await h.save("vocals");
  const input = { storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal };
  assert.equal((await listSessionArtifacts(input)).total, 0);
  await assert.rejects(selectSessionArtifact({ ...input, selection: { action: "continue", candidate: { kind: "audio", id: asset.id } } }));
  await updateAudioJob(h.storage, h.session.id, h.job.id, { outputAssets: [asset] });
  assert.equal((await listSessionArtifacts(input)).artifacts[0]!.ref.id, asset.id);
});

test("provider audio recovers saved sources without a tool result and retains legacy event provenance", async (t) => {
  const jobInput = generationJobCases[0]!.input;
  const h = await rawAudioStorageHarness(t, jobInput);
  const midi = await saveMidiArtifact(h.storage, h.session.id, { pluginId: "renderer", serverId: "local", toolName: "compose",
    label: "Theme", bytes: midiBytes({ tracks: [noteTrack()] }), signal: h.signal });
  const parent = { kind: "midi" as const, id: midi.id };
  const input = { storageDirectory: h.storage, sessionId: h.session.id, signal: h.signal };
  for (const persistedSource of [true, false]) {
    const name = persistedSource ? "render_saved_source" : "render_legacy_source";
    const call = await appendSessionEvent(h.storage, h.session.id, { kind: "tool_call", name, content: "{}", parentCandidate: parent });
    const job = await createAudioJob(h.storage, h.session.id, {
      ...jobInput, ...(persistedSource ? { artifactSource: parent } : {}),
    });
    const asset = await saveAudioAsset(h.storage, h.session.id, { jobId: job.id, role: "music", label: "Rendered theme",
      bytes: waveBytes(), origin: { kind: "generated" }, signal: h.signal });
    const completed = await updateAudioJob(h.storage, h.session.id, job.id, { outputAssets: [asset], status: "completed" });
    if (!persistedSource) await appendSessionEvent(h.storage, h.session.id, {
      kind: "tool_result", name, content: JSON.stringify(completed),
    });
    const detail = await readSessionArtifact({ ...input, artifact: { kind: "audio", id: asset.id } });
    assert.deepEqual(detail.artifact.parent, parent);
    assert.equal(detail.artifact.generation?.callEventId, persistedSource ? undefined : call.id);
    const listed = (await listSessionArtifacts(input)).artifacts.find((entry) => entry.ref.id === asset.id)!;
    assert.deepEqual(listed.parent, parent);
  }
});
