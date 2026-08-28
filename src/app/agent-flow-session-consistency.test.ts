import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { MidiTrack } from "@ableton-extensions/sdk";

import type { LiveInteractionContext } from "../live/context.js";
import type { SavedProfile } from "../model/profile.js";
import { loadSessionEvents } from "../storage/events.js";
import { saveSavedProfile } from "../storage/settings.js";
import { updateSession } from "../storage/sessions.js";
import type { ChatBridgeState, ChatDialogState } from "../ui/chat-state.js";
import { runAgentFlow, type AgentFlowDependencies } from "./agent-flow.js";

test("two open modals do not automatically share a claimed empty transient Session", async (t) => {
  const fixture = await openTwoDialogs({}, {});
  t.after(fixture.close);
  assert.notEqual(fixture.firstState.activeSessionId, fixture.secondState.activeSessionId);

  const selected = await fetch(fixture.second.endpoint("/command"), {
    method: "POST",
    headers: jsonHeaders("select-shared-empty"),
    body: JSON.stringify({
      kind: "select_session",
      sessionId: fixture.firstState.activeSessionId,
    }),
  });
  assert.equal(selected.status, 200);
  assert.equal(
    (await selected.json() as ChatDialogState).activeSessionId,
    fixture.firstState.activeSessionId,
  );
});

test("a peer event or attachment invalidation rejects send before unseen state is consumed", async (t) => {
  let secondModelCalls = 0;
  const fixture = await openTwoDialogs(
    {
      requestModelTurn: async () => ({ content: "Peer reply", toolCalls: [] }),
    },
    {
      requestModelTurn: async () => {
        secondModelCalls += 1;
        return { content: "Second reply", toolCalls: [] };
      },
    },
    true,
  );
  t.after(fixture.close);
  const sessionId = fixture.firstState.activeSessionId;
  assert.equal(fixture.secondState.activeSessionId, sessionId);

  const firstSend = await fetch(fixture.first.endpoint("/send"), {
    method: "POST",
    headers: jsonHeaders("peer-send"),
    body: JSON.stringify({ prompt: "Persist this elsewhere", sessionId }),
  });
  assert.equal(firstSend.status, 200);

  const staleEventSend = await fetch(fixture.second.endpoint("/send"), {
    method: "POST",
    headers: jsonHeaders("stale-event-send"),
    body: JSON.stringify({ prompt: "Must first see the peer turn", sessionId }),
  });
  assert.equal(staleEventSend.status, 409);
  const staleEventBody = await staleEventSend.json() as {
    promptPersistence?: string;
    sendFailureKind?: string;
    state?: ChatDialogState;
  };
  assert.equal(staleEventBody.promptPersistence, "not_persisted");
  assert.equal(staleEventBody.sendFailureKind, "state_stale");
  assert.equal(staleEventBody.state, undefined);
  assert.equal(secondModelCalls, 0);
  const reviewedEventState = await state(fixture.second, sessionId);
  assert.deepEqual(
    reviewedEventState.events.map(({ content }) => content),
    ["Persist this elsewhere", "Peer reply"],
  );

  const uploadBytes = pngBytes();
  const upload = await fetch(
    fixture.first.endpoint("/attachments") +
      `&sessionId=${encodeURIComponent(sessionId)}&fileName=peer.png`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Live-Smith-File-Type": "image/png",
      },
      body: uploadBytes.buffer.slice(
        uploadBytes.byteOffset,
        uploadBytes.byteOffset + uploadBytes.byteLength,
      ) as ArrayBuffer,
    },
  );
  assert.equal(upload.status, 201);

  const staleAttachmentSend = await fetch(fixture.second.endpoint("/send"), {
    method: "POST",
    headers: coveredSendHeaders("stale-attachment-send", reviewedEventState),
    body: JSON.stringify({ prompt: "Must first see the attachment", sessionId }),
  });
  assert.equal(staleAttachmentSend.status, 409);
  const staleAttachmentBody = await staleAttachmentSend.json() as {
    state?: ChatDialogState;
  };
  assert.equal(staleAttachmentBody.state, undefined);
  assert.equal(secondModelCalls, 0);
  const reviewedAttachmentState = await state(fixture.second, sessionId);
  assert.deepEqual(
    reviewedAttachmentState.pendingAttachments.map(({ fileName }) => fileName),
    ["peer.png"],
  );
  assert.deepEqual(
    (await loadSessionEvents(fixture.directory, sessionId)).map(({ content }) => content),
    ["Persist this elsewhere", "Peer reply"],
  );
});

interface DialogEndpoint {
  endpoint(pathname: string): string;
}

async function openTwoDialogs(
  firstDependencies: AgentFlowDependencies,
  secondDependencies: AgentFlowDependencies,
  shareFirstSession = false,
): Promise<{
  directory: string;
  first: DialogEndpoint;
  second: DialogEndpoint;
  firstState: ChatDialogState;
  secondState: ChatDialogState;
  close(): Promise<void>;
}> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-session-consistency-"),
  );
  await saveSavedProfile(directory, profile());
  const firstDialog = Promise.withResolvers<string>();
  const secondDialog = Promise.withResolvers<string>();
  const closeFirst = Promise.withResolvers<void>();
  const closeSecond = Promise.withResolvers<void>();
  let dialogCount = 0;
  const track = fakeMidiTrack();
  const context = {
    application: {
      song: { handle: { id: 1n }, tracks: [track], scenes: [] },
    },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const first = dialogCount++ === 0;
        (first ? firstDialog : secondDialog).resolve(url);
        await (first ? closeFirst : closeSecond).promise;
      },
    },
  };
  const interaction: LiveInteractionContext = {
    summary: "Track: Lead",
    target: { track },
    scope: { kind: "track", identity: "1", label: "Lead" },
  };
  const firstFlow = runAgentFlow(context as never, interaction, {
    ...firstDependencies,
    renderHtml: () => "<html></html>",
  });
  let secondFlow: Promise<void> | undefined;
  try {
    const first = endpoint(await firstDialog.promise);
    const firstState = await state(first);
    if (shareFirstSession) {
      await updateSession(directory, firstState.activeSessionId, {
        title: "Shared Session",
      });
    }
    secondFlow = runAgentFlow(context as never, interaction, {
      ...secondDependencies,
      renderHtml: () => "<html></html>",
    });
    const second = endpoint(await secondDialog.promise);
    const secondState = await state(second);
    let closed = false;
    return {
      directory,
      first,
      second,
      firstState,
      secondState,
      close: async () => {
        if (closed) return;
        closed = true;
        closeFirst.resolve();
        closeSecond.resolve();
        await Promise.allSettled([firstFlow, secondFlow!]);
        await fs.rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    closeFirst.resolve();
    closeSecond.resolve();
    await Promise.allSettled([firstFlow, ...(secondFlow ? [secondFlow] : [])]);
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function endpoint(chatUrl: string): DialogEndpoint {
  const url = new URL(chatUrl);
  const token = url.searchParams.get("token")!;
  return {
    endpoint: (pathname) =>
      `${url.origin}${pathname}?token=${encodeURIComponent(token)}`,
  };
}

async function state(
  dialog: DialogEndpoint,
  sessionId?: string,
): Promise<ChatBridgeState> {
  const url = dialog.endpoint("/state") + (sessionId === undefined
    ? ""
    : `&sessionId=${encodeURIComponent(sessionId)}`);
  return await (await fetch(url)).json() as ChatBridgeState;
}

function jsonHeaders(id: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Live-Smith-Command-Id": id,
    "X-Live-Smith-Send-Id": id,
  };
}

function coveredSendHeaders(
  id: string,
  state: ChatBridgeState,
): Record<string, string> {
  return {
    ...jsonHeaders(id),
    "X-Live-Smith-Global-State-Covered-Through":
      state.bridgeStateCoveredThroughRevision,
    "X-Live-Smith-Session-State-Covered-Through":
      state.bridgeStateCoveredThroughRevision,
  };
}

function fakeMidiTrack(): MidiTrack<"1.0.0"> {
  return Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: 1n } },
    name: { enumerable: true, value: "Lead" },
    mute: { enumerable: true, value: false },
    solo: { enumerable: true, value: false },
    mutedViaSolo: { enumerable: true, value: false },
    arm: { enumerable: true, value: false },
    groupTrack: { enumerable: true, value: null },
    arrangementClips: { enumerable: true, value: [] },
    takeLanes: { enumerable: true, value: [] },
    clipSlots: { enumerable: true, value: [] },
    devices: { enumerable: true, value: [] },
  }) as MidiTrack<"1.0.0">;
}

function profile(): SavedProfile {
  return {
    id: "profile-1",
    name: "Provider",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "https://provider.test/v1",
      apiKey: "test-key",
    },
    defaultModel: "model-a",
    models: [{
      model: "model-a",
      parameters: {
        maxOutputTokens: 1_000,
        reasoning: { mode: "default" },
      },
      advanced: {},
    }],
  };
}

function pngBytes(): Uint8Array {
  const bytes = Buffer.alloc(24);
  bytes.set([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 1, 0, 0, 0, 1,
  ]);
  return new Uint8Array(bytes);
}
