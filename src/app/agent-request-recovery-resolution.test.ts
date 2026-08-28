import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  AgentRecoveryResolutionReportingError,
  digestActionIdentity,
} from "../agent/loop.js";
import type { DirectApiProfile } from "../model/profile.js";
import {
  appendSessionEvent,
  loadSessionEvents,
  type SessionEventInput,
} from "../storage/events.js";
import { StorageCommitOutcomeUnknownError } from "../storage/persistence.js";
import { createSession } from "../storage/sessions.js";
import { handleAgentRequest } from "./agent-request.js";
import { runtimeProfileForSavedProfile } from "./model-request.js";
import { activeRecoveryLedgerFromEvents } from "./session-context.js";

function recoveryProfile(): DirectApiProfile {
  return {
    id: "recovery-profile",
    name: "Recovery Provider",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      apiKey: "secret",
      baseUrl: "https://example.test/v1",
    },
    defaultModel: "model-a",
    models: [{
      model: "model-a",
      parameters: {
        maxOutputTokens: 1_024,
        reasoning: { mode: "default" },
      },
      advanced: {},
    }],
  };
}

async function recoveryRequestHarness() {
  const directory = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "live-smith-recovery-resolution-",
  ));
  const session = await createSession(directory, {
    title: "Unfinished recovery",
    projectKey: "project-a",
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  });
  await appendSessionEvent(directory, session.id, {
    kind: "apply_result",
    content: "Earlier Live work remains unfinished.",
    recovery: {
      active: true,
      completedActionDigests: [digestActionIdentity("completed-earlier")],
    },
  });
  let modelCalls = 0;
  let invalidations = 0;
  const callbacks = {
    signal: new AbortController().signal,
    onDelta: () => {},
    onProgress: () => {},
    onSessionEvent: (_event: unknown) => {},
    onSessionStateInvalidated: () => { invalidations += 1; },
    confirmActions: async () => {
      throw new Error("Recovery resolution must not use Apply approval.");
    },
    confirmRecoveryResolution: async () => true,
  };
  const requestTurn = async () => ++modelCalls === 1
    ? {
        content: "Inspecting the current Set.",
        toolCalls: [{ id: "inspect", name: "inspect_live_set", arguments: "{}" }],
      }
    : {
        content: "Asking the user to close the recovery.",
        toolCalls: [{ id: "resolve", name: "resolve_live_recovery", arguments: "{}" }],
      };
  const run = (
    appendTraceEvent: typeof appendSessionEvent = appendSessionEvent,
  ) => handleAgentRequest(
    {
      environment: { storageDirectory: directory },
      application: {
        song: { tracks: [], returnTracks: [], mainTrack: undefined },
      },
    } as never,
    directory,
    {
      summary: "Live Set",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Lead" },
    },
    "Review the unfinished recovery",
    runtimeProfileForSavedProfile(recoveryProfile()),
    "project-a",
    session.id,
    callbacks,
    requestTurn,
    appendSessionEvent,
    appendTraceEvent,
  );
  return {
    callbacks,
    directory,
    invalidations: () => invalidations,
    run,
    sessionId: session.id,
  };
}

function isInactiveRecovery(input: SessionEventInput): boolean {
  return input.kind === "apply_result" && input.recovery?.active === false;
}

test("unknown inactive-recovery commit invalidates state and preserves authoritative clear", async () => {
  const harness = await recoveryRequestHarness();
  const commitError = new StorageCommitOutcomeUnknownError(
    new Error("Injected directory sync failure"),
  );
  const uncertainAppend: typeof appendSessionEvent = async (
    directory,
    sessionId,
    input,
  ) => {
    const event = await appendSessionEvent(directory, sessionId, input);
    if (isInactiveRecovery(input)) throw commitError;
    return event;
  };

  await assert.rejects(
    harness.run(uncertainAppend),
    (error: unknown) => {
      assert.ok(error instanceof AgentRecoveryResolutionReportingError);
      assert.equal(error.cause, commitError);
      assert.match(error.message, /outcome could not be confirmed/i);
      return true;
    },
  );

  assert.equal(harness.invalidations(), 1);
  const events = await loadSessionEvents(harness.directory, harness.sessionId);
  assert.equal(activeRecoveryLedgerFromEvents(events), undefined);
  assert.equal(
    events.some((event) => event.recovery?.active === false),
    true,
  );
});

test("notification failure after inactive recovery commit invalidates authoritative state", async () => {
  const harness = await recoveryRequestHarness();
  const notificationFailure = new Error("Injected origin notification failure");
  harness.callbacks.onSessionEvent = (event: unknown) => {
    const recovery = (event as { recovery?: { active?: unknown } }).recovery;
    if (recovery?.active === false) throw notificationFailure;
  };

  await assert.rejects(
    harness.run(),
    (error: unknown) => {
      assert.ok(error instanceof AgentRecoveryResolutionReportingError);
      assert.equal(error.cause, notificationFailure);
      return true;
    },
  );

  assert.equal(harness.invalidations(), 1);
  const events = await loadSessionEvents(harness.directory, harness.sessionId);
  assert.equal(activeRecoveryLedgerFromEvents(events), undefined);
});
