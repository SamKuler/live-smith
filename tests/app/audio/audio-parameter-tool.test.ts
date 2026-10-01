import assert from "node:assert/strict";
import test from "node:test";
import { audioRecoveryHarness } from "./support/audio-recovery-test-helpers.js";
import { loadAudioParameterGroups, runAudioParameterTool } from "../../../src/app/audio/audio-parameter-tool.js";
import { parseCommandInput } from "../../../src/app/chat/chat-bridge-http.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import { listAudioJobs } from "../../../src/storage/audio-jobs.js";
import { ChatBridgeCommandOutcomeUnknownError } from "../../../src/app/chat/chat-bridge.js";
import { chatDialogStateForWire, type ChatDialogState } from "../../../src/ui/chat-state.js";
import { parseAudioParameters } from "../../../src/plugins/builtins/parameter-panel.js";

const authorize = async <T>(_signal: AbortSignal, operation: () => Promise<T>): Promise<T> => operation();

async function panelInput(h: Awaited<ReturnType<typeof audioRecoveryHarness>>, suffix: string) {
  const { groups } = await loadAudioParameterGroups(h.storage, h.session.id);
  const panel = groups.flatMap((group) => group.tools).find((tool) => tool.name.endsWith(suffix))!.audioPanel!;
  return { context: {} as never, storageDirectory: h.storage, sessionId: h.session.id,
    target: {}, signal: h.context.signal, onProgress() {}, onAssets() {},
    withAdmissionAuthorization: authorize, withGenerationAuthorization: authorize,
    processing: { generationAdapter: h.generationAdapter, adapter: h.adapter },
    toolName: panel.toolName, signature: panel.signature };
}

test("manual audio uses the canonical connection parser and saves ordinary jobs without a model", async (t) => {
  const h = await audioRecoveryHarness(t, "elevenlabs");
  const input = await panelInput(h, "generate_music");
  let authorized = 0;
  const assets: string[] = [];
  const result = await runAudioParameterTool({ ...input,
    withGenerationAuthorization: async (signal, operation) => { authorized++; return authorize(signal, operation); },
    onAssets: (values) => { assets.push(...values.map((asset) => asset.id)); },
    arguments: { connectionId: h.connection.id, prompt: "Piano", instrumental: true },
  });
  assert.deepEqual(result, { failed: false });
  assert.equal(authorized, 1);
  assert.deepEqual(h.calls, ["submit"]);
  const jobs = await listAudioJobs(h.storage, h.session.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.status, "completed");
  assert.ok(assets.includes(jobs[0]!.outputAssets[0]!.id));
  const events = await loadSessionEvents(h.storage, h.session.id);
  assert.deepEqual(events.map((event) => event.kind), ["tool_call", "tool_result"]);
  assert.equal(JSON.parse(events[1]!.content).id, jobs[0]!.id);
  const list = await panelInput(h, "list_audio_jobs");
  assert.deepEqual(await runAudioParameterTool({ ...list, arguments: {} }), { failed: false });
  assert.equal(h.calls.length, 1);
});

test("audio admission rejects stale connection signatures, wrong owners, unknown fields, and attachment locators before dispatch", async (t) => {
  const h = await audioRecoveryHarness(t, "elevenlabs");
  const input = await panelInput(h, "generate_music");
  const args = { connectionId: h.connection.id, prompt: "Piano", instrumental: true };
  for (const invalid of [{ ...args, connectionId: "other" }, { ...args, surprise: true }, { ...args, instrumental: "yes" }]) {
    await assert.rejects(runAudioParameterTool({ ...input, arguments: invalid }), /Invalid audio parameters/);
  }
  await h.change({ apiKey: "replacement-audio-key" });
  await assert.rejects(runAudioParameterTool({ ...input, arguments: args }), /changed/);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(await loadSessionEvents(h.storage, h.session.id), []);
  const separation = await audioRecoveryHarness(t, "lalal");
  const catalog = await loadAudioParameterGroups(separation.storage, separation.session.id);
  const tool = catalog.groups.flatMap((group) => group.tools).find((tool) => tool.name.endsWith("separate_stems"))!;
  assert.doesNotMatch(JSON.stringify(tool.audioPanel), /request_audio_attachment/);
  await assert.rejects(parseAudioParameters({ toolName: tool.name, services: catalog.services,
    arguments: { connectionId: separation.connection.id, stems: ["vocals"],
      source: { kind: "request_audio_attachment", requestId: "manual-audio", audioIndex: 0 } },
  }), /saved Session audio or Arrangement/);
});

test("manual audio unknown paid submission remains one saved unknown job without retry", async (t) => {
  const h = await audioRecoveryHarness(t, "elevenlabs");
  const input = await panelInput(h, "generate_music");
  let submissions = 0;
  await assert.rejects(runAudioParameterTool({ ...input,
    processing: { generationAdapter: { provider: "elevenlabs", submit: async () => {
      submissions++; throw new Error("Response lost after submission.");
    } } }, arguments: { connectionId: h.connection.id, prompt: "Piano", instrumental: true },
  }), ChatBridgeCommandOutcomeUnknownError);
  assert.equal(submissions, 1);
  const jobs = await listAudioJobs(h.storage, h.session.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.status, "unknown");
  assert.equal(JSON.parse((await loadSessionEvents(h.storage, h.session.id)).at(-1)!.content).status, "unknown");
});

test("audio wire projections expose bound schemas and signatures without runtime credentials", async (t) => {
  const h = await audioRecoveryHarness(t, "elevenlabs");
  const { groups } = await loadAudioParameterGroups(h.storage, h.session.id);
  const projected = chatDialogStateForWire({ sessionToolCatalog: {
    sessionId: h.session.id, loadedAt: "now", modelToolsSupported: false, truncated: false, groups, issues: [],
  } } as unknown as ChatDialogState);
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /synthetic-audio-owner|apiKey/);
  assert.equal(projected.sessionToolCatalog!.groups.flatMap((group) => group.tools).some((tool) => tool.name === "listen_to_audio_asset"), false);
  const group = projected.sessionToolCatalog!.groups.find((group) => group.connectionId === h.connection.id)!;
  assert.equal(group.connectionName, "Fixture");
  const panel = group.tools[0]!.audioPanel!;
  assert.equal(panel.connectionId, h.connection.id);
  assert.deepEqual((panel.schema.properties as Record<string, unknown>).connectionId, { type: "string", const: h.connection.id });
});

test("audio commands accept only a bounded bound Session invocation", () => {
  const command = { kind: "run_audio_tool", sessionId: "session-one", toolName: "builtin_elevenlabs_generate_music",
    signature: "a".repeat(64), arguments: { prompt: "Music" } };
  assert.deepEqual(parseCommandInput(command), command);
  for (const invalid of [{ ...command, apiKey: "secret" }, { ...command, signature: "bad" },
    { ...command, arguments: [] }, { ...command, arguments: { text: "x".repeat(64 * 1024) } }]) {
    assert.throws(() => parseCommandInput(invalid));
  }
});
