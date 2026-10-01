import assert from "node:assert/strict";
import { fstatSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TestContext } from "node:test";
import { URL } from "node:url";
import { resolveFetchImplementation } from "../../../../src/runtime/host.js";

import { createAudioJob } from "../../../../src/storage/audio-jobs.js";
import { appendSessionEvent, loadSessionEvents, type SessionEvent } from "../../../../src/storage/events.js";
import { StorageCommitOutcomeUnknownError } from "../../../../src/storage/persistence.js";
import { createSession } from "../../../../src/storage/sessions.js";
import type { ChatBridgeState } from "../../../../src/ui/chat-state.js";
import { createDialogHarness, stateFixture } from "../../../ui/support/chat-dialog.test-harness.js";
import { handleAgentRequest } from "../../../../src/app/agent-request.js";
import { createChatBridge, ChatBridgeSendFailureError, type PromptPersistence } from "../../../../src/app/chat/chat-bridge.js";
import { liveContextPresentationFixture } from "../../context/support/live-context.test-harness.js";
import { runtimeProfileForSavedProfile } from "../../../../src/app/model/model-request.js";

type ReceiptScenario = "audio-stop" | "commit-stop" | "corrupt-audio" |
  "reject-commit" | "unknown-visible" | "unknown-absent" | "success";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface ReceiptResponse {
  path: string;
  status: number;
  body: {
    error?: string;
    promptPersistence?: PromptPersistence;
    terminal?: boolean;
    state?: ChatBridgeState;
  };
}

export async function requestReceiptHarness(t: TestContext, scenario: ReceiptScenario) {
  const fetchImpl = resolveFetchImplementation();
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-request-receipt-"));
  const session = await createSession(storage, {
    title: "Receipt test", projectKey: "fixture",
    scope: { kind: "track", identity: "fixture-track", label: "Track" },
  });
  const state = stateFixture();
  state.sessions = [session];
  state.activeSessionId = session.id;
  state.liveContext = { ...state.liveContext!, sessionId: session.id };
  state.openSettingsOnLoad = false;
  const runtime = runtimeProfileForSavedProfile(state.settings.profiles[0]!);
  const published: SessionEvent[] = [];
  const calls = { appends: 0, model: 0, invalidations: 0 };
  const boundary = deferred();
  const release = deferred();
  const sendFinished = deferred();
  const buildState = async () => ({ ...state, events: await loadSessionEvents(storage, session.id) });
  let jobPath: string | undefined;
  if (scenario === "audio-stop" || scenario === "corrupt-audio") {
    const job = await createAudioJob(storage, session.id, {
      provider: "elevenlabs", serviceId: "fixture-service", operation: "generate_music",
      connectionFingerprint: "a".repeat(64), stems: [],
    });
    jobPath = path.join(storage, "live-smith-audio", session.id, `${job.id}.job.json`);
  }
  if (scenario === "audio-stop") {
    const probe = await fs.open(jobPath!);
    const identity = await probe.stat();
    const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
    const read = prototype.read;
    await probe.close();
    let held = false;
    t.mock.method(prototype, "read", async function (this: fs.FileHandle, ...args: unknown[]) {
      const actual = fstatSync(this.fd);
      if (!held && actual.dev === identity.dev && actual.ino === identity.ino) {
        held = true;
        boundary.resolve();
        await release.promise;
      }
      return Reflect.apply(read, this, args);
    });
  }
  const bridge = await createChatBridge({
    buildState, renderHtml: () => "", handleCommand: buildState,
    handleSend: async (input, stream, signal) => {
      try {
        await handleAgentRequest(
          { application: { song: { tempo: 120 } }, environment: { storageDirectory: storage, tempDirectory: storage } } as never,
          storage, { summary: "Track", presentation: liveContextPresentationFixture("Track"), target: {}, scope: session.scope },
          input.prompt, runtime, "fixture", session.id,
          {
            signal, onDelta() {}, onProgress() {},
            confirmActions: async () => { throw new Error("Receipt tests must not change Live."); },
            onSessionStateInvalidated: () => { calls.invalidations++; },
            onSessionEvent: async (event) => {
              // Every published receipt must already be present in actual storage.
              assert.ok((await loadSessionEvents(storage, session.id)).some((saved) => saved.id === event.id));
              published.push(event);
              await stream.sessionEvent(event);
            },
          },
          async () => { calls.model++; return { content: "Finished.", toolCalls: [] }; },
          async (...args) => {
            calls.appends++;
            if (scenario === "reject-commit") throw new Error("User event write failed.");
            if (scenario === "unknown-absent") throw new StorageCommitOutcomeUnknownError(new Error("Unconfirmed user event."));
            const event = await appendSessionEvent(...args);
            if (scenario === "unknown-visible") throw new StorageCommitOutcomeUnknownError(new Error("Unconfirmed durability."));
            if (scenario === "corrupt-audio") await fs.writeFile(jobPath!, "{}");
            if (scenario === "commit-stop") {
              boundary.resolve();
              await release.promise;
            }
            return event;
          },
        );
        return buildState();
      } catch (error) {
        throw new ChatBridgeSendFailureError(error, await buildState());
      }
    },
  });
  const chatUrl = new URL(bridge.url);
  const ui = await createDialogHarness(await buildState(), {
    baseUrl: chatUrl.origin, token: chatUrl.searchParams.get("token")!,
  });
  const requests: Array<{ path: string; sendId: string | null }> = [];
  const responses: ReceiptResponse[] = [];
  const fixtureFetch = ui.window.fetch;
  Object.defineProperty(ui.window, "fetch", {
    configurable: true,
    value: async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (!["/send", "/stop", "/state"].includes(url.pathname)) return fixtureFetch(input, init);
      requests.push({ path: url.pathname, sendId: new Headers(init?.headers).get("X-Live-Smith-Send-Id") });
      const response = await fetchImpl(url, init);
      responses.push({ path: url.pathname, status: response.status, body: await response.clone().json() });
      if (url.pathname === "/send") sendFinished.resolve();
      return response;
    },
  });
  t.after(async () => {
    release.resolve();
    await bridge.close();
    await ui.settle();
    ui.close();
    await fs.rm(storage, { recursive: true, force: true });
  });
  return {
    ui, session, calls, requests, responses, published, boundary, release, sendFinished,
    events: () => loadSessionEvents(storage, session.id),
    async terminalStop() {
      const endpoint = new URL(bridge.url);
      endpoint.pathname = "/stop";
      const response = await fetchImpl(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json",
          "X-Live-Smith-Send-Id": requests.find((request) => request.path === "/send")!.sendId! },
        body: "{}",
      });
      return await response.json() as ReceiptResponse["body"];
    },
  };
}
