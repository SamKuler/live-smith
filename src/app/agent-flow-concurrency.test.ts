import assert from "node:assert/strict";
import { Buffer as NodeBuffer } from "node:buffer";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { connect } from "node:net";
import { env, execPath } from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ClipSlot, MidiTrack } from "@ableton-extensions/sdk";

import {
  arrangementSelectionInteractionContext,
  clipSlotSelectionInteractionContext,
  type LiveInteractionContext,
} from "../live/context.js";
import type { DiscoveredModelInfo } from "../model/provider.js";
import { availableSkillSummaries } from "../skills/builtins.js";
import type {
  DirectApiModelConfig,
  SavedProfile,
} from "../model/profile.js";
import {
  MAX_PENDING_ATTACHMENT_BYTES,
  MAX_PENDING_ATTACHMENT_COUNT,
  MAX_PENDING_IMAGE_ATTACHMENT_BYTES,
} from "../attachments/contracts.js";
import {
  listSessionAttachments,
  saveSessionAttachment,
} from "../storage/attachments.js";
import {
  appendSessionEvent,
  listSessionEventLogIds,
  loadSessionEvents,
} from "../storage/events.js";
import { saveModelCache } from "../storage/model-cache.js";
import {
  StorageCommitOutcomeUnknownError,
  withStorageTransaction,
} from "../storage/persistence.js";
import {
  createSession,
  deleteSession,
  listSessions,
  setSessionArchived,
  updateSession,
  updateSessionInTransaction,
} from "../storage/sessions.js";
import {
  saveGlobalSettings,
  saveSavedProfile,
  savedProfileRevision,
} from "../storage/settings.js";
import type { ChatBridgeState, ChatDialogState } from "../ui/chat-state.js";
import { modelStateSourceForProfile } from "../ui/chat-state.js";
import {
  decidePlanApproval,
  runAgentFlow,
} from "./agent-flow.js";
import { getOrCreateDefaultSession } from "./session-context.js";
import { liveContextPresentationFixture } from "./live-context.test-harness.js";

let bridgeRequestSequence = 0;

function bridgeJsonHeaders(): Record<string, string> {
  bridgeRequestSequence += 1;
  return {
    "Content-Type": "application/json",
    "X-Live-Smith-Command-Id": `concurrency-command-${bridgeRequestSequence}`,
    "X-Live-Smith-Send-Id": `concurrency-send-${bridgeRequestSequence}`,
  };
}

function bridgeSendHeaders(state: ChatBridgeState): Record<string, string> {
  return {
    ...bridgeJsonHeaders(),
    "X-Live-Smith-Global-State-Covered-Through":
      state.bridgeStateCoveredThroughRevision,
    "X-Live-Smith-Session-State-Covered-Through":
      state.bridgeStateCoveredThroughRevision,
  };
}

function bridgeSkillHeaders(): Record<string, string> {
  bridgeRequestSequence += 1;
  return {
    "Content-Type": "text/markdown; charset=utf-8",
    "X-Live-Smith-Command-Id": `concurrency-skill-${bridgeRequestSequence}`,
  };
}

function bridgeSkillDeleteHeaders(): Record<string, string> {
  bridgeRequestSequence += 1;
  return {
    "X-Live-Smith-Command-Id": `concurrency-skill-${bridgeRequestSequence}`,
  };
}

test("approval decisions follow the target Session and ignore global follow-up settings", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-approval-decision-"));
  await fs.writeFile(
    path.join(directory, "live-smith-settings.json"),
    JSON.stringify({
      schemaVersion: 4,
      activeProfileId: null,
      profiles: [],
      approvalMode: "everything",
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "0",
    }),
  );
  await saveGlobalSettings(directory, { defaultFollowUpBehavior: "steer" });
  const manualSession = await createSession(directory, {
    title: "Manual",
    projectKey: "project-1",
    scope: { kind: "selection", identity: "manual", label: "Manual" },
  });
  const automaticSession = await createSession(directory, {
    title: "Automatic",
    projectKey: "project-1",
    scope: { kind: "selection", identity: "automatic", label: "Automatic" },
    approvalMode: "low-risk",
  });
  const lowRiskPlan = {
    message: "Set tempo",
    actions: [{ type: "set_tempo" as const, tempo: 128 }],
  };
  const explicitPlan = {
    message: "Delete Bass",
    actions: [{ type: "delete_track" as const, trackName: "Bass" }],
  };
  let promptCalls = 0;
  const requestConfirmation = async () => {
    promptCalls += 1;
    return true;
  };

  assert.deepEqual(
    await decidePlanApproval(
      directory,
      manualSession.id,
      lowRiskPlan,
      requestConfirmation,
    ),
    { confirmed: true, source: "user" },
  );
  assert.deepEqual(
    await decidePlanApproval(
      directory,
      manualSession.id,
      explicitPlan,
      requestConfirmation,
    ),
    { confirmed: true, source: "user" },
  );
  assert.equal(promptCalls, 2);

  assert.deepEqual(
    await decidePlanApproval(
      directory,
      automaticSession.id,
      lowRiskPlan,
      requestConfirmation,
    ),
    { confirmed: true, source: "automatic", mode: "low-risk" },
  );
  assert.equal(promptCalls, 2);
  assert.deepEqual(
    await decidePlanApproval(
      directory,
      automaticSession.id,
      explicitPlan,
      requestConfirmation,
    ),
    { confirmed: true, source: "user" },
  );
  assert.equal(promptCalls, 3);

  await updateSession(directory, manualSession.id, { approvalMode: "everything" });
  assert.deepEqual(
    await decidePlanApproval(
      directory,
      manualSession.id,
      lowRiskPlan,
      requestConfirmation,
    ),
    { confirmed: true, source: "automatic", mode: "everything" },
  );
  assert.deepEqual(
    await decidePlanApproval(
      directory,
      manualSession.id,
      explicitPlan,
      requestConfirmation,
    ),
    { confirmed: true, source: "automatic", mode: "everything" },
  );
  assert.equal(promptCalls, 3);
});

test("approval decisions wait for an earlier Session mode transaction", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-approval-order-"));
  const session = await createSession(directory, {
    title: "Ordered",
    projectKey: "project-1",
    scope: { kind: "selection", identity: "ordered", label: "Ordered" },
  });
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  const write = withStorageTransaction(directory, async (transaction) => {
    started();
    await gate;
    await updateSessionInTransaction(
      transaction,
      directory,
      session.id,
      { approvalMode: "low-risk" },
    );
  });
  await active;

  let settled = false;
  const decision = decidePlanApproval(
    directory,
    session.id,
    { message: "Set tempo", actions: [{ type: "set_tempo", tempo: 128 }] },
    async () => true,
  ).then((value) => {
    settled = true;
    return value;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  release();
  await write;
  assert.deepEqual(await decision, {
    confirmed: true,
    source: "automatic",
    mode: "low-risk",
  });
});

test("Session approval changes publish to every open bridge for the same storage", async () => {
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-approval-notification-",
    firstDependencies: {
      requestModelTurn: async () => ({ content: "Unused", toolCalls: [] }),
    },
    secondDependencies: {
      requestModelTurn: async () => ({ content: "Unused", toolCalls: [] }),
    },
  });

  try {
    const events = await fetch(fixture.second.endpoint("/events"));
    const notification = readSsePayload(events, "approval_mode_changed");
    const response = await fetch(fixture.first.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        kind: "set_session_approval_mode",
        sessionId: fixture.sessionId,
        approvalMode: "everything",
      }),
    });

    assert.equal(response.status, 200);
    const state = await response.json() as ChatDialogState;
    assert.equal(state.approvalMode, "everything");
    assert.deepEqual(withoutBridgeStateRevision(
      await resolvesWithin(notification, "approval mode notification"),
    ), {
      type: "approval_mode_changed",
      sessionId: fixture.sessionId, approvalMode: "everything",
      updatedAt: state.sessions.find((session) => session.id === fixture.sessionId)!.updatedAt,
    });
    const secondState = await (await fetch(
      fixture.second.endpoint("/state"),
    )).json() as ChatDialogState;
    assert.equal(secondState.approvalMode, "everything");
  } finally {
    await fixture.close();
  }
});

test("global settings changes publish to every open bridge for the same storage", async () => {
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-follow-up-notification-",
    firstDependencies: {
      requestModelTurn: async () => ({ content: "Unused", toolCalls: [] }),
    },
    secondDependencies: {
      requestModelTurn: async () => ({ content: "Unused", toolCalls: [] }),
    },
  });

  try {
    const events = await fetch(fixture.second.endpoint("/events"));
    const notification = readSsePayload(
      events,
      "global_settings_changed",
      (payload) => payload.defaultFollowUpBehaviorRevision === "1",
    );
    const response = await fetch(fixture.first.endpoint("/command"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "global-settings-success",
      },
      body: JSON.stringify({
        kind: "save_global_settings",
        defaultFollowUpBehavior: "steer",
      }),
    });

    assert.equal(response.status, 200);
    const state = await response.json() as ChatDialogState;
    assert.equal(state.settings.defaultFollowUpBehavior, "steer");
    assert.equal(state.settings.defaultFollowUpBehaviorRevision, "1");
    assert.equal(state.settings.contextUsageVisibilityRevision, "0");
    assert.deepEqual(withoutBridgeStateRevision(
      await resolvesWithin(notification, "follow-up behavior notification"),
    ), {
      type: "global_settings_changed",
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "1",
      showContextUsage: true,
      contextUsageVisibilityRevision: "0",
      networkProxy: { mode: "none", url: "" },
      networkProxyRevision: "0",
      commandId: "global-settings-success",
    });
    const secondState = await (await fetch(
      fixture.second.endpoint("/state"),
    )).json() as ChatDialogState;
    assert.equal(secondState.settings.defaultFollowUpBehavior, "steer");
    assert.equal(secondState.settings.defaultFollowUpBehaviorRevision, "1");

    const contextEvents = await fetch(fixture.second.endpoint("/events"));
    const contextNotification = readSsePayload(
      contextEvents,
      "global_settings_changed",
      (payload) => payload.contextUsageVisibilityRevision === "1",
    );
    const contextResponse = await fetch(fixture.first.endpoint("/command"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "global-context-visibility",
      },
      body: JSON.stringify({
        kind: "save_global_settings",
        showContextUsage: false,
      }),
    });
    assert.equal(contextResponse.status, 200);
    assert.deepEqual(withoutBridgeStateRevision(
      await resolvesWithin(contextNotification, "context visibility notification"),
    ), {
      type: "global_settings_changed",
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "1",
      showContextUsage: false,
      contextUsageVisibilityRevision: "1",
      networkProxy: { mode: "none", url: "" },
      networkProxyRevision: "0",
      commandId: "global-context-visibility",
    });
    const contextState = await (await fetch(
      fixture.second.endpoint("/state"),
    )).json() as ChatDialogState;
    assert.equal(contextState.settings.showContextUsage, false);
    assert.equal(contextState.settings.contextUsageVisibilityRevision, "1");

    const proxyEvents = await fetch(fixture.second.endpoint("/events"));
    const proxyNotification = readSsePayload(
      proxyEvents,
      "global_settings_changed",
      (payload) => payload.networkProxyRevision === "1",
    );
    const proxyResponse = await fetch(fixture.first.endpoint("/command"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "global-network-proxy",
      },
      body: JSON.stringify({
        kind: "save_global_settings",
        networkProxy: {
          mode: "manual",
          url: "socks5://Proxy.Example:1080/",
        },
      }),
    });
    assert.equal(proxyResponse.status, 200);
    assert.deepEqual(withoutBridgeStateRevision(
      await resolvesWithin(proxyNotification, "network proxy notification"),
    ), {
      type: "global_settings_changed",
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "1",
      showContextUsage: false,
      contextUsageVisibilityRevision: "1",
      networkProxy: {
        mode: "manual",
        url: "socks5://proxy.example:1080",
      },
      networkProxyRevision: "1",
      commandId: "global-network-proxy",
    });
    const proxyState = await (await fetch(
      fixture.second.endpoint("/state"),
    )).json() as ChatDialogState;
    assert.deepEqual(proxyState.settings.networkProxy, {
      mode: "manual",
      url: "socks5://proxy.example:1080",
    });
    assert.equal(proxyState.settings.networkProxyRevision, "1");
  } finally {
    await fixture.close();
  }
});

test("Profile changes notify every open bridge without publishing credentials", async () => {
  let secondModelCalls = 0;
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-profile-notification-",
    firstDependencies: {
      requestModelTurn: async () => ({ content: "Unused", toolCalls: [] }),
    },
    secondDependencies: {
      requestModelTurn: async () => {
        secondModelCalls += 1;
        return { content: "Used refreshed Profile", toolCalls: [] };
      },
    },
  });

  try {
    const initial = await (await fetch(
      fixture.first.endpoint("/state"),
    )).json() as ChatDialogState;
    const current = initial.settings.profiles[0]!;
    assert.equal(current.connection.kind, "direct-api");
    if (current.connection.kind !== "direct-api") return;
    const updated: SavedProfile = {
      id: current.id,
      name: "Updated Provider",
      connection: current.connection,
      defaultModel: "model-b",
      models: [{
        model: "model-b",
        parameters: {
          maxOutputTokens: 1_000,
          reasoning: { mode: "default" },
        },
        advanced: {},
      }],
    };
    const events = await fetch(fixture.second.endpoint("/events"));
    const notification = readSsePayload(events, "profile_settings_changed");
    const response = await fetch(fixture.first.endpoint("/command"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "profile-settings-success",
      },
      body: JSON.stringify({
        kind: "save_profile",
        profile: updated,
        expectedProfileRevision: savedProfileRevision(current),
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(withoutBridgeStateRevision(
      await resolvesWithin(notification, "Profile settings notification"),
    ), {
      type: "profile_settings_changed",
      commandId: "profile-settings-success",
    });
    const staleSend = await fetch(fixture.second.endpoint("/send"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        prompt: "Do not use an unseen Profile",
        sessionId: fixture.sessionId,
      }),
    });
    assert.equal(staleSend.status, 409);
    assert.equal(secondModelCalls, 0);
    const secondState = await (await fetch(
      fixture.second.endpoint("/state"),
    )).json() as ChatBridgeState;
    assert.equal(secondState.settings.profiles[0]?.name, "Updated Provider");
    assert.equal(secondState.runtimeProfile?.selection.model, "model-b");
    const currentSend = await fetch(fixture.second.endpoint("/send"), {
      method: "POST",
      headers: bridgeSendHeaders(secondState),
      body: JSON.stringify({
        prompt: "Use the reviewed Profile",
        sessionId: fixture.sessionId,
      }),
    });
    assert.equal(currentSend.status, 200);
    assert.equal(secondModelCalls, 1);
  } finally {
    await fixture.close();
  }
});

test("an unknown global settings commit publishes its reconciled value to every bridge", async () => {
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-follow-up-unknown-",
    firstDependencies: {
      requestModelTurn: async () => ({ content: "Unused", toolCalls: [] }),
      saveGlobalSettings: async (storageDirectory, input) => {
        await saveGlobalSettings(storageDirectory, input);
        throw new StorageCommitOutcomeUnknownError(
          new Error("directory sync failed after rename"),
        );
      },
    },
    secondDependencies: {
      requestModelTurn: async () => ({ content: "Unused", toolCalls: [] }),
    },
  });

  try {
    const events = await fetch(fixture.second.endpoint("/events"));
    const notification = readSsePayload(
      events,
      "global_settings_changed",
      (payload) => payload.defaultFollowUpBehaviorRevision === "1",
    );
    const response = await fetch(fixture.first.endpoint("/command"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "global-settings-unknown",
      },
      body: JSON.stringify({
        kind: "save_global_settings",
        defaultFollowUpBehavior: "steer",
      }),
    });
    const body = await response.json() as {
      commandOutcome?: string;
      state?: ChatDialogState;
      reconciliationRequired?: boolean;
    };

    assert.equal(response.status, 500);
    assert.equal(body.commandOutcome, "unknown");
    assert.equal(body.reconciliationRequired, undefined);
    assert.equal(body.state?.settings.defaultFollowUpBehavior, "steer");
    assert.equal(body.state?.settings.defaultFollowUpBehaviorRevision, "1");
    assert.deepEqual(withoutBridgeStateRevision(
      await resolvesWithin(notification, "unknown commit notification"),
    ), {
      type: "global_settings_changed",
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "1",
      showContextUsage: true,
      contextUsageVisibilityRevision: "0",
      networkProxy: { mode: "none", url: "" },
      networkProxyRevision: "0",
      commandId: "global-settings-unknown",
    });
    const peerState = await (await fetch(
      fixture.second.endpoint("/state"),
    )).json() as ChatDialogState;
    assert.equal(peerState.settings.defaultFollowUpBehavior, "steer");
    assert.equal(peerState.settings.defaultFollowUpBehaviorRevision, "1");
  } finally {
    await fixture.close();
  }
});

test("unknown global settings readback stays ordered before a later save", async () => {
  const firstPersisted = deferred<void>();
  const releaseUnknown = deferred<void>();
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-follow-up-unknown-order-",
    firstDependencies: {
      requestModelTurn: async () => ({ content: "Unused", toolCalls: [] }),
      saveGlobalSettings: async (storageDirectory, input) => {
        await saveGlobalSettings(storageDirectory, input);
        firstPersisted.resolve();
        await releaseUnknown.promise;
        throw new StorageCommitOutcomeUnknownError(
          new Error("directory sync failed after rename"),
        );
      },
    },
    secondDependencies: {
      requestModelTurn: async () => ({ content: "Unused", toolCalls: [] }),
    },
  });
  let firstNotification: Promise<Record<string, unknown>> | undefined;
  let secondNotification: Promise<Record<string, unknown>> | undefined;

  try {
    const firstEvents = await fetch(fixture.first.endpoint("/events"));
    firstNotification = readSsePayload(
      firstEvents,
      "global_settings_changed",
      (payload) => payload.defaultFollowUpBehaviorRevision === "1",
    );
    const secondEvents = await fetch(fixture.second.endpoint("/events"));
    secondNotification = readSsePayload(
      secondEvents,
      "global_settings_changed",
      (payload) => payload.defaultFollowUpBehaviorRevision === "2",
    );
    const firstResponse = fetch(fixture.first.endpoint("/command"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "global-settings-unknown-first",
      },
      body: JSON.stringify({
        kind: "save_global_settings",
        defaultFollowUpBehavior: "steer",
      }),
    });
    await resolvesWithin(firstPersisted.promise, "first global settings write");

    let secondSettled = false;
    const secondResponse = fetch(fixture.second.endpoint("/command"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "global-settings-success-second",
      },
      body: JSON.stringify({
        kind: "save_global_settings",
        defaultFollowUpBehavior: "queue",
      }),
    }).then((response) => {
      secondSettled = true;
      return response;
    });
    assert.equal(await Promise.race([
      secondResponse.then(() => "settled" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 100);
      }),
    ]), "pending");
    assert.equal(secondSettled, false);

    releaseUnknown.resolve();
    const first = await resolvesWithin(firstResponse, "unknown settings response");
    assert.equal(first.status, 500);
    const firstBody = await first.json() as {
      commandOutcome?: string;
      state?: ChatDialogState;
    };
    assert.equal(firstBody.commandOutcome, "unknown");
    assert.equal(firstBody.state?.settings.defaultFollowUpBehavior, "steer");
    assert.equal(firstBody.state?.settings.defaultFollowUpBehaviorRevision, "1");

    const second = await resolvesWithin(secondResponse, "later settings response");
    assert.equal(second.status, 200);
    const secondBody = await second.json() as ChatDialogState;
    assert.equal(secondBody.settings.defaultFollowUpBehavior, "queue");
    assert.equal(secondBody.settings.defaultFollowUpBehaviorRevision, "2");
    assert.deepEqual(
      withoutBridgeStateRevision(
        await resolvesWithin(firstNotification, "first settings notification"),
      ),
      {
        type: "global_settings_changed",
        defaultFollowUpBehavior: "steer",
        defaultFollowUpBehaviorRevision: "1",
        showContextUsage: true,
        contextUsageVisibilityRevision: "0",
        networkProxy: { mode: "none", url: "" },
        networkProxyRevision: "0",
        commandId: "global-settings-unknown-first",
      },
    );
    assert.deepEqual(
      withoutBridgeStateRevision(
        await resolvesWithin(secondNotification, "second settings notification"),
      ),
      {
        type: "global_settings_changed",
        defaultFollowUpBehavior: "queue",
        defaultFollowUpBehaviorRevision: "2",
        showContextUsage: true,
        contextUsageVisibilityRevision: "0",
        networkProxy: { mode: "none", url: "" },
        networkProxyRevision: "0",
        commandId: "global-settings-success-second",
      },
    );
  } finally {
    releaseUnknown.resolve();
    await fixture.close();
    await Promise.allSettled([
      ...(firstNotification ? [firstNotification] : []),
      ...(secondNotification ? [secondNotification] : []),
    ]);
  }
});

test("concurrent state and discovery responses each keep models, capabilities, and source from one profile", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-state-race-"));
  const profileA = profile({
    baseUrl: "https://provider-a.test/v1",
    apiKey: "key-a",
    model: "model-a",
  });
  const profileB = profile({
    baseUrl: "https://provider-b.test/v1",
    apiKey: "key-b",
    model: "model-b",
  });
  const modelsA = [discoveredModel("model-a", 1_111)];
  const modelsB = [discoveredModel("model-b", 2_222)];
  await saveSavedProfile(directory, profileA);
  await saveModelCache(directory, profileA, modelsA);

  const discoveryGate = deferred<void>();
  const discoveryStarted = deferred<void>();

  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;

        const initialResponse = await fetch(endpoint("/state"));
        assert.equal(initialResponse.status, 200);
        const initialState = await initialResponse.json() as ChatDialogState;
        assertStateMatches(initialState, profileA, modelsA);

        const discoveryResponsePromise = fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({ kind: "discover_models", profile: profileB }),
        });
        await discoveryStarted.promise;

        let concurrentStateSettled = false;
        const concurrentStatePromise = fetch(endpoint("/state")).then((response) => {
          concurrentStateSettled = true;
          return response;
        });
        const stateBeforeDiscoveryTerminal = await Promise.race([
          concurrentStatePromise.then(() => "settled" as const),
          new Promise<"pending">((resolve) => {
            setTimeout(() => resolve("pending"), 100);
          }),
        ]);
        assert.equal(stateBeforeDiscoveryTerminal, "pending");
        assert.equal(concurrentStateSettled, false);

        discoveryGate.resolve();
        const discoveryResponse = await discoveryResponsePromise;
        assert.equal(discoveryResponse.status, 200);
        const discoveryState = await discoveryResponse.json() as ChatDialogState;
        assertStateMatches(discoveryState, profileB, modelsB);

        const concurrentStateResponse = await concurrentStatePromise;
        assert.equal(concurrentStateResponse.status, 200);
        const concurrentState = await concurrentStateResponse.json() as ChatDialogState;
        assertStateMatches(concurrentState, profileA, modelsA);
      },
    },
  };
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    listModels: async () => {
      discoveryStarted.resolve();
      await discoveryGate.promise;
      return modelsB;
    },
  });
});

test("two bridges serialize a same-Session send and delete without recreating events", async () => {
  const modelStarted = deferred<void>();
  const releaseModel = deferred<void>();
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-cross-bridge-delete-",
    firstDependencies: {
      requestModelTurn: async () => {
        modelStarted.resolve();
        await releaseModel.promise;
        return { content: "Done", toolCalls: [] };
      },
    },
    secondDependencies: {
      requestModelTurn: async () => ({ content: "Unused", toolCalls: [] }),
    },
  });

  try {
    const send = fetch(fixture.first.endpoint("/send"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        prompt: "Finish safely",
        sessionId: fixture.sessionId,
      }),
    });
    const sendBoundary = await resolvesWithin(Promise.race([
      modelStarted.promise.then(() => ({ type: "model" as const })),
      send.then(async (response) => ({
        type: "response" as const,
        status: response.status,
        body: await response.text(),
      })),
    ]), "first model request or early send response");
    assert.deepEqual(sendBoundary, { type: "model" });

    let deleteSettled = false;
    const deletion = fetch(fixture.second.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        kind: "delete_session",
        sessionId: fixture.sessionId,
      }),
    }).then((response) => {
      deleteSettled = true;
      return response;
    });
    assert.equal(await Promise.race([
      deletion.then(() => "settled" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 100);
      }),
    ]), "pending");
    assert.equal(deleteSettled, false);

    releaseModel.resolve();
    assert.equal((await send).status, 200);
    assert.equal((await deletion).status, 200);
    assert.equal(
      (await listSessions(fixture.directory)).some(
        (session) => session.id === fixture.sessionId,
      ),
      false,
    );
    assert.deepEqual(
      await loadSessionEvents(fixture.directory, fixture.sessionId),
      [],
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(
      await loadSessionEvents(fixture.directory, fixture.sessionId),
      [],
    );

    const deletedSend = await fetch(fixture.first.endpoint("/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "deleted-session-send",
      },
      body: JSON.stringify({
        prompt: "Must not fall back",
        sessionId: fixture.sessionId,
      }),
    });
    assert.equal(deletedSend.status, 409);
    const deletedSendBody = await deletedSend.json() as {
      promptPersistence?: string;
    };
    assert.equal(deletedSendBody.promptPersistence, "not_persisted");
    assert.deepEqual(
      await loadSessionEvents(fixture.directory, fixture.sessionId),
      [],
    );
  } finally {
    releaseModel.resolve();
    await fixture.close();
  }
});

test("a compact from another bridge is rejected while the same Session is sending", async () => {
  const modelStarted = deferred<void>();
  const releaseModel = deferred<void>();
  let compactRequests = 0;
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-cross-bridge-send-compact-",
    firstDependencies: {
      requestModelTurn: async () => {
        modelStarted.resolve();
        await releaseModel.promise;
        return { content: "Done", toolCalls: [] };
      },
    },
    secondDependencies: {
      requestModelTurn: async () => {
        compactRequests += 1;
        return { content: "Unexpected checkpoint", toolCalls: [] };
      },
    },
  });

  try {
    const send = fetch(fixture.first.endpoint("/send"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        prompt: "Hold this Session while generating",
        sessionId: fixture.sessionId,
      }),
    });
    await resolvesWithin(modelStarted.promise, "active Session model request");

    const compact = await resolvesWithin(fetch(fixture.second.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        kind: "compact_session",
        sessionId: fixture.sessionId,
      }),
    }), "cross-window compact rejection");
    assert.equal(compact.status, 409, await compact.text());
    assert.equal(compactRequests, 0);
    assert.equal(
      (await loadSessionEvents(fixture.directory, fixture.sessionId)).some(
        (event) => event.kind === "compaction",
      ),
      false,
    );

    releaseModel.resolve();
    assert.equal((await send).status, 200);
  } finally {
    releaseModel.resolve();
    await fixture.close();
  }
});

test("two concurrent compact commands append only one checkpoint", async () => {
  const compactStarted = deferred<void>();
  const releaseCompact = deferred<void>();
  let firstRequests = 0;
  let secondRequests = 0;
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-cross-bridge-double-compact-",
    firstDependencies: {
      requestModelTurn: async () => {
        firstRequests += 1;
        compactStarted.resolve();
        await releaseCompact.promise;
        return { content: "Shared checkpoint", toolCalls: [] };
      },
    },
    secondDependencies: {
      requestModelTurn: async () => {
        secondRequests += 1;
        return { content: "Duplicate checkpoint", toolCalls: [] };
      },
    },
  });

  try {
    await appendSessionEvent(fixture.directory, fixture.sessionId, {
      kind: "user",
      content: "Preserve the current arrangement plan",
    });
    await appendSessionEvent(fixture.directory, fixture.sessionId, {
      kind: "assistant",
      content: "The plan is ready.",
    });
    const first = fetch(fixture.first.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        kind: "compact_session",
        sessionId: fixture.sessionId,
      }),
    });
    await resolvesWithin(compactStarted.promise, "first compact model request");

    let secondSettled = false;
    const second = fetch(fixture.second.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        kind: "compact_session",
        sessionId: fixture.sessionId,
      }),
    }).then((response) => {
      secondSettled = true;
      return response;
    });
    assert.equal(await Promise.race([
      second.then(() => "settled" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 100);
      }),
    ]), "pending");
    assert.equal(secondSettled, false);

    releaseCompact.resolve();
    assert.equal((await first).status, 200);
    const secondResponse = await second;
    assert.equal(secondResponse.status, 409, await secondResponse.text());
    assert.equal(firstRequests, 1);
    assert.equal(secondRequests, 0);
    assert.deepEqual(
      (await loadSessionEvents(fixture.directory, fixture.sessionId)).map(
        (event) => event.kind,
      ),
      ["user", "assistant", "compaction"],
    );
  } finally {
    releaseCompact.resolve();
    await fixture.close();
  }
});

test("an unknown compact commit holds the Session fence through authoritative readback", async () => {
  const checkpointPersisted = deferred<void>();
  const readbackStarted = deferred<void>();
  const releaseReadback = deferred<void>();
  let blockReadback = false;
  let secondModelCalls = 0;
  const secondHistories: unknown[] = [];
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-cross-bridge-compact-unknown-",
    firstDependencies: {
      requestModelTurn: async () => ({
        content: "Unknown durable checkpoint",
        toolCalls: [],
      }),
      appendSessionEvent: async (...args) => {
        await appendSessionEvent(...args);
        blockReadback = true;
        checkpointPersisted.resolve();
        throw new StorageCommitOutcomeUnknownError(
          new Error("directory sync failed after checkpoint rename"),
        );
      },
      loadSessionEvents: async (...args) => {
        if (blockReadback) {
          readbackStarted.resolve();
          await releaseReadback.promise;
        }
        return loadSessionEvents(...args);
      },
    },
    secondDependencies: {
      requestModelTurn: async (input) => {
        secondModelCalls += 1;
        secondHistories.push(input.history);
        return { content: "Continued after checkpoint", toolCalls: [] };
      },
    },
  });

  try {
    await appendSessionEvent(fixture.directory, fixture.sessionId, {
      kind: "user",
      content: "Preserve this exact plan",
    });
    await appendSessionEvent(fixture.directory, fixture.sessionId, {
      kind: "assistant",
      content: "The exact plan is ready.",
    });
    const compact = fetch(fixture.first.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        kind: "compact_session",
        sessionId: fixture.sessionId,
      }),
    });
    await resolvesWithin(checkpointPersisted.promise, "checkpoint persistence");
    await resolvesWithin(readbackStarted.promise, "unknown commit readback");
    const secondState = await (
      await fetch(fixture.second.endpoint("/state"))
    ).json() as ChatBridgeState;

    let sendSettled = false;
    const send = fetch(fixture.second.endpoint("/send"), {
      method: "POST",
      headers: bridgeSendHeaders(secondState),
      body: JSON.stringify({
        prompt: "Continue from the durable checkpoint",
        sessionId: fixture.sessionId,
      }),
    }).then((response) => {
      sendSettled = true;
      return response;
    });
    assert.equal(await Promise.race([
      send.then(() => "settled" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 100);
      }),
    ]), "pending");
    assert.equal(sendSettled, false);
    assert.equal(secondModelCalls, 0);

    releaseReadback.resolve();
    const compactResponse = await compact;
    const compactBody = await compactResponse.json() as {
      commandOutcome?: string;
      state?: ChatDialogState;
    };
    assert.equal(compactResponse.status, 500);
    assert.equal(compactBody.commandOutcome, "unknown");
    assert.equal(
      compactBody.state?.events.filter((event) => event.kind === "compaction").length,
      1,
    );

    assert.equal((await send).status, 200);
    assert.equal(secondModelCalls, 1);
    assert.match(
      JSON.stringify(secondHistories[0]),
      /Unknown durable checkpoint/,
    );
    assert.equal(
      (await loadSessionEvents(fixture.directory, fixture.sessionId)).filter(
        (event) => event.kind === "compaction",
      ).length,
      1,
    );
  } finally {
    releaseReadback.resolve();
    await fixture.close();
  }
});

test("a second dialog opens while an existing Session send holds its fence", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-dialog-startup-fence-"));
  await saveSavedProfile(directory, profile({
    baseUrl: "https://provider.test/v1",
    apiKey: "key",
    model: "model-a",
  }));
  const firstDialog = deferred<string>();
  const secondDialog = deferred<string>();
  const closeFirstDialog = deferred<void>();
  const closeSecondDialog = deferred<void>();
  const modelStarted = deferred<void>();
  const releaseModel = deferred<void>();
  let dialogCount = 0;
  const leadTrack = fakeMidiTrack(1n, "Lead");
  const context = {
    application: {
      song: { handle: { id: 1n }, tracks: [leadTrack], scenes: [] },
    },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const index = dialogCount;
        dialogCount += 1;
        (index === 0 ? firstDialog : secondDialog).resolve(url);
        await (index === 0 ? closeFirstDialog.promise : closeSecondDialog.promise);
      },
    },
  };
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: { track: leadTrack },
    scope: { kind: "track", identity: "1", label: "Lead" },
  };
  const firstFlow = runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    requestModelTurn: async () => {
      modelStarted.resolve();
      await releaseModel.promise;
      return { content: "Done", toolCalls: [] };
    },
  });
  let secondFlow: Promise<void> | undefined;
  let send: Promise<Response> | undefined;

  try {
    const firstUrl = new URL(await resolvesWithin(firstDialog.promise, "first bridge"));
    const token = firstUrl.searchParams.get("token")!;
    const endpoint = (pathname: string) =>
      `${firstUrl.origin}${pathname}?token=${encodeURIComponent(token)}`;
    const state = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
    send = fetch(endpoint("/send"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        prompt: "Hold this Session fence",
        sessionId: state.activeSessionId,
      }),
    });
    await resolvesWithin(modelStarted.promise, "first model request");

    secondFlow = runAgentFlow(context as never, interaction, {
      renderHtml: () => "<html></html>",
      requestModelTurn: async () => ({ content: "Unused", toolCalls: [] }),
    });
    await resolvesWithin(secondDialog.promise, "second dialog startup", 300);
  } finally {
    releaseModel.resolve();
    closeFirstDialog.resolve();
    closeSecondDialog.resolve();
    await Promise.allSettled([
      firstFlow,
      ...(secondFlow ? [secondFlow] : []),
      ...(send ? [send] : []),
    ]);
  }
});

test("Skills mutate atomically and reject activation during another dialog's active send", async () => {
  const modelStarted = deferred<void>();
  const releaseModel = deferred<void>();
  let firstModelCalls = 0;
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-cross-bridge-skills-",
    firstDependencies: {
      requestModelTurn: async () => {
        firstModelCalls += 1;
        modelStarted.resolve();
        await releaseModel.promise;
        return { content: "Done", toolCalls: [] };
      },
    },
    secondDependencies: {
      requestModelTurn: async () => ({ content: "Unused", toolCalls: [] }),
    },
  });
  const markdown = NodeBuffer.from(
    "---\nname: mix-review\ndescription: Review the mix\n---\nKeep the low end clear.\n",
  );

  try {
    const builtInMarkdown = NodeBuffer.from(
      "---\nname: arranging-section-energy\ndescription: Override\n---\nUnsafe override.\n",
    );
    for (const replace of [false, true]) {
      const rejected = await fetch(
        `${fixture.second.endpoint("/skills")}&replace=${replace}`,
        { method: "POST", headers: bridgeSkillHeaders(), body: attachmentRequestBody(builtInMarkdown) },
      );
      assert.equal(rejected.status, 400);
    }
    const install = await fetch(`${fixture.second.endpoint("/skills")}&replace=false`, {
      method: "POST",
      headers: bridgeSkillHeaders(),
      body: attachmentRequestBody(markdown),
    });
    assert.equal(install.status, 201);
    const installBody = await install.json() as {
      receipt: { id: string; sha256: string };
    };
    assert.equal(installBody.receipt.id, "mix-review");
    assert.match(installBody.receipt.sha256, /^[a-f0-9]{64}$/);
    const staleSkillSend = await fetch(fixture.first.endpoint("/send"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        prompt: "Do not use unseen Skill content",
        sessionId: fixture.sessionId,
      }),
    });
    assert.equal(staleSkillSend.status, 409);
    assert.equal(firstModelCalls, 0);

    const historical = await createSession(fixture.directory, {
      title: "Historical mix",
      projectKey: "foreign-project",
      scope: { kind: "track", identity: "old-track", label: "Old Track" },
      activeSkillIds: ["mix-review"],
    });
    await setSessionArchived(fixture.directory, historical.id, true);
    const removalOnly = await fetch(fixture.second.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        kind: "set_session_skills",
        sessionId: historical.id,
        skillIds: [],
      }),
    });
    assert.equal(removalOnly.status, 200);
    assert.deepEqual(
      (await listSessions(fixture.directory)).find(
        (session) => session.id === historical.id,
      )?.activeSkillIds,
      [],
    );
    const historicalAddition = await fetch(fixture.second.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        kind: "set_session_skills",
        sessionId: historical.id,
        skillIds: ["mix-review"],
      }),
    });
    assert.equal(historicalAddition.status, 409);

    const reconciledSendState = await fetch(
      fixture.first.endpoint("/state"),
    ).then((response) => response.json() as Promise<ChatBridgeState>);
    assert.equal(reconciledSendState.activeSessionId, fixture.sessionId);
    const send = fetch(fixture.first.endpoint("/send"), {
      method: "POST",
      headers: bridgeSendHeaders(reconciledSendState),
      body: JSON.stringify({
        prompt: "Hold the Session lease",
        sessionId: fixture.sessionId,
      }),
    });
    await modelStarted.promise;
    assert.equal(firstModelCalls, 1);

    const conflict = await resolvesWithin(fetch(
      fixture.second.endpoint("/command"),
      {
        method: "POST",
        headers: bridgeJsonHeaders(),
        body: JSON.stringify({
          kind: "set_session_skills",
          sessionId: fixture.sessionId,
          skillIds: ["arranging-section-energy", "mix-review"],
        }),
      },
    ), "cross-dialog Skill activation conflict");
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json() as { error: string }).error, /active request/i);

    releaseModel.resolve();
    assert.equal((await send).status, 200);

    const activation = await fetch(fixture.second.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        kind: "set_session_skills",
        sessionId: fixture.sessionId,
        skillIds: ["arranging-section-energy", "mix-review"],
      }),
    });
    assert.equal(activation.status, 200);
    const activeState = await activation.json() as ChatDialogState;
    assert.deepEqual(activeState.activeSkillIds, [
      "arranging-section-energy",
      "mix-review",
    ]);
    assert.deepEqual(
      activeState.availableSkills,
      availableSkillSummaries([{ id: "mix-review", description: "Review the mix" }]),
    );
    const builtInDelete = await fetch(fixture.second.endpoint("/skills/arranging-section-energy"), {
      method: "DELETE", headers: bridgeSkillDeleteHeaders(),
    });
    assert.equal(builtInDelete.status, 200);
    assert.deepEqual((await builtInDelete.json() as ChatDialogState).activeSkillIds, activeState.activeSkillIds);
    const deleteInUse = await fetch(
      fixture.second.endpoint("/skills/mix-review"),
      { method: "DELETE", headers: bridgeSkillDeleteHeaders() },
    );
    assert.equal(deleteInUse.status, 409);

    const clearing = await fetch(fixture.second.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        kind: "set_session_skills",
        sessionId: fixture.sessionId,
        skillIds: [],
      }),
    });
    assert.equal(clearing.status, 200);

    const deletion = await fetch(
      fixture.second.endpoint("/skills/mix-review"),
      { method: "DELETE", headers: bridgeSkillDeleteHeaders() },
    );
    assert.equal(deletion.status, 200);
    const deletedState = await deletion.json() as ChatDialogState;
    assert.deepEqual(deletedState.availableSkills, availableSkillSummaries([]));
  } finally {
    releaseModel.resolve();
    await fixture.close();
  }
});

test("state reports active Skills from the same Session snapshot", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-state-skill-snapshot-"),
  );
  const staleSessionRead = deferred<void>();
  const releaseStaleSessionRead = deferred<void>();
  let pauseNextSessionRead = false;
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        const sessionId = initial.activeSessionId;
        const markdown = NodeBuffer.from(
          "---\nname: mix-review\ndescription: Review the mix\n---\nKeep the low end clear.\n",
        );
        const install = await fetch(`${endpoint("/skills")}&replace=false`, {
          method: "POST",
          headers: bridgeSkillHeaders(),
          body: attachmentRequestBody(markdown),
        });
        assert.equal(install.status, 201);
        const activation = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({
            kind: "set_session_skills",
            sessionId,
            skillIds: ["mix-review"],
          }),
        });
        assert.equal(activation.status, 200);

        pauseNextSessionRead = true;
        const stateRequest = fetch(endpoint("/state"));
        await staleSessionRead.promise;
        const clearing = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({
            kind: "set_session_skills",
            sessionId,
            skillIds: [],
          }),
        });
        assert.equal(clearing.status, 200);
        releaseStaleSessionRead.resolve();

        const stateResponse = await stateRequest;
        assert.equal(stateResponse.status, 200);
        const state = await stateResponse.json() as ChatDialogState;
        const activeSession = state.sessions.find(
          (session) => session.id === state.activeSessionId,
        );
        assert.ok(activeSession);
        assert.deepEqual(state.activeSkillIds, activeSession.activeSkillIds ?? []);
      },
    },
  };

  await runAgentFlow(context as never, {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  }, {
    renderHtml: () => "<html></html>",
    getOrCreateDefaultSession: async (...args) => {
      const session = await getOrCreateDefaultSession(...args);
      if (pauseNextSessionRead) {
        pauseNextSessionRead = false;
        staleSessionRead.resolve();
        await releaseStaleSessionRead.promise;
      }
      return session;
    },
  });
});

test("state revalidates events and pending attachments as one generation", async () => {
  const stateReadStarted = deferred<void>();
  const releaseStateRead = deferred<void>();
  let pauseNextStateRead = false;
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-state-session-snapshot-",
    firstDependencies: {
      loadSessionEvents: async (...args) => {
        const events = await loadSessionEvents(...args);
        if (pauseNextStateRead) {
          pauseNextStateRead = false;
          stateReadStarted.resolve();
          await releaseStateRead.promise;
        }
        return events;
      },
    },
    secondDependencies: {
      requestModelTurn: async () => ({ content: "Done", toolCalls: [] }),
    },
  });

  try {
    const imageProfile = profile({
      baseUrl: "https://provider.test/v1",
      apiKey: "key",
      model: "model-a",
      advanced: { capabilityOverrides: { inputs: { image: true } } },
    });
    await saveSavedProfile(fixture.directory, imageProfile);
    const attachment = await saveSessionAttachment(
      fixture.directory,
      fixture.sessionId,
      {
        fileName: "snapshot.png",
        bytes: sizedAttachmentPng(24),
      },
      { preSavePendingAttachmentRefs: [] },
    );
    pauseNextStateRead = true;
    const stateRequest = fetch(fixture.first.endpoint("/state"));
    await resolvesWithin(stateReadStarted.promise, "active Session state read");

    const send = fetch(fixture.second.endpoint("/send"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        prompt: "Consume the pending attachment",
        sessionId: fixture.sessionId,
      }),
    });
    const sendResponse = await resolvesWithin(send, "concurrent Session send");
    const sendBody = await sendResponse.clone().text();
    assert.equal(sendResponse.status, 200, sendBody);

    releaseStateRead.resolve();
    const stateResponse = await resolvesWithin(stateRequest, "state snapshot");
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json() as ChatDialogState;
    assert.deepEqual(state.pendingAttachments, []);
    assert.ok(
      state.events.some((event) =>
        event.kind === "user" &&
        event.content === "Consume the pending attachment" &&
        event.attachments?.some((ref) => ref.id === attachment.id)
      ),
    );
  } finally {
    releaseStateRead.resolve();
    await fixture.close();
  }
});

test("a held Session state build never acquires the dialog's different active Session", async () => {
  if (env.LIVE_SMITH_CROSS_SESSION_STATE_FIXTURE !== "1") {
    const testFile = fileURLToPath(import.meta.url);
    const result = await runIsolatedProcess(
      [
        "--import",
        "tsx",
        "--test",
        "--test-name-pattern=held Session state build never acquires",
        testFile,
      ],
      {
        cwd: path.dirname(path.dirname(path.dirname(testFile))),
        timeoutMs: 4_000,
        environment: { LIVE_SMITH_CROSS_SESSION_STATE_FIXTURE: "1" },
      },
    );
    assert.equal(
      result.timedOut,
      false,
      `isolated cross-Session state scenario deadlocked\n${result.stderr}`,
    );
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(
      result.stdout,
      /✔ a held Session state build never acquires/u,
      result.stdout,
    );
    return;
  }

  const firstModelStarted = deferred<void>();
  const releaseFirstModel = deferred<void>();
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-held-state-no-cross-lock-",
    firstDependencies: {
      requestModelTurn: async () => {
        firstModelStarted.resolve();
        await releaseFirstModel.promise;
        return { content: "First done", toolCalls: [] };
      },
    },
    secondDependencies: {
      requestModelTurn: async () => ({ content: "Second done", toolCalls: [] }),
    },
  });

  let firstSend: Promise<Response> | undefined;
  let secondSend: Promise<Response> | undefined;
  try {
    await appendSessionEvent(fixture.directory, fixture.sessionId, { kind: "user", content: "Existing Session A history" });
    const created = await fetch(fixture.first.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({ kind: "new_session" }),
    });
    assert.equal(created.status, 200);
    const sessionB = (await created.json() as ChatDialogState).activeSessionId;
    const selectedA = await fetch(fixture.first.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        kind: "select_session",
        sessionId: fixture.sessionId,
      }),
    });
    assert.equal(selectedA.status, 200);
    firstSend = fetch(fixture.first.endpoint("/send"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        prompt: "Hold Session A",
        sessionId: fixture.sessionId,
      }),
    });
    await resolvesWithin(firstModelStarted.promise, "Session A model request");
    const selectedB = await fetch(fixture.first.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({ kind: "select_session", sessionId: sessionB }),
    });
    assert.equal(selectedB.status, 200);
    const selectedBInSecond = await fetch(fixture.second.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({ kind: "select_session", sessionId: sessionB }),
    });
    assert.equal(selectedBInSecond.status, 200);
    const secondState = await selectedBInSecond.json() as ChatBridgeState;
    assert.equal(secondState.activeSessionId, sessionB);

    secondSend = fetch(fixture.second.endpoint("/send"), {
      method: "POST",
      headers: bridgeSendHeaders(secondState),
      body: JSON.stringify({
        prompt: "Finish Session B independently",
        sessionId: sessionB,
      }),
    });
    const secondResponse = await resolvesWithin(secondSend, "Session B send");
    assert.equal(secondResponse.status, 200);
    releaseFirstModel.resolve();
    assert.equal((await resolvesWithin(firstSend, "Session A send")).status, 200);
  } finally {
    releaseFirstModel.resolve();
    await Promise.allSettled([
      ...(firstSend ? [firstSend] : []),
      ...(secondSend ? [secondSend] : []),
    ]);
    await fixture.close();
  }
});

test("pending attachment cleanup cannot re-enter a held Session lease", {
  skip: os.platform() === "win32",
}, async () => {
  if (env.LIVE_SMITH_PENDING_CLEANUP_FIXTURE !== "1") {
    const testFile = fileURLToPath(import.meta.url);
    const result = await runIsolatedProcess(
      [
        "--import",
        "tsx",
        "--test",
        "--test-name-pattern=pending attachment cleanup cannot re-enter",
        testFile,
      ],
      {
        cwd: path.dirname(path.dirname(path.dirname(testFile))),
        timeoutMs: 4_000,
        environment: { LIVE_SMITH_PENDING_CLEANUP_FIXTURE: "1" },
      },
    );
    assert.equal(
      result.timedOut,
      false,
      `isolated pending-cleanup scenario deadlocked\n${result.stderr}`,
    );
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(
      result.stdout,
      /✔ pending attachment cleanup cannot re-enter/u,
      result.stdout,
    );
    return;
  }

  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-pending-cleanup-lease-"),
  );
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (
          await fetch(endpoint("/state"))
        ).json() as ChatDialogState;
        const sessionId = initial.activeSessionId;
        await saveSessionAttachment(
          directory,
          sessionId,
          {
            fileName: "reference.png",
            bytes: NodeBuffer.from([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
              0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
              0, 0, 0, 1, 0, 0, 0, 1,
            ]),
          },
          { preSavePendingAttachmentRefs: [] },
        );
        const attachmentRoot = path.join(directory, "live-smith-attachments");
        await fs.chmod(attachmentRoot, 0o500);
        try {
          const deletion = await fetch(endpoint("/command"), {
            method: "POST",
            headers: bridgeJsonHeaders(),
            body: JSON.stringify({ kind: "delete_session", sessionId }),
          });
          assert.equal(deletion.status, 500);
        } finally {
          await fs.chmod(attachmentRoot, 0o700);
        }

        const send = await fetch(endpoint("/send"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({ prompt: "Do not hang", sessionId }),
        });
        assert.equal(send.status, 500);
        const reconciled = await fetch(endpoint("/state"));
        assert.equal(reconciled.status, 200);
        assert.deepEqual(
          await listSessionAttachments(directory, sessionId),
          [],
        );
      },
    },
  };

  await runAgentFlow(
    context as never,
    {
      presentation: liveContextPresentationFixture("Lead"),
      summary: "Track: Lead",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Lead" },
    },
    { renderHtml: () => "<html></html>" },
  );
});

test("the HTTP send boundary validates whitespace without trimming the persisted prompt", async () => {
  const prompt = "  Keep leading and trailing whitespace.  ";
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-prompt-bytes-",
    firstDependencies: {
      requestModelTurn: async (input) => {
        assert.equal(input.prompt, prompt);
        return { content: "Done", toolCalls: [] };
      },
    },
    secondDependencies: {},
  });

  try {
    const response = await fetch(fixture.first.endpoint("/send"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({ prompt, sessionId: fixture.sessionId }),
    });
    assert.equal(response.status, 200);
    assert.equal(
      (await loadSessionEvents(fixture.directory, fixture.sessionId))
        .find((event) => event.kind === "user")?.content,
      prompt,
    );
  } finally {
    await fixture.close();
  }
});

test("stopping a same-Session send before or while it waits never persists its prompt", async () => {
  const firstModelStarted = deferred<void>();
  const releaseFirstModel = deferred<void>();
  let secondModelCalls = 0;
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-cross-bridge-stop-",
    firstDependencies: {
      requestModelTurn: async () => {
        firstModelStarted.resolve();
        await releaseFirstModel.promise;
        return { content: "First done", toolCalls: [] };
      },
    },
    secondDependencies: {
      requestModelTurn: async () => {
        secondModelCalls += 1;
        return { content: "Second must not run", toolCalls: [] };
      },
    },
  });

  try {
    const firstSend = fetch(fixture.first.endpoint("/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "first-lease-owner",
      },
      body: JSON.stringify({
        prompt: "First owns lease",
        sessionId: fixture.sessionId,
      }),
    });
    await resolvesWithin(firstModelStarted.promise, "first model request");

    const secondSend = fetch(fixture.second.endpoint("/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "second-queued-send",
      },
      body: JSON.stringify({
        prompt: "Queued prompt must stay draft",
        sessionId: fixture.sessionId,
      }),
    });
    const stopResponse = await resolvesWithin(
      fetch(fixture.second.endpoint("/stop"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Live-Smith-Send-Id": "second-queued-send",
        },
        body: "{}",
      }),
      "queued send stop response",
    );
    const stopResult = await stopResponse.json() as Record<string, unknown>;
    assert.equal(stopResult.ok, true);
    assert.equal(stopResult.sendId, "second-queued-send");
    assert.equal(typeof stopResult.terminal, "boolean");
    if (stopResult.terminal === true) {
      assert.equal(stopResult.promptPersistence, "unknown");
    } else {
      assert.equal(stopResult.promptPersistence, undefined);
    }

    const secondResponse = await resolvesWithin(
      secondSend,
      "aborted queued send response",
    );
    assert.equal(secondResponse.status, stopResult.terminal === true ? 409 : 500);
    assert.equal(
      (await secondResponse.json() as { promptPersistence?: string }).promptPersistence,
      "not_persisted",
    );
    assert.equal(secondModelCalls, 0);
    assert.deepEqual(
      (await loadSessionEvents(fixture.directory, fixture.sessionId)).map(
        (event) => event.content,
      ),
      ["First owns lease"],
    );

    releaseFirstModel.resolve();
    assert.equal((await firstSend).status, 200);
    assert.deepEqual(
      (await loadSessionEvents(fixture.directory, fixture.sessionId)).map(
        (event) => event.content,
      ),
      ["First owns lease", "First done"],
    );
    assert.equal(
      (await listSessions(fixture.directory)).find(
        (session) => session.id === fixture.sessionId,
      )?.title,
      "First owns lease",
    );
  } finally {
    releaseFirstModel.resolve();
    await fixture.close();
  }
});

test("closing a bridge after a stale same-Session send does not affect the lease owner", async () => {
  const firstModelStarted = deferred<void>();
  const releaseFirstModel = deferred<void>();
  let secondModelCalls = 0;
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-cross-bridge-close-queued-",
    firstDependencies: {
      requestModelTurn: async () => {
        firstModelStarted.resolve();
        await releaseFirstModel.promise;
        return { content: "First done", toolCalls: [] };
      },
    },
    secondDependencies: {
      requestModelTurn: async () => {
        secondModelCalls += 1;
        return { content: "Second must not run", toolCalls: [] };
      },
    },
  });

  try {
    let firstSettled = false;
    const firstSend = fetch(fixture.first.endpoint("/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "first-close-lease-owner",
      },
      body: JSON.stringify({
        prompt: "First owns lease during close",
        sessionId: fixture.sessionId,
      }),
    }).then((response) => {
      firstSettled = true;
      return response;
    });
    await resolvesWithin(firstModelStarted.promise, "first model request");

    const secondSend = fetch(fixture.second.endpoint("/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "second-close-queued",
      },
      body: JSON.stringify({
        prompt: "Queued close prompt must stay draft",
        sessionId: fixture.sessionId,
      }),
    });
    const secondBoundary = await resolvesWithin(Promise.race([
      secondSend.then((response) => ({ kind: "response" as const, response })),
      waitForSessionActivity(fixture.second, fixture.sessionId).then(() => ({
        kind: "active" as const,
      })),
    ]), "stale send admission");
    await resolvesWithin(fixture.closeSecond(), "queued bridge close");
    const secondResponse = secondBoundary.kind === "response"
      ? secondBoundary.response
      : await resolvesWithin(secondSend, "closed send response");
    assert.ok([409, 500].includes(secondResponse.status));
    assert.equal(
      (await secondResponse.json() as { promptPersistence?: string }).promptPersistence,
      "not_persisted",
    );
    assert.equal(firstSettled, false);
    assert.equal(secondModelCalls, 0);
    assert.deepEqual(
      (await loadSessionEvents(fixture.directory, fixture.sessionId)).map(
        (event) => event.content,
      ),
      ["First owns lease during close"],
    );

    releaseFirstModel.resolve();
    assert.equal((await firstSend).status, 200);
  } finally {
    releaseFirstModel.resolve();
    await fixture.close();
  }
});

test("a failed send builds its authoritative state before releasing the cross-bridge Session lease", async () => {
  const modelStarted = deferred<void>();
  const failModel = deferred<void>();
  const finalStateBuildStarted = deferred<void>();
  const releaseFinalStateBuild = deferred<void>();
  let blockNextStateBuild = false;
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-send-error-state-",
    firstDependencies: {
      loadSessionEvents: async (...args) => {
        if (blockNextStateBuild) {
          blockNextStateBuild = false;
          finalStateBuildStarted.resolve();
          await releaseFinalStateBuild.promise;
        }
        return loadSessionEvents(...args);
      },
      requestModelTurn: async () => {
        modelStarted.resolve();
        await failModel.promise;
        throw new Error("Model request failed safely.");
      },
    },
    secondDependencies: {
      requestModelTurn: async () => ({ content: "Unused", toolCalls: [] }),
    },
  });

  try {
    const events = await fetch(fixture.first.endpoint("/events"));
    const send = fetch(fixture.first.endpoint("/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "send-error-snapshot",
      },
      body: JSON.stringify({
        prompt: "Persist before model failure",
        sessionId: fixture.sessionId,
      }),
    });
    await resolvesWithin(modelStarted.promise, "failing model request");
    blockNextStateBuild = true;
    failModel.resolve();
    await resolvesWithin(finalStateBuildStarted.promise, "send failure state build");

    let deleteSettled = false;
    const deletion = fetch(fixture.second.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        kind: "delete_session",
        sessionId: fixture.sessionId,
      }),
    }).then((response) => {
      deleteSettled = true;
      return response;
    });
    assert.equal(await Promise.race([
      deletion.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]), "pending");
    assert.equal(deleteSettled, false);

    releaseFinalStateBuild.resolve();
    const errorEvent = await resolvesWithin(
      readSsePayload(events, "error"),
      "send error event",
    );
    assert.equal(errorEvent.sendId, "send-error-snapshot");
    assert.equal(errorEvent.promptPersistence, "persisted");
    assert.equal(
      ((errorEvent.state as ChatDialogState).sessions ?? []).some(
        (session) => session.id === fixture.sessionId,
      ),
      true,
    );
    assert.equal((await send).status, 500);
    assert.equal((await deletion).status, 200);

  } finally {
    failModel.resolve();
    releaseFinalStateBuild.resolve();
    await fixture.close();
  }
});

test("two bridges can run different Sessions concurrently", async () => {
  const firstModelStarted = deferred<void>();
  const secondModelStarted = deferred<void>();
  const releaseModels = deferred<void>();
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-cross-bridge-overlap-",
    firstDependencies: {
      requestModelTurn: async () => {
        firstModelStarted.resolve();
        await releaseModels.promise;
        return { content: "First done", toolCalls: [] };
      },
    },
    secondDependencies: {
      requestModelTurn: async () => {
        secondModelStarted.resolve();
        await releaseModels.promise;
        return { content: "Second done", toolCalls: [] };
      },
    },
  });

  try {
    await appendSessionEvent(fixture.directory, fixture.sessionId, { kind: "user", content: "Existing first Session history" });
    const newSessionResponse = await fetch(
      fixture.second.endpoint("/command"),
      {
        method: "POST",
        headers: bridgeJsonHeaders(),
        body: JSON.stringify({ kind: "new_session" }),
      },
    );
    assert.equal(newSessionResponse.status, 200);
    const secondSessionId = (await newSessionResponse.json() as ChatDialogState)
      .activeSessionId;
    assert.notEqual(secondSessionId, fixture.sessionId);

    const firstSend = fetch(fixture.first.endpoint("/send"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({ prompt: "First", sessionId: fixture.sessionId }),
    });
    const sendBoundary = await resolvesWithin(Promise.race([
      firstModelStarted.promise.then(() => ({ type: "model" as const })),
      firstSend.then(async (response) => ({
        type: "response" as const,
        status: response.status,
        body: await response.text(),
      })),
    ]), "first model request or early send response");
    assert.deepEqual(sendBoundary, { type: "model" });
    const secondSend = fetch(fixture.second.endpoint("/send"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({ prompt: "Second", sessionId: secondSessionId }),
    });
    await Promise.race([
      secondModelStarted.promise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("different Session send did not overlap")), 250);
      }),
    ]);

    releaseModels.resolve();
    assert.deepEqual(
      await Promise.all([firstSend, secondSend]).then((responses) =>
        responses.map((response) => response.status)
      ),
      [200, 200],
    );
    assert.equal(
      (await loadSessionEvents(fixture.directory, fixture.sessionId)).findLast((event) => event.kind === "user")?.content,
      "First",
    );
    assert.equal(
      (await loadSessionEvents(fixture.directory, secondSessionId))[0]?.content,
      "Second",
    );
  } finally {
    releaseModels.resolve();
    await fixture.close();
  }
});

test("a second bridge rejects a deleted Session before allocating an upload body", async () => {
  const allocations: number[] = [];
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-cross-bridge-upload-preflight-",
    firstDependencies: {},
    secondDependencies: {
      attachmentBodyReadOptions: {
        allocateBuffer: (byteLength) => {
          allocations.push(byteLength);
          return NodeBuffer.allocUnsafe(byteLength);
        },
      },
    },
  });

  try {
    const deletion = await fetch(fixture.first.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        kind: "delete_session",
        sessionId: fixture.sessionId,
      }),
    });
    assert.equal(deletion.status, 200);

    const upload = await fetch(
      fixture.second.endpoint("/attachments") +
        `&sessionId=${encodeURIComponent(fixture.sessionId)}` +
        "&fileName=must-not-buffer.png",
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: attachmentRequestBody(sizedAttachmentPng(24)),
      },
    );
    assert.equal(upload.status, 404);
    assert.deepEqual(allocations, []);
    assert.deepEqual(
      await listSessionAttachments(fixture.directory, fixture.sessionId),
      [],
    );
  } finally {
    await fixture.close();
  }
});

test("attachment upload revalidates its Session after the body-read race window", async () => {
  const bodyReadStarted = deferred<void>();
  const fixture = await openCrossBridgeFixture({
    directoryPrefix: "live-smith-cross-bridge-upload-race-",
    firstDependencies: {},
    secondDependencies: {
      attachmentBodyReadOptions: {
        allocateBuffer: (byteLength) => {
          bodyReadStarted.resolve();
          return NodeBuffer.allocUnsafe(byteLength);
        },
      },
    },
  });
  const uploadBytes = sizedAttachmentPng(24);
  const uploadUrl = new URL(
    fixture.second.endpoint("/attachments") +
      `&sessionId=${encodeURIComponent(fixture.sessionId)}` +
      "&fileName=race.png",
  );
  const socket = connect(Number(uploadUrl.port), uploadUrl.hostname);
  const responseChunks: NodeBuffer[] = [];
  socket.on("data", (chunk: NodeBuffer) => responseChunks.push(chunk));

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write([
      `POST ${uploadUrl.pathname}${uploadUrl.search} HTTP/1.1`,
      `Host: ${uploadUrl.host}`,
      "Content-Type: application/octet-stream",
      `Content-Length: ${uploadBytes.byteLength}`,
      "Connection: close",
      "",
      "",
    ].join("\r\n"));
    await resolvesWithin(bodyReadStarted.promise, "attachment body reader");

    const deletion = await fetch(fixture.first.endpoint("/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        kind: "delete_session",
        sessionId: fixture.sessionId,
      }),
    });
    assert.equal(deletion.status, 200);

    socket.write(NodeBuffer.from(uploadBytes));
    await new Promise<void>((resolve, reject) => {
      socket.once("end", resolve);
      socket.once("error", reject);
    });
    const statusLine = NodeBuffer.concat(responseChunks)
      .toString("utf8")
      .split("\r\n", 1)[0];
    assert.match(statusLine ?? "", /^HTTP\/1\.1 404 /);
    assert.deepEqual(
      await listSessionAttachments(fixture.directory, fixture.sessionId),
      [],
    );
  } finally {
    socket.destroy();
    await fixture.close();
  }
});

test("model discovery accepts a Draft with blank name and model without changing Runtime", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-blank-draft-"));
  const active = profile({
    baseUrl: "https://active.test/v1",
    apiKey: "active-key",
    model: "active-model",
  });
  await saveSavedProfile(directory, active);
  const draft = {
    ...profile({
      baseUrl: "https://draft.test/v1",
      apiKey: "draft-key",
      model: "draft-model",
    }),
    name: "",
    defaultModel: "",
    models: [{
      ...profile({
        baseUrl: "https://draft.test/v1",
        apiKey: "draft-key",
        model: "draft-model",
      }).models[0]!,
      model: "",
    }],
  };
  const discovered = [discoveredModel("draft-model", 4_096)];

  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const response = await fetch(
          `${chatUrl.origin}/command?token=${token}`,
          {
            method: "POST",
            headers: bridgeJsonHeaders(),
            body: JSON.stringify({ kind: "discover_models", profile: draft }),
          },
        );
        assert.equal(response.status, 200);
        const state = await response.json() as ChatDialogState;
        assert.equal(state.modelStateSource?.model, "");
        assert.deepEqual(state.availableModels.map((model) => model.id), ["draft-model"]);
        assert.equal(state.runtimeProfile?.profile.name, active.name);
        assert.equal(
          state.runtimeProfile?.selection.model,
          active.defaultModel,
        );
      },
    },
  };

  await runAgentFlow(context as never, {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  }, {
    renderHtml: () => "<html></html>",
    listModels: async (receivedDraft) => {
      assert.equal(receivedDraft.name, "");
      assert.equal(receivedDraft.defaultModel, "");
      assert.equal(receivedDraft.models[0]?.model, "");
      return discovered;
    },
  });
});

test("a definite Session metadata deletion failure preserves event history", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-delete-metadata-failure-"));
  let deletedSessionId = "";
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initialState = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        deletedSessionId = initialState.activeSessionId;
        await appendSessionEvent(directory, deletedSessionId, {
          kind: "user",
          content: "History must survive a definite metadata failure.",
        });

        const failed = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({ kind: "delete_session", sessionId: deletedSessionId }),
        });
        assert.equal(failed.status, 500);
        assert.ok(
          (await listSessions(directory)).some((session) => session.id === deletedSessionId),
        );
        assert.deepEqual(
          (await loadSessionEvents(directory, deletedSessionId)).map((event) => event.content),
          ["History must survive a definite metadata failure."],
        );
      },
    },
  };

  await runAgentFlow(
    context as never,
    {
      presentation: liveContextPresentationFixture("Lead"),
      summary: "Track: Lead",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Lead" },
    },
    {
      renderHtml: () => "<html></html>",
      deleteSession: async () => {
        throw new Error("sessions metadata write failed");
      },
    },
  );
  assert.ok(deletedSessionId);
});

test("an event-log cleanup failure leaves the logically deleted Session reconcilable", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-delete-retry-"));
  let deletedSessionId = "";
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initialState = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        deletedSessionId = initialState.activeSessionId;
        const eventPath = path.join(
          directory,
          "live-smith-events",
          `${deletedSessionId}.json`,
        );
        await fs.mkdir(eventPath, { recursive: true });

        const failed = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({ kind: "delete_session", sessionId: deletedSessionId }),
        });
        assert.equal(failed.status, 500);
        const failure = await failed.json() as { commandOutcome?: string };
        assert.equal(failure.commandOutcome, "unknown");
        assert.ok(
          !(await listSessions(directory)).some((session) => session.id === deletedSessionId),
        );

        await fs.rmdir(eventPath);
        const reconciled = await fetch(endpoint("/state"));
        assert.equal(reconciled.status, 200);
        assert.ok(
          !(await listSessions(directory)).some((session) => session.id === deletedSessionId),
        );
      },
    },
  };

  await runAgentFlow(
    context as never,
    {
      presentation: liveContextPresentationFixture("Lead"),
      summary: "Track: Lead",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Lead" },
    },
    { renderHtml: () => "<html></html>" },
  );
  assert.ok(deletedSessionId);
});

test("session deletion removes attachments only after events and metadata", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-delete-attachments-"));
  let deletedSessionId = "";
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        deletedSessionId = initial.activeSessionId;
        await saveSessionAttachment(directory, deletedSessionId, {
          fileName: "reference.png",
          bytes: new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
            0, 0, 0, 1, 0, 0, 0, 1,
          ]),
        }, { preSavePendingAttachmentRefs: [] });

        const response = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({ kind: "delete_session", sessionId: deletedSessionId }),
        });

        assert.equal(response.status, 200);
        assert.ok(!(await listSessions(directory)).some(
          (session) => session.id === deletedSessionId,
        ));
        assert.deepEqual(await listSessionAttachments(directory, deletedSessionId), []);
      },
    },
  };

  await runAgentFlow(context as never, {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  }, { renderHtml: () => "<html></html>" });
  assert.ok(deletedSessionId);
});

test("session deletion attachment cleanup failure is unknown and retried from state", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-delete-orphan-"));
  let deletedSessionId = "";
  let attachmentRoot = "";
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        deletedSessionId = initial.activeSessionId;
        await saveSessionAttachment(directory, deletedSessionId, {
          fileName: "reference.png",
          bytes: new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
            0, 0, 0, 1, 0, 0, 0, 1,
          ]),
        }, { preSavePendingAttachmentRefs: [] });
        attachmentRoot = path.join(directory, "live-smith-attachments");
        await fs.chmod(attachmentRoot, 0o500);

        const response = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({ kind: "delete_session", sessionId: deletedSessionId }),
        });

        assert.equal(response.status, 500);
        const body = await response.json() as {
          commandOutcome?: string;
          reconciliationRequired?: boolean;
          state?: ChatDialogState;
        };
        assert.equal(body.commandOutcome, "unknown");
        assert.equal(body.reconciliationRequired, true);
        assert.equal(body.state, undefined);
        assert.ok(!(await listSessions(directory)).some(
          (session) => session.id === deletedSessionId,
        ));

        await fs.chmod(attachmentRoot, 0o700);
        const reconciledResponse = await fetch(endpoint("/state"));
        assert.equal(reconciledResponse.status, 200);
        const reconciled = await reconciledResponse.json() as ChatDialogState;
        assert.ok(!reconciled.sessions.some(
          (session) => session.id === deletedSessionId,
        ));
        assert.deepEqual(
          await listSessionAttachments(directory, deletedSessionId),
          [],
        );
      },
    },
  };

  try {
    await runAgentFlow(context as never, {
      presentation: liveContextPresentationFixture("Lead"),
      summary: "Track: Lead",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Lead" },
    }, { renderHtml: () => "<html></html>" });
  } finally {
    if (attachmentRoot) await fs.chmod(attachmentRoot, 0o700).catch(() => undefined);
  }
  assert.ok(deletedSessionId);
});

test("an unknown Session metadata delete commit reconciles attachment cleanup", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-delete-unknown-"));
  let deletedSessionId = "";
  let injected = false;
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        deletedSessionId = initial.activeSessionId;
        await saveSessionAttachment(directory, deletedSessionId, {
          fileName: "unknown-delete.png",
          bytes: sizedAttachmentPng(24),
        }, { preSavePendingAttachmentRefs: [] });

        const response = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({ kind: "delete_session", sessionId: deletedSessionId }),
        });
        assert.equal(response.status, 500);
        const body = await response.json() as {
          commandOutcome?: string;
          state?: ChatDialogState;
        };
        assert.equal(body.commandOutcome, "unknown");
        assert.ok(!body.state?.sessions.some(
          (session) => session.id === deletedSessionId,
        ));
        assert.equal(
          (await listSessions(directory)).some(
            (session) => session.id === deletedSessionId,
          ),
          false,
        );
        assert.deepEqual(
          await listSessionAttachments(directory, deletedSessionId),
          [],
        );
      },
    },
  };

  await runAgentFlow(context as never, {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  }, {
    renderHtml: () => "<html></html>",
    deleteSession: async (...args) => {
      await deleteSession(...args);
      if (!injected) {
        injected = true;
        throw new StorageCommitOutcomeUnknownError(
          Object.assign(new Error("directory sync failed"), { code: "EIO" }),
        );
      }
    },
  });
  assert.equal(injected, true);
});

test("attachment routes enforce Session ownership, pending state, and immutable references", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-attachment-routes-"));
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token")!;
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${encodeURIComponent(token)}`;
        const attachmentEndpoint = (sessionId: string, fileName: string) =>
          `${chatUrl.origin}/attachments?token=${encodeURIComponent(token)}` +
          `&sessionId=${encodeURIComponent(sessionId)}` +
          `&fileName=${encodeURIComponent(fileName)}`;
        const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        const sessionId = initial.activeSessionId;
        const projectKey = initial.sessions[0]!.projectKey;

        const invalid = await fetch(attachmentEndpoint(sessionId, "not-an-image.txt"), {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: attachmentRequestBody(new Uint8Array([1, 2, 3])),
        });
        assert.equal(invalid.status, 400);

        const firstUpload = await fetch(attachmentEndpoint(sessionId, "first.png"), {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: attachmentRequestBody(sizedAttachmentPng(24)),
        });
        assert.equal(firstUpload.status, 201);
        const firstState = await firstUpload.json() as ChatDialogState;
        assert.equal(firstState.pendingAttachments.length, 1);
        const first = firstState.pendingAttachments[0]!;

        const secondUpload = await fetch(attachmentEndpoint(sessionId, "second.png"), {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: attachmentRequestBody(sizedAttachmentPng(25)),
        });
        assert.equal(secondUpload.status, 201);
        const secondState = await secondUpload.json() as ChatDialogState;
        const second = secondState.pendingAttachments.find(
          (attachment) => attachment.id !== first.id,
        );
        assert.ok(second);

        const deleted = await fetch(
          `${chatUrl.origin}/attachments/${encodeURIComponent(second.id)}` +
            `?token=${encodeURIComponent(token)}` +
            `&sessionId=${encodeURIComponent(sessionId)}`,
          { method: "DELETE" },
        );
        assert.equal(deleted.status, 200);
        assert.deepEqual(
          (await deleted.json() as ChatDialogState).pendingAttachments.map(
            (attachment) => attachment.id,
          ),
          [first.id],
        );

        const foreign = await createSession(directory, {
          title: "Foreign",
          projectKey: "another-live-set",
          scope: { kind: "track", identity: "foreign", label: "Foreign" },
        });
        const foreignUpload = await fetch(
          attachmentEndpoint(foreign.id, "foreign.png"),
          {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: attachmentRequestBody(sizedAttachmentPng(24)),
          },
        );
        assert.equal(foreignUpload.status, 404);

        const archived = await createSession(directory, {
          title: "Archived",
          projectKey,
          scope: { kind: "track", identity: "archived", label: "Archived" },
        });
        await setSessionArchived(directory, archived.id, true);
        const archivedUpload = await fetch(
          attachmentEndpoint(archived.id, "archived.png"),
          {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: attachmentRequestBody(sizedAttachmentPng(24)),
          },
        );
        assert.equal(archivedUpload.status, 404);

        await appendSessionEvent(directory, sessionId, {
          kind: "user",
          content: "Use the first image",
          attachments: [first],
        });
        const referencedDelete = await fetch(
          `${chatUrl.origin}/attachments/${encodeURIComponent(first.id)}` +
            `?token=${encodeURIComponent(token)}` +
            `&sessionId=${encodeURIComponent(sessionId)}`,
          { method: "DELETE" },
        );
        assert.equal(referencedDelete.status, 409);

        const removed = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({ kind: "delete_session", sessionId }),
        });
        assert.equal(removed.status, 200);
        const removedUpload = await fetch(
          attachmentEndpoint(sessionId, "removed.png"),
          {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: attachmentRequestBody(sizedAttachmentPng(24)),
          },
        );
        assert.equal(removedUpload.status, 404);
      },
    },
  };

  await runAgentFlow(context as never, {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  }, { renderHtml: () => "<html></html>" });
});

test("attachment upload accepts the exact pending image subtotal and count limit then rejects one more", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-attachment-quota-"));
  const perAttachmentBytes = MAX_PENDING_IMAGE_ATTACHMENT_BYTES /
    MAX_PENDING_ATTACHMENT_COUNT;
  assert.equal(Number.isInteger(perAttachmentBytes), true);
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token")!;
        const initial = await (await fetch(
          `${chatUrl.origin}/state?token=${encodeURIComponent(token)}`,
        )).json() as ChatDialogState;
        const endpoint = (fileName: string) =>
          `${chatUrl.origin}/attachments?token=${encodeURIComponent(token)}` +
          `&sessionId=${encodeURIComponent(initial.activeSessionId)}` +
          `&fileName=${encodeURIComponent(fileName)}`;

        for (let index = 0; index < MAX_PENDING_ATTACHMENT_COUNT; index += 1) {
          const response = await fetch(endpoint(`boundary-${index}.png`), {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: attachmentRequestBody(sizedAttachmentPng(perAttachmentBytes)),
          });
          assert.equal(response.status, 201);
        }

        const atBoundary = await (await fetch(
          `${chatUrl.origin}/state?token=${encodeURIComponent(token)}`,
        )).json() as ChatDialogState;
        assert.equal(atBoundary.pendingAttachments.length, MAX_PENDING_ATTACHMENT_COUNT);
        assert.equal(
          atBoundary.pendingAttachments.reduce(
            (total, attachment) => total + attachment.byteLength,
            0,
          ),
          MAX_PENDING_IMAGE_ATTACHMENT_BYTES,
        );
        assert.equal(
          atBoundary.pendingAttachments.reduce(
            (total, attachment) => total + attachment.byteLength,
            0,
          ) < MAX_PENDING_ATTACHMENT_BYTES,
          true,
        );

        const over = await fetch(endpoint("one-too-many.png"), {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: attachmentRequestBody(sizedAttachmentPng(24)),
        });
        assert.equal(over.status, 413);
        assert.equal(
          (await listSessionAttachments(directory, initial.activeSessionId)).length,
          MAX_PENDING_ATTACHMENT_COUNT,
        );
      },
    },
  };

  await runAgentFlow(context as never, {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  }, { renderHtml: () => "<html></html>" });
});

test("startup orphan reconciliation removes abandoned Session data and preserves live data", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-attachment-orphans-"));
  const liveSession = await createSession(directory, {
    title: "Live",
    projectKey: "existing-project",
    scope: { kind: "track", identity: "live", label: "Live" },
  });
  const liveAttachment = await saveSessionAttachment(directory, liveSession.id, {
    fileName: "live.png",
    bytes: sizedAttachmentPng(24),
  }, { preSavePendingAttachmentRefs: [] });
  await appendSessionEvent(directory, liveSession.id, {
    kind: "user",
    content: "Keep the live Session history.",
  });
  const orphanSessionId = "orphan-session";
  await saveSessionAttachment(directory, orphanSessionId, {
    fileName: "orphan.png",
    bytes: sizedAttachmentPng(24),
  }, { preSavePendingAttachmentRefs: [] });
  await appendSessionEvent(directory, orphanSessionId, {
    kind: "user",
    content: "Remove the abandoned Session history after restart.",
  });

  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async () => {
        assert.deepEqual(
          (await listSessionAttachments(directory, liveSession.id)).map(
            (attachment) => attachment.id,
          ),
          [liveAttachment.id],
        );
        assert.deepEqual(await listSessionAttachments(directory, orphanSessionId), []);
        assert.deepEqual(await listSessionEventLogIds(directory), [liveSession.id]);
        assert.deepEqual(
          (await loadSessionEvents(directory, liveSession.id)).map((event) => event.content),
          ["Keep the live Session history."],
        );
      },
    },
  };

  await runAgentFlow(context as never, {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  }, { renderHtml: () => "<html></html>" });
});

test("a post-commit state failure is reconciled as an unknown command outcome", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-command-reconcile-"));
  let sessionLookupCount = 0;
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const response = await fetch(`${chatUrl.origin}/command?token=${token}`, {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({ kind: "new_session" }),
        });
        const body = await response.json() as {
          commandOutcome?: string;
          reconciliationRequired?: boolean;
          state?: ChatDialogState;
        };

        assert.equal(response.status, 500);
        assert.equal(body.commandOutcome, "unknown");
        assert.equal(body.reconciliationRequired, undefined);
        assert.equal(body.state?.sessions.length, 1);
        assert.equal(body.state?.activeSessionId, body.state?.sessions[0]?.id);
        assert.equal(body.state?.sessions[0]?.title, "");
      },
    },
  };

  await runAgentFlow(
    context as never,
    {
      presentation: liveContextPresentationFixture("Lead"),
      summary: "Track: Lead",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Lead" },
    },
    {
      renderHtml: () => "<html></html>",
      getOrCreateDefaultSession: async (...args) => {
        sessionLookupCount += 1;
        if (sessionLookupCount === 1) throw new Error("state unavailable after commit");
        return getOrCreateDefaultSession(...args);
      },
    },
  );

  assert.equal((await listSessions(directory)).length, 1);
});

test("selecting a Track Session refreshes context from that Session's Live object", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-target-switch-"));
  const trackA = fakeMidiTrack(101n, "Bass");
  const trackB = fakeMidiTrack(202n, "Lead");
  const context = {
    application: {
      song: { handle: { id: 1n }, tracks: [trackA, trackB], scenes: [] },
    },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        assert.match(initial.contextSummary, /MIDI track "Bass"/);
        const leadSession = await createSession(directory, {
          title: "Lead session",
          projectKey: initial.sessions[0]!.projectKey,
          scope: { kind: "track", identity: "202", label: "Lead" },
        });

        const selected = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({ kind: "select_session", sessionId: leadSession.id }),
        });
        const selectedState = await selected.json() as ChatDialogState;
        assert.equal(selectedState.activeSessionId, leadSession.id);
        assert.match(selectedState.contextSummary, /MIDI track "Lead"/);
        assert.doesNotMatch(selectedState.contextSummary, /MIDI track "Bass"/);

        trackB.name = "Lead renamed";
        const refreshed = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        assert.match(refreshed.contextSummary, /Lead renamed/);

        context.application.song.tracks.splice(1, 1);
        const unavailable = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        assert.match(unavailable.contextSummary, /Live object.*unavailable/i);
        const events = await fetch(endpoint("/events"));
        const errorEvent = readSsePayload(
          events,
          "error",
          (payload) => payload.sendId === "unavailable-track-send",
        );
        const send = await fetch(endpoint("/send"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Send-Id": "unavailable-track-send",
          },
          body: JSON.stringify({ prompt: "Change this track", sessionId: leadSession.id }),
        });
        assert.equal(send.status, 500);
        const sendBody = await send.json() as {
          error: string;
          promptPersistence?: string;
          sendFailureKind?: string;
          state?: ChatDialogState;
        };
        assert.match(sendBody.error, /no longer available/i);
        assert.equal(sendBody.promptPersistence, "not_persisted");
        assert.equal(sendBody.sendFailureKind, "session_unavailable");
        assert.equal(sendBody.state?.activeSessionId, leadSession.id);
        assert.match(sendBody.state?.contextSummary ?? "", /Live object.*unavailable/i);
        const event = await resolvesWithin(errorEvent, "unavailable Track error event");
        assert.equal(event.promptPersistence, "not_persisted");
        assert.equal(event.sendFailureKind, "session_unavailable");
        assert.equal((event.state as ChatDialogState).activeSessionId, leadSession.id);
      },
    },
  };

  await runAgentFlow(
    context as never,
    {
      presentation: liveContextPresentationFixture("Bass"),
      summary: "Opening Bass context",
      target: { track: trackA },
      scope: { kind: "track", identity: "101", label: "Bass" },
    },
    { renderHtml: () => "<html></html>" },
  );
});

test("a concurrent Session switch cannot capture an unresolved invocation selection", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-selection-bind-race-"),
  );
  const initialLookupStarted = deferred<string>();
  const releaseInitialLookup = deferred<void>();
  let lookupCount = 0;
  const bass = fakeMidiTrack(101n, "Bass");
  const lead = fakeMidiTrack(202n, "Lead");
  const context = {
    application: {
      song: { handle: { id: 1n }, tracks: [bass, lead], scenes: [] },
    },
    environment: { storageDirectory: directory },
    getObjectFromHandle: () => bass,
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const lateInitialState = fetch(endpoint("/state"));
        const projectKey = await initialLookupStarted.promise;
        const leadSession = await createSession(directory, {
          title: "Ordinary Lead Session",
          projectKey,
          scope: { kind: "track", identity: "202", label: "Lead" },
        });

        let selectedState: ChatDialogState;
        try {
          const selected = await fetch(endpoint("/command"), {
            method: "POST",
            headers: bridgeJsonHeaders(),
            body: JSON.stringify({
              kind: "select_session",
              sessionId: leadSession.id,
            }),
          });
          selectedState = await selected.json() as ChatDialogState;
        } finally {
          releaseInitialLookup.resolve();
        }

        const reconciled = await (await lateInitialState).json() as ChatDialogState;
        assert.equal(selectedState.activeSessionId, leadSession.id);
        assert.match(selectedState.contextSummary, /MIDI track "Lead"/);
        assert.doesNotMatch(selectedState.contextSummary, /Arrangement selection/);
        assert.equal(reconciled.activeSessionId, leadSession.id);
        assert.match(reconciled.contextSummary, /MIDI track "Lead"/);
      },
    },
  };
  const interaction = arrangementSelectionInteractionContext(
    context as never,
    {
      selected_lanes: [bass.handle],
      time_selection_start: 8,
      time_selection_end: 16,
    } as never,
  );

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    getOrCreateDefaultSession: async (...args) => {
      lookupCount += 1;
      if (lookupCount === 1) {
        initialLookupStarted.resolve(args[2]);
        await releaseInitialLookup.promise;
      }
      return getOrCreateDefaultSession(...args);
    },
  });
});

test("a cross-track Clip Slot selection becomes unavailable when any selected Track disappears", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-clip-slot-context-"),
  );
  const bass = fakeMidiTrackWithSlots(301n, "Bass", 2);
  const lead = fakeMidiTrackWithSlots(302n, "Lead", 2);
  const selectedBassSlot = bass.slots[1]!;
  const selectedLeadSlot = lead.slots[0]!;
  const slotsById = new Map(
    [...bass.slots, ...lead.slots].map((slot) => [slot.handle.id, slot]),
  );
  const context = {
    application: {
      song: {
        handle: { id: 1n },
        tracks: [bass.track, lead.track],
        scenes: [],
      },
    },
    environment: { storageDirectory: directory },
    getObjectFromHandle: (handle: { id: bigint }) => slotsById.get(handle.id),
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (
          await fetch(endpoint("/state"))
        ).json() as ChatDialogState;
        assert.match(initial.contextSummary, /track "Bass", slotIndex=1/);
        assert.match(initial.contextSummary, /track "Lead", slotIndex=0/);

        bass.slots.reverse();
        const reordered = await (
          await fetch(endpoint("/state"))
        ).json() as ChatDialogState;
        assert.match(reordered.contextSummary, /track "Bass", slotIndex=0/);

        context.application.song.tracks.splice(1, 1);
        const unavailable = await (
          await fetch(endpoint("/state"))
        ).json() as ChatDialogState;
        assert.match(unavailable.contextSummary, /Live object.*unavailable/i);
      },
    },
  };
  const interaction = clipSlotSelectionInteractionContext(
    context as never,
    {
      selected_clip_slots: [selectedBassSlot.handle, selectedLeadSlot.handle],
    },
  );

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
  });
});

test("a late state snapshot cannot roll active Session back after a switch", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-session-cas-"));
  const lookupStarted = deferred<void>();
  const releaseLookup = deferred<void>();
  let lookupCount = 0;
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        const sessionB = await createSession(directory, {
          title: "Session B",
          projectKey: initial.sessions[0]!.projectKey,
          scope: { kind: "track", identity: "track-2", label: "Track B" },
        });

        const lateStatePromise = fetch(endpoint("/state"));
        await lookupStarted.promise;
        const selected = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({ kind: "select_session", sessionId: sessionB.id }),
        });
        assert.equal((await selected.json() as ChatDialogState).activeSessionId, sessionB.id);

        releaseLookup.resolve();
        const lateState = await (await lateStatePromise).json() as ChatDialogState;
        assert.equal(lateState.activeSessionId, sessionB.id);
        const authoritative = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        assert.equal(authoritative.activeSessionId, sessionB.id);
      },
    },
  };

  await runAgentFlow(
    context as never,
    {
      presentation: liveContextPresentationFixture("Track A"),
      summary: "Track A",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Track A" },
    },
    {
      renderHtml: () => "<html></html>",
      getOrCreateDefaultSession: async (...args) => {
        lookupCount += 1;
        if (lookupCount === 2) {
          lookupStarted.resolve();
          await releaseLookup.promise;
        }
        return getOrCreateDefaultSession(...args);
      },
    },
  );
});

test("a state snapshot retries when Session changes while its events are loading", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-cas-"));
  const eventsLoadStarted = deferred<void>();
  const releaseEventsLoad = deferred<void>();
  let pauseNextEventsLoad = false;
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        const sessionB = await createSession(directory, {
          title: "Session B",
          projectKey: initial.sessions[0]!.projectKey,
          scope: { kind: "track", identity: "track-2", label: "Track B" },
        });

        pauseNextEventsLoad = true;
        const lateStatePromise = fetch(endpoint("/state"));
        await eventsLoadStarted.promise;
        const selected = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({ kind: "select_session", sessionId: sessionB.id }),
        });
        assert.equal((await selected.json() as ChatDialogState).activeSessionId, sessionB.id);

        releaseEventsLoad.resolve();
        const lateState = await (await lateStatePromise).json() as ChatDialogState;
        assert.equal(lateState.activeSessionId, sessionB.id);
      },
    },
  };

  await runAgentFlow(
    context as never,
    {
      presentation: liveContextPresentationFixture("Track A"),
      summary: "Track A",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Track A" },
    },
    {
      renderHtml: () => "<html></html>",
      loadSessionEvents: async (...args) => {
        const events = await loadSessionEvents(...args);
        if (pauseNextEventsLoad) {
          pauseNextEventsLoad = false;
          eventsLoadStarted.resolve();
          await releaseEventsLoad.promise;
        }
        return events;
      },
    },
  );
});

test("a prior-activation Session is restored only to the server-owned current Live object", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-restore-"));
  const previous = await createSession(directory, {
    title: "Previous Bass arrangement",
    projectKey: "previous-activation",
    scope: { kind: "track", identity: "old-drum-handle", label: "Drums" },
  });
  const obsolete = await createSession(directory, {
    title: "Obsolete clip notes",
    projectKey: "previous-activation",
    scope: { kind: "clip", identity: "old-clip-handle", label: "Chorus" },
  });
  const currentTrack = fakeMidiTrack(20n, "Drums");
  let currentProjectKey = "";
  const context = {
    application: {
      song: { handle: { id: 1n }, tracks: [currentTrack], scenes: [] },
    },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        currentProjectKey = initial.sessions[0]!.projectKey;
        assert.deepEqual(initial.sessionContinueTarget, {
          kind: "track",
          label: "Drums",
        });
        assert.deepEqual(
          initial.previousSessions.map((session) => session.id),
          [obsolete.id, previous.id],
        );
        assert.deepEqual(initial.archivedSessions, []);

        const deleted = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({ kind: "delete_session", sessionId: obsolete.id }),
        });
        assert.equal(deleted.status, 200);
        assert.deepEqual(
          (await deleted.json() as ChatDialogState).previousSessions.map(
            (session) => session.id,
          ),
          [previous.id],
        );

        const renamed = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({
            kind: "rename_session",
            sessionId: previous.id,
            title: "Renamed previous Session",
          }),
        });
        assert.equal(renamed.status, 200);
        assert.equal(
          ((await renamed.json() as ChatDialogState).previousSessions[0]?.title),
          "Renamed previous Session",
        );

        const archived = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({ kind: "archive_session", sessionId: previous.id }),
        });
        assert.equal(archived.status, 200);
        const archivedState = await archived.json() as ChatDialogState;
        assert.deepEqual(archivedState.previousSessions, []);
        assert.equal(archivedState.archivedSessions[0]?.id, previous.id);

        const unarchived = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({ kind: "unarchive_session", sessionId: previous.id }),
        });
        assert.equal(unarchived.status, 200);
        const unarchivedState = await unarchived.json() as ChatDialogState;
        assert.equal(unarchivedState.previousSessions[0]?.id, previous.id);
        assert.deepEqual(unarchivedState.archivedSessions, []);

        const rejected = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({
            kind: "restore_session",
            sessionId: previous.id,
            projectKey: "attacker-controlled",
            scope: { kind: "track", identity: "attacker-controlled", label: "Wrong" },
          }),
        });
        assert.equal(rejected.status, 400);

        const response = await fetch(endpoint("/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({
            kind: "restore_session",
            sessionId: previous.id,
          }),
        });
        assert.equal(response.status, 200);
        const restored = await response.json() as ChatDialogState;
        assert.equal(restored.activeSessionId, previous.id);
        assert.deepEqual(restored.previousSessions, []);
        const restoredSession = restored.sessions.find(
          (session) => session.id === previous.id,
        );
        assert.equal(restoredSession?.projectKey, currentProjectKey);
        assert.deepEqual(restoredSession?.scope, {
          kind: "track",
          identity: "20",
          label: "Drums",
        });
        assert.deepEqual(restoredSession?.originScope, previous.scope);
        assert.match(restored.status ?? "", /ready on the current track.*Drums/i);
      },
    },
  };

  await runAgentFlow(
    context as never,
    {
      presentation: liveContextPresentationFixture("Drums"),
      summary: "MIDI track Drums",
      target: { track: currentTrack },
      scope: { kind: "track", identity: "20", label: "Drums" },
    },
    { renderHtml: () => "<html></html>" },
  );

  const persisted = (await listSessions(directory)).find(
    (session) => session.id === previous.id,
  );
  assert.equal(
    (await listSessions(directory)).some((session) => session.id === obsolete.id),
    false,
  );
  assert.equal(persisted?.projectKey, currentProjectKey);
  assert.deepEqual(persisted?.scope, {
    kind: "track",
    identity: "20",
    label: "Drums",
  });
  assert.deepEqual(persisted?.originScope, previous.scope);
});

function fakeMidiTrack(id: bigint, name: string): MidiTrack<"1.0.0"> {
  return Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id } },
    name: { configurable: true, enumerable: true, value: name, writable: true },
    mute: { enumerable: true, value: false }, solo: { enumerable: true, value: false },
    mutedViaSolo: { enumerable: true, value: false }, arm: { enumerable: true, value: false },
    groupTrack: { enumerable: true, value: null },
    arrangementClips: { enumerable: true, value: [] },
    takeLanes: { enumerable: true, value: [] },
    clipSlots: { enumerable: true, value: [] },
    devices: { enumerable: true, value: [] },
  }) as MidiTrack<"1.0.0">;
}

function fakeMidiTrackWithSlots(
  id: bigint,
  name: string,
  slotCount: number,
): { track: MidiTrack<"1.0.0">; slots: ClipSlot<"1.0.0">[] } {
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id } },
    name: { enumerable: true, value: name },
    mute: { enumerable: true, value: false }, solo: { enumerable: true, value: false },
    mutedViaSolo: { enumerable: true, value: false }, arm: { enumerable: true, value: false },
    groupTrack: { enumerable: true, value: null },
    arrangementClips: { enumerable: true, value: [] },
    takeLanes: { enumerable: true, value: [] },
    devices: { enumerable: true, value: [] },
  }) as MidiTrack<"1.0.0">;
  const slots = Array.from({ length: slotCount }, (_, index) =>
    Object.defineProperties(Object.create(ClipSlot.prototype), {
      handle: { enumerable: true, value: { id: id * 100n + BigInt(index) } },
      clip: { enumerable: true, value: null },
      parent: { enumerable: true, value: track },
    }) as ClipSlot<"1.0.0">
  );
  Object.defineProperty(track, "clipSlots", { enumerable: true, value: slots });
  return { track, slots };
}

function profile(
  values: {
    baseUrl: string;
    apiKey: string;
    apiMode?: "responses" | "chat-completions";
    model: string;
    advanced?: DirectApiModelConfig["advanced"];
  },
): SavedProfile {
  return {
    id: "profile-1",
    name: "Provider",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: values.apiMode ?? "responses",
      baseUrl: values.baseUrl,
      apiKey: values.apiKey,
    },
    defaultModel: values.model,
    models: [{
      model: values.model,
      parameters: {
        maxOutputTokens: 1_000,
        reasoning: { mode: "default" },
      },
      advanced: values.advanced ?? {},
    }],
  };
}

function discoveredModel(id: string, maxOutputTokens: number): DiscoveredModelInfo {
  return {
    id,
    displayName: id,
    capabilities: { maxOutputTokens },
  };
}

function assertStateMatches(
  state: ChatDialogState,
  expectedProfile: SavedProfile,
  expectedModels: DiscoveredModelInfo[],
): void {
  assert.deepEqual(state.modelStateSource, modelStateSourceForProfile(expectedProfile));
  assert.deepEqual(
    state.availableModels.map((model) => model.id),
    expectedModels.map((model) => model.id),
  );
  assert.equal(
    state.capabilities.maxOutputTokens,
    expectedModels[0]?.capabilities.maxOutputTokens,
  );
}

function sizedAttachmentPng(byteLength: number): Uint8Array {
  assert.ok(byteLength >= 24);
  const bytes = new Uint8Array(byteLength);
  bytes.set([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 1, 0, 0, 0, 1,
  ]);
  return bytes;
}

function attachmentRequestBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function readSsePayload(
  response: Response,
  type: string,
  matches: (payload: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  let received = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Event stream ended before ${type}.`);
      received += NodeBuffer.from(chunk.value).toString("utf8");
      for (const block of received.split("\n\n")) {
        const data = block.split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (!data) continue;
        const payload = JSON.parse(data) as Record<string, unknown>;
        if (payload.type === type && matches(payload)) return payload;
      }
    }
  } finally {
    await reader.cancel();
  }
}

interface CrossBridgeEndpoint {
  endpoint(pathname: string): string;
}

interface CrossBridgeFixture {
  directory: string;
  sessionId: string;
  first: CrossBridgeEndpoint;
  second: CrossBridgeEndpoint;
  closeSecond(): Promise<void>;
  close(): Promise<void>;
}

async function openCrossBridgeFixture(options: {
  directoryPrefix: string;
  firstDependencies: Parameters<typeof runAgentFlow>[2];
  secondDependencies: Parameters<typeof runAgentFlow>[2];
}): Promise<CrossBridgeFixture> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), options.directoryPrefix));
  await saveSavedProfile(directory, profile({
    baseUrl: "https://provider.test/v1",
    apiKey: "key",
    model: "model-a",
  }));
  const firstDialog = deferred<string>();
  const secondDialog = deferred<string>();
  const closeFirstDialog = deferred<void>();
  const closeSecondDialog = deferred<void>();
  let dialogCount = 0;
  const leadTrack = fakeMidiTrack(1n, "Lead");
  const context = {
    application: {
      song: { handle: { id: 1n }, tracks: [leadTrack], scenes: [] },
    },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const index = dialogCount;
        dialogCount += 1;
        (index === 0 ? firstDialog : secondDialog).resolve(url);
        await (index === 0 ? closeFirstDialog.promise : closeSecondDialog.promise);
      },
    },
  };
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: { track: leadTrack },
    scope: { kind: "track", identity: "1", label: "Lead" },
  };
  const firstFlow = runAgentFlow(context as never, interaction, {
    ...options.firstDependencies,
    renderHtml: () => "<html></html>",
  });
  let secondFlow: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  try {
    const firstUrl = new URL(await resolvesWithin(firstDialog.promise, "first bridge"));
    const firstToken = firstUrl.searchParams.get("token")!;
    const firstState = await (await fetch(
      `${firstUrl.origin}/state?token=${firstToken}`,
    )).json() as ChatDialogState;
    await updateSession(directory, firstState.activeSessionId, { title: "Shared test Session" });
    secondFlow = runAgentFlow(context as never, interaction, {
      ...options.secondDependencies,
      renderHtml: () => "<html></html>",
    });
    const secondUrl = new URL(await resolvesWithin(secondDialog.promise, "second bridge"));
    const secondToken = secondUrl.searchParams.get("token")!;
    let secondState = await (await fetch(
      `${secondUrl.origin}/state?token=${secondToken}`,
    )).json() as ChatDialogState;
    assert.equal(secondState.activeSessionId, firstState.activeSessionId);
    await updateSession(directory, firstState.activeSessionId, { title: "" });
    secondState = await (await fetch(
      `${secondUrl.origin}/state?token=${secondToken}`,
    )).json() as ChatDialogState;
    const endpoint = (url: URL, token: string): CrossBridgeEndpoint => ({
      endpoint: (pathname) => `${url.origin}${pathname}?token=${token}`,
    });
    return {
      directory,
      sessionId: firstState.activeSessionId,
      first: endpoint(firstUrl, firstToken),
      second: endpoint(secondUrl, secondToken),
      closeSecond: () => {
        closeSecondDialog.resolve();
        return secondFlow!;
      },
      close: () => {
        if (closePromise) return closePromise;
        closeFirstDialog.resolve();
        closeSecondDialog.resolve();
        closePromise = Promise.allSettled([firstFlow, secondFlow!]).then(() => undefined);
        return closePromise;
      },
    };
  } catch (error) {
    closeFirstDialog.resolve();
    closeSecondDialog.resolve();
    await Promise.allSettled([
      firstFlow,
      ...(secondFlow ? [secondFlow] : []),
    ]);
    throw error;
  }
}

async function runIsolatedProcess(
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    environment?: Record<string, string>;
  },
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const { NODE_TEST_CONTEXT: _testContext, ...childEnvironment } = env;
    const child = spawn(execPath, args, {
      cwd: options.cwd,
      env: { ...childEnvironment, ...options.environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function waitForSessionActivity(
  bridge: CrossBridgeEndpoint,
  sessionId: string,
): Promise<void> {
  for (;;) {
    const response = await fetch(bridge.endpoint("/state"));
    const state = await response.json() as ChatDialogState;
    if (state.sessionActivities?.some((activity) =>
      activity.sessionId === sessionId && activity.status === "running"
    )) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function withoutBridgeStateRevision(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  assert.match(String(payload.bridgeStateRevision), /^[1-9][0-9]*$/);
  const { bridgeStateRevision: _revision, ...rest } = payload;
  return rest;
}

async function resolvesWithin<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 2_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
