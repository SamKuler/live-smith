import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { commandCalls, createDialogHarness, pendingAudio, pendingImage } from "./chat-dialog.test-harness.js";
import { audioState, service, musicService, sunoService, job, broadcast,
  integrationConnectionView, selectedAudioService } from "./chat-dialog.audio-test-helpers.js";

test("generated music, alternatives and sound effects show their bound service, operation and local players", async () => {
  const state = audioState([service, musicService, sunoService]);
  const source = job(state.activeSessionId).outputs[0]!;
  const music = job(state.activeSessionId, { serviceId: sunoService.id, provider: sunoService.provider,
    operation: "generate_music", modelId: "V4_5ALL", stems: [], status: "completed", resumable: false,
    outputs: ["music", "music_alternative"].map((role, index) => ({
      ...source, id: "generated-" + index, label: "Generated take " + index,
      role: role as "music" | "music_alternative", origin: { kind: "generated" },
    })) });
  const effect = job(state.activeSessionId, { id: "effect-job", serviceId: musicService.id, provider: musicService.provider,
    operation: "generate_sound_effect", title: "Rain", stems: [], status: "completed", resumable: false,
    outputs: [{ ...source, id: "generated-effect", jobId: "effect-job", role: "sound_effect",
      label: "Rain", origin: { kind: "generated" } }] });
  state.audioJobs = [music, effect];
  const harness = await createDialogHarness(state);
  try {
    const players = Array.from(harness.document.querySelectorAll<HTMLAudioElement>("#audioJobs audio"));
    assert.equal(players.length, 3);
    assert.match(harness.document.querySelector("#audioJobs")!.textContent!, /Music generation.*Third-party studio · Suno via SunoAPI.org \(third-party\) · V4_5ALL/s);
    assert.match(harness.document.querySelector("#audioJobs")!.textContent!, /Sound effect generation/);
    assert.match(harness.document.querySelector('[data-audio-asset-id="generated-effect"]')!.getAttribute("aria-label")!, /Sound effect.*Rain/);
    assert.equal(harness.document.querySelector("[data-resume-audio-job]"), null);
    harness.emitServerEvent(broadcast(state, { connections: [
      service,
      musicService,
      { ...sunoService, name: "Renamed studio" },
    ].map(integrationConnectionView), revision: "2" }));
    await harness.settle();
    assert.match(harness.document.querySelector("#audioJobs")!.textContent!, /Renamed studio/);
    assert.deepEqual(Array.from(harness.document.querySelectorAll("#audioJobs audio")), players);
    harness.emitServerEvent(broadcast(state, {
      connections: [integrationConnectionView(service)], revision: "3",
    }));
    await harness.settle();
    assert.match(harness.document.querySelector("#audioJobs")!.textContent!, /audio-sunoapi · Suno via SunoAPI.org/);
    assert.deepEqual(Array.from(harness.document.querySelectorAll("#audioJobs audio")), players);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("generation services alone cannot admit audio attachments to a text-only chat model", async () => {
  const state = audioState([musicService]);
  state.runtimeProfile!.capabilities.inputs.audio = false;
  state.runtimeProfile!.inputCapabilityEvidence.audio = "unsupported";
  state.pendingAttachments = [pendingAudio("input-one", "source.wav")];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#prompt", "Use this audio");
    harness.click("#sendButton");
    await harness.settle();
    assert.equal(harness.calls.some((call) => call.path === "/send"), false);
    assert.match(harness.document.querySelector("#status")!.textContent!, /audio input/);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("Resume follows host job readiness independently of connection selection or removal", async () => {
  const state = audioState([musicService, service]);
  state.audioJobs = [job(state.activeSessionId)];
  const harness = await createDialogHarness(state);
  try {
    const resume = harness.document.querySelector<HTMLButtonElement>("[data-resume-audio-job]")!;
    assert.equal(selectedAudioService(harness), musicService.id);
    assert.equal(resume.disabled, false);
    harness.emitServerEvent(broadcast(state, { connections: [musicService], revision: "2" }));
    await harness.settle();
    assert.equal(resume.disabled, false);
    resume.click();
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "resume_audio_job", sessionId: state.activeSessionId, jobId: "job-one",
    });
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("new results preserve existing players, keep Resume after outputs, and follow the server's job order", async () => {
  const state = audioState();
  const first = job(state.activeSessionId);
  state.audioJobs = [first];
  const harness = await createDialogHarness(state);
  try {
    const player = harness.document.querySelector("#audioJobs audio");
    const second = job(state.activeSessionId, { id: "job-new", outputs: [], status: "running" });
    const updated = { ...first, outputs: [...first.outputs, {
      ...first.outputs[0]!, id: "residual-one", role: "residual" as const, label: "Remaining mix",
    }] };
    harness.setServerState({ ...state, audioJobs: [second, updated] });
    harness.select("#uiLanguage", "zh-CN");
    await harness.settle();
    assert.deepEqual(Array.from(harness.document.querySelectorAll<HTMLElement>("[data-audio-job-id]"))
      .map((card) => card.dataset.audioJobId), ["job-new", "job-one"]);
    assert.equal(harness.document.querySelector('[data-audio-asset-id="asset-one"]'), player);
    const card = harness.document.querySelector('[data-audio-job-id="job-one"]')!;
    assert.equal(card.querySelectorAll("audio").length, 2);
    assert.equal(card.lastElementChild?.getAttribute("data-resume-audio-job"), first.id);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("stopped Resume adopts authoritative partial outputs and keeps the composer usable", async () => {
  const state = audioState();
  state.audioJobs = [job(state.activeSessionId, { status: "interrupted", outputs: [] })];
  const harness = await createDialogHarness(state);
  try {
    const terminal = { ...state, audioJobs: [job(state.activeSessionId)], bridgeStateRevision: "100", bridgeStateCoveredThroughRevision: "100" };
    harness.failNextCommand("Command stopped by user.", undefined, { state: terminal, commandOutcome: "stopped", status: 409 });
    harness.holdNextCommand();
    harness.click("[data-resume-audio-job]");
    await harness.settle();
    harness.click("#sendButton");
    harness.releaseHeldCommand();
    await harness.settle();
    assert.equal(harness.document.querySelectorAll("#audioJobs audio").length, 1);
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled, false);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("[data-resume-audio-job]")?.disabled, false);
    assert.match(harness.document.querySelector("#status")!.textContent!, /stopped/i);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("audio results preview large Arrangement assets using only authenticated session bridge URLs", async () => {
  const state = audioState();
  state.audioJobs = [job(state.activeSessionId)];
  const harness = await createDialogHarness(state);
  try {
    const player = harness.document.querySelector<HTMLAudioElement>("#audioJobs audio")!;
    assert.ok(player);
    assert.equal(player.controls, true);
    assert.equal(player.preload, "none");
    const url = new URL(player.src);
    assert.equal(url.pathname, "/audio-assets/asset-one");
    assert.equal(url.searchParams.get("sessionId"), state.activeSessionId);
    assert.ok(url.searchParams.get("token"));
    assert.equal(url.hostname, new URL(harness.eventSourceUrls[0]!).hostname);
    assert.equal(harness.document.querySelector("#audioJobs img"), null);
    assert.match(harness.document.querySelector("#audioJobs")!.textContent!, /Vocals/);
    harness.emitServerEvent(broadcast(state, { connections: [{ ...service, name: "Updated studio" }], revision: "2" }));
    await harness.settle();
    assert.equal(harness.document.querySelector("#audioJobs audio"), player);
    harness.holdNextCommand();
    harness.click("[data-resume-audio-job]");
    assert.equal(harness.document.querySelector<HTMLButtonElement>("[data-resume-audio-job]")?.disabled, true);
    assert.deepEqual(commandCalls(harness).at(-1)?.body, { kind: "resume_audio_job", sessionId: state.activeSessionId, jobId: "job-one" });
    harness.releaseHeldCommand();
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLButtonElement>("[data-resume-audio-job]")?.disabled, false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("completed request state renders new audio results and completed jobs have no Resume control", async () => {
  const state = audioState();
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Separate vocals");
    harness.click("#sendButton");
    await harness.settle();
    harness.setServerState({ ...state, audioJobs: [job(state.activeSessionId, { status: "completed", resumable: false })] });
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.document.querySelectorAll("#audioJobs audio").length, 1);
    assert.equal(harness.document.querySelector("[data-resume-audio-job]"), null);
    assert.match(harness.document.querySelector("#audioJobs")!.textContent!, /Audio ready/);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("Chinese audio settings and result controls render through the real dialog", async () => {
  const state = audioState();
  state.settings.uiLanguage = "zh-CN";
  state.audioJobs = [job(state.activeSessionId)];
  const harness = await createDialogHarness(state);
  try {
    assert.equal(harness.document.querySelector("#audioSettingsHeading")?.textContent, "连接");
    assert.equal(harness.document.querySelector("#saveAudioServiceButton")?.textContent, "保存连接");
    assert.equal(harness.document.querySelector("[data-resume-audio-job]")?.textContent, "恢复音频任务");
    assert.match(harness.document.querySelector("#audioServiceDisclosure")!.getAttribute("aria-label")!, /分钟数/);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("audio-processing admission works with text-only models but still requires tools and saved service readiness", async () => {
  for (const [enabled, configured, tools, expected] of [
    [true, true, true, true], [false, true, true, false], [false, false, true, false], [true, true, false, false],
  ]) {
    const state = audioState();
    state.integrationConnections = { connections: [integrationConnectionView({
      ...service,
      enabled: enabled!,
      apiKeyConfigured: configured!,
    })], revision: "1" };
    state.runtimeProfile!.capabilities.tools = tools!;
    state.runtimeProfile!.capabilities.inputs.audio = false;
    state.runtimeProfile!.inputCapabilityEvidence.audio = "unsupported";
    state.pendingAttachments = [pendingAudio("input-one", "source.wav")];
    const harness = await createDialogHarness(state);
    try {
      harness.input("#prompt", "Separate this audio");
      harness.click("#sendButton");
      await harness.settle();
      assert.equal(harness.calls.some((call) => call.path === "/send"), expected);
      if (expected) assert.deepEqual(harness.calls.find((call) => call.path === "/send")?.jsonBody,
        { prompt: "Separate this audio", sessionId: state.activeSessionId });
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); }
  }
});

test("audio processing does not bypass unsupported image admission", async () => {
  const state = audioState();
  state.pendingAttachments = [pendingAudio("input-one", "source.wav"), pendingImage("image-one", "cover.png")];
  state.runtimeProfile!.capabilities.inputs.image = false;
  state.runtimeProfile!.inputCapabilityEvidence.image = "unsupported";
  const harness = await createDialogHarness(state);
  try {
    harness.input("#prompt", "Use the image and separate audio");
    harness.click("#sendButton");
    await harness.settle();
    assert.equal(harness.calls.some((call) => call.path === "/send"), false);
    assert.match(harness.document.querySelector("#status")!.textContent!, /image input/);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("malformed audio jobs and credential-bearing views cannot replace active state or settle a send", async () => {
  const state = audioState();
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Separate audio");
    harness.click("#sendButton");
    await harness.settle();
    const validJob = job(state.activeSessionId);
    for (const patch of [
      { integrationConnections: { connections: [{ ...service, apiKey: "fixture-leak" }], revision: "2" } },
      { audioJobs: [{ ...validJob, remoteTaskId: "remote-private" }] },
      ...["provider", "serviceId", "operation"].map((key) => ({ audioJobs: [{ ...validJob, [key]: undefined }] })),
      { audioJobs: [{ ...validJob, provider: "elevenlabs" }] },
      { audioJobs: [{ ...validJob, provider: "elevenlabs", serviceId: musicService.id, operation: "generate_music" }] },
      { audioJobs: [{ ...validJob, outputs: [{ ...validJob.outputs[0], role: "music", origin: { kind: "generated" } }] }] },
      { audioJobs: [{ ...validJob, outputs: [{ ...validJob.outputs[0], sessionId: "other-session" }] }] },
      { audioJobs: [{ ...validJob, outputs: [{ ...validJob.outputs[0], id: "../foreign" }] }] },
      { audioJobs: [{ ...validJob, outputs: [{ ...validJob.outputs[0], url: "https://provider.test/file" }] }] },
      { audioJobs: [validJob, validJob] },
    ]) {
      harness.emitServerEvent({ type: "done", sendId: harness.sendIds[0], sessionId: state.activeSessionId,
        state: { ...state, ...patch } });
      await harness.settle();
      assert.equal(harness.document.querySelector("#audioJobs audio"), null);
      assert.doesNotMatch(harness.document.querySelector("#audioJobs")!.textContent!, /fixture-leak|remote-private/);
      assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled, false);
      assert.match(harness.document.querySelector("#sendButton")!.textContent!, /Stop/);
    }
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("credential-bearing global audio settings broadcasts are rejected atomically", async () => {
  const state = audioState();
  const harness = await createDialogHarness(state);
  try {
    harness.emitServerEvent(broadcast(state, { connections: [{ ...service, enabled: false, apiKey: "fixture-leak" }], revision: "2" }));
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceEnabled")?.checked, true);
    assert.doesNotMatch(JSON.stringify(harness.readBootstrappedClientStateReference()), /fixture-leak/);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("Session switches replace audio previews and a detached Resume cannot target the old Session", async () => {
  const state = audioState();
  state.audioJobs = [job(state.activeSessionId)];
  const harness = await createDialogHarness(state);
  try {
    const oldResume = harness.document.querySelector<HTMLButtonElement>("[data-resume-audio-job]")!;
    const secondState = { ...state, activeSessionId: "session-2", approvalMode: "low-risk" as const, audioJobs: [] };
    harness.setServerState(secondState);
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.equal(harness.document.querySelector("#audioJobs audio"), null);
    oldResume.click();
    await harness.settle();
    assert.equal(commandCalls(harness).some((call) => (call.body as { kind: string }).kind === "resume_audio_job"), false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a late send completion cannot erase audio results received by a newer settings refresh", async () => {
  const state = audioState();
  state.audioJobs = [];
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Keep working");
    harness.click("#sendButton");
    await harness.settle();
    harness.setServerState({ ...state, audioJobs: [job(state.activeSessionId, { status: "completed", resumable: false })] });
    harness.select("#uiLanguage", "zh-CN");
    await harness.settle();
    const player = harness.document.querySelector("#audioJobs audio");
    assert.ok(player);
    harness.setServerState(state);
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.document.querySelector("#audioJobs audio"), player);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("updated typed job state plays 128-character asset IDs and rejects IDs beyond the storage boundary", async () => {
  const state = audioState();
  state.audioJobs = [job(state.activeSessionId, { status: "running", outputs: [] })];
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Collect the audio result");
    harness.click("#sendButton");
    await harness.settle();
    const completed = job(state.activeSessionId, { status: "completed", resumable: false });
    const assetId = "a".repeat(128);
    completed.outputs[0]!.id = assetId + "x";
    harness.emitServerEvent({ type: "done", sendId: harness.sendIds[0], sessionId: state.activeSessionId,
      state: { ...state, audioJobs: [completed] } });
    await harness.settle();
    assert.equal(harness.document.querySelector("#audioJobs audio"), null);
    assert.match(harness.document.querySelector("#audioJobs")!.textContent!, /Processing audio/);
    completed.outputs[0]!.id = assetId;
    harness.emitServerEvent({ type: "done", sendId: harness.sendIds[0], sessionId: state.activeSessionId,
      state: { ...state, audioJobs: [completed] } });
    await harness.settle();
    const player = harness.document.querySelector<HTMLAudioElement>("#audioJobs audio");
    assert.ok(player);
    assert.equal(new URL(player.src).pathname, "/audio-assets/" + assetId);
    assert.equal(new URL(player.src).searchParams.get("sessionId"), state.activeSessionId);
    assert.equal(player.preload, "none");
    assert.equal(harness.document.querySelector("[data-resume-audio-job]"), null);
    assert.match(harness.document.querySelector("#audioJobs")!.textContent!, /Audio ready/);
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
