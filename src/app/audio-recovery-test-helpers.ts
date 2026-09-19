import * as fs from "node:fs/promises";
import type { TestContext } from "node:test";
import type { AudioGenerationAdapter, AudioServiceAdapter, AudioServiceConnection, RemoteAudioOutput } from "../audio-services/contracts.js";
import { createHostAbortController } from "../runtime/host.js";
import { createSession } from "../storage/sessions.js";
import { loadAgentSettings, saveGlobalSettings } from "../storage/settings.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { generateAudio } from "./audio-generation.js";
import { separateAudioStems, type AudioProcessingContext } from "./audio-processing.js";
import {
  integrationConnectionUpsert,
  saveIntegrationConnection,
} from "./integration-connection-test-helpers.js";

export async function audioRecoveryHarness(t: TestContext, provider: "lalal" | "elevenlabs" | "sunoapi") {
  const storage = await fs.mkdtemp("/private/tmp/live-smith-audio-recovery-");
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const session = await createSession(storage, { title: "Recovery", projectKey: "fixture", scope: { kind: "selection", identity: "selection", label: "Audio" } });
  const connection: AudioServiceConnection = { id: "fixture-connection", name: "Fixture", provider, enabled: true,
    apiKey: "synthetic-audio-owner", ...(provider === "sunoapi" ? { callbackUrl: "https://hooks.example.com/audio" } : {}) };
  await saveIntegrationConnection(storage, "0", connection);
  const calls: string[] = [];
  const mode = { invalidFirst: false, offline: false };
  const outputs: RemoteAudioOutput[] = (provider === "lalal" ? ["vocals", "residual"] : ["music", "music_alternative"])
    .map((role) => ({ key: role, role: role as RemoteAudioOutput["role"], url: `https://example.com/${role}` }));
  const inspect = async () => {
    calls.push("inspect");
    if (mode.offline) throw new Error("offline");
    return { status: "completed" as const, outputs };
  };
  const download = async (output: RemoteAudioOutput) => {
    calls.push(`download:${output.role}`);
    return mode.invalidFirst && output === outputs[0] ? new Uint8Array([1, 2, 3]) : waveBytes();
  };
  const generationAdapter: AudioGenerationAdapter = { provider: provider === "sunoapi" ? "sunoapi" : "elevenlabs",
    async submit(request) {
      calls.push("submit");
      return provider === "sunoapi" ? { kind: "task", taskId: "fixture-task" } :
        { kind: "audio", outputs: [{ role: request.operation === "generate_music" ? "music" : "sound_effect", bytes: waveBytes() }] };
    }, ...(provider === "sunoapi" ? { inspect, download } : {}) };
  const adapter: AudioServiceAdapter = { provider: "lalal", stems: ["vocals"],
    async upload() { calls.push("upload"); return "fixture-source"; },
    async submit() { calls.push("submit"); return "fixture-task"; }, inspect, download };
  const context: AudioProcessingContext = { storageDirectory: storage, sessionId: session.id,
    signal: createHostAbortController().signal, generationAdapter, adapter };
  const source = async () => ({ bytes: waveBytes(), label: "Source", origin: { kind: "attachment" as const } });
  const run = () => provider === "lalal" ? separateAudioStems(context, connection.id, ["vocals"], source) :
    generateAudio(context, connection.id, { operation: "generate_music", prompt: "Synthetic test", instrumental: true });
  const change = async (patch: Partial<AudioServiceConnection> | "remove") => {
    const settings = (await loadAgentSettings(storage)).integrationConnections!;
    await saveGlobalSettings(storage, { integrationConnections: patch === "remove"
      ? { action: "remove", expectedRevision: settings.revision, connectionId: connection.id }
      : integrationConnectionUpsert(settings.revision, { ...connection, ...patch }) });
  };
  return { storage, session, connection, context, mode, calls, run, change, adapter, generationAdapter, source };
}
