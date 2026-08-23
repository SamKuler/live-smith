import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  ModelBackendShutdownError,
  type CodexSubscriptionBackend,
  type ManagedAuthState,
  type TransportRequest,
} from "./provider.js";
import type { DraftProfile, SavedProfile } from "./profile.js";
import {
  ModelBackendManager,
  createDirectApiBackend,
} from "./backend-registry.js";
import { createHostAbortController } from "../runtime/host.js";
import { spawnCodexAppServer } from "../runtime/process-host.js";

function directProfile(
  apiFamily: "openai" | "anthropic" = "openai",
  apiMode: "responses" | "chat-completions" | "messages" = "responses",
): SavedProfile {
  const connection = apiFamily === "anthropic"
    ? (() => {
        assert.equal(apiMode, "messages");
        return {
          kind: "direct-api" as const,
          apiFamily: "anthropic" as const,
          apiMode: "messages" as const,
          baseUrl: "https://example.test/v1",
          apiKey: "test-key",
        };
      })()
    : (() => {
        assert.notEqual(apiMode, "messages");
        return {
          kind: "direct-api" as const,
          apiFamily: "openai" as const,
          apiMode: apiMode as "responses" | "chat-completions",
          baseUrl: "https://example.test/v1",
          apiKey: "test-key",
        };
      })();
  return {
    id: `direct-${apiFamily}-${apiMode}`,
    name: "Direct",
    connection,
    model: "model-a",
    parameters: { reasoning: { mode: "default" } },
    advanced: {},
  };
}

function subscriptionProfile(id = "subscription"): SavedProfile {
  return {
    id,
    name: "Subscription",
    connection: { kind: "codex-subscription", provider: "openai" },
    model: "gpt-5.6-sol",
    parameters: { reasoning: { mode: "default" } },
    advanced: {},
  };
}

function fakeManagedBackend(): CodexSubscriptionBackend & {
  closeCalls: number;
  emitTerminal(error?: Error): void;
  replayTerminal(error?: Error): void;
} {
  const terminalListeners = new Set<(error: Error) => void>();
  const observedTerminalListeners: Array<(error: Error) => void> = [];
  let terminalError: Error | undefined;
  return {
    kind: "codex-subscription",
    closeCalls: 0,
    async listModels(_profile: DraftProfile) {
      return [];
    },
    async createToolTurn(_request: TransportRequest) {
      return { content: "ok", toolCalls: [] };
    },
    async readAuthState(): Promise<ManagedAuthState> {
      return { status: "signed-out" };
    },
    async beginLogin(): Promise<ManagedAuthState> {
      return { status: "signed-out" };
    },
    async logout(): Promise<ManagedAuthState> {
      return { status: "signed-out" };
    },
    reserveToolTurn() {
      return {
        createToolTurn: (request) => this.createToolTurn(request),
        async release() {},
      };
    },
    onTerminal(listener) {
      if (terminalError) listener(terminalError);
      else {
        terminalListeners.add(listener);
        observedTerminalListeners.push(listener);
      }
      return () => terminalListeners.delete(listener);
    },
    emitTerminal(error = new Error("managed backend terminated")) {
      terminalError = error;
      for (const listener of [...terminalListeners]) listener(error);
    },
    replayTerminal(error = new Error("delayed terminal callback")) {
      for (const listener of observedTerminalListeners) listener(error);
    },
    async close() {
      this.closeCalls += 1;
    },
  };
}

test("createDirectApiBackend keeps all three direct wire protocols explicit", async () => {
  for (const [family, mode] of [
    ["openai", "responses"],
    ["openai", "chat-completions"],
    ["anthropic", "messages"],
  ] as const) {
    const backend = await createDirectApiBackend(directProfile(family, mode), {
      fetchImpl: async () => new Response("not used"),
    });
    assert.equal(backend.kind, "direct-api");
    assert.equal("apiFamily" in backend, true);
    assert.equal((backend as unknown as { apiFamily: string }).apiFamily, family);
    assert.equal((backend as unknown as { apiMode: string }).apiMode, mode);
    await backend.close();
  }
});

test("ModelBackendManager shares one managed process across subscription Profiles", async () => {
  const managed = fakeManagedBackend();
  let starts = 0;
  const manager = new ModelBackendManager("/private/live-smith", {
    startCodexBackend: async (storageDirectory) => {
      starts += 1;
      assert.equal(storageDirectory, "/private/live-smith");
      return managed;
    },
  });

  const first = await manager.forProfile(subscriptionProfile("a"));
  const second = await manager.forProfile(subscriptionProfile("b"));
  assert.equal(first, managed);
  assert.equal(second, managed);
  assert.equal(starts, 1);

  await manager.close();
  await manager.close();
  assert.equal(managed.closeCalls, 1);
});

test("ModelBackendManager invalidation closes and replaces the managed process", async () => {
  const backends = [fakeManagedBackend(), fakeManagedBackend()];
  let starts = 0;
  const manager = new ModelBackendManager("/private/live-smith", {
    startCodexBackend: async () => backends[starts++]!,
  });

  assert.equal(await manager.codex(), backends[0]);
  await manager.invalidateCodex();
  assert.equal(backends[0]?.closeCalls, 1);
  assert.equal(await manager.codex(), backends[1]);
  assert.equal(starts, 2);

  await manager.close();
  assert.equal(backends[1]?.closeCalls, 1);
});

test("canceling one managed startup waiter does not abort its peer", async () => {
  const managed = fakeManagedBackend();
  const waiterController = createHostAbortController();
  const waiterReason = new Error("state request closed");
  let startupSignal: AbortSignal | undefined;
  let startupAbortCount = 0;
  let markStarted!: () => void;
  let finishStartup!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const startupGate = new Promise<void>((resolve) => {
    finishStartup = resolve;
  });
  const manager = new ModelBackendManager("/private/live-smith", {
    startCodexBackend: async (_storageDirectory, signal) => {
      startupSignal = signal;
      signal.addEventListener("abort", () => {
        startupAbortCount += 1;
      });
      markStarted();
      await startupGate;
      return managed;
    },
  });
  const canceledWaiter = manager.codex(waiterController.signal);
  const peerWaiter = manager.codex();

  await started;
  waiterController.abort(waiterReason);
  await assert.rejects(canceledWaiter, (error: unknown) => error === waiterReason);
  assert.equal(startupSignal?.aborted, false);
  assert.equal(startupAbortCount, 0);

  finishStartup();
  assert.equal(await peerWaiter, managed);
  await manager.close();
  assert.equal(startupAbortCount, 1);
  assert.equal(managed.closeCalls, 1);
});

test("closing the final manager owner aborts one pending startup and waits for it", async () => {
  let startupAbortCount = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const manager = new ModelBackendManager("/private/live-smith", {
    startCodexBackend: async (_storageDirectory, signal) => {
      markStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          startupAbortCount += 1;
          reject(signal.reason);
        }, { once: true });
      });
      return fakeManagedBackend();
    },
  });
  const pending = manager.codex();

  await started;
  await manager.close();
  await assert.rejects(pending, /backend startup was canceled/);
  await manager.close();
  assert.equal(startupAbortCount, 1);
});

test("final owner close cancels delayed pre-spawn work without a late child launch", {
  timeout: 2_000,
}, async (t) => {
  const storageDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-manager-pre-spawn-"),
  );
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  let markResolutionStarted!: () => void;
  const resolutionStarted = new Promise<void>((resolve) => {
    markResolutionStarted = resolve;
  });
  let finishResolution!: (executable: string) => void;
  const resolutionGate = new Promise<string>((resolve) => {
    finishResolution = resolve;
  });
  let spawnCalls = 0;
  const manager = new ModelBackendManager(storageDirectory, {
    startCodexBackend: async (directory, signal) => {
      await spawnCodexAppServer(
        directory,
        (() => {
          spawnCalls += 1;
          throw new Error("a canceled startup launched a late child");
        }) as unknown as typeof spawn,
        async () => {
          markResolutionStarted();
          return resolutionGate;
        },
        signal,
      );
      throw new Error("the canceled startup unexpectedly completed");
    },
  });
  const startup = manager.codex();
  const observedStartup = startup.then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );

  await resolutionStarted;
  const closing = manager.close();
  const observedClose = closing.then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  const closeOutcome = await Promise.race([
    observedClose,
    new Promise<{ status: "pending" }>((resolve) => {
      setTimeout(() => resolve({ status: "pending" }), 50);
    }),
  ]);
  finishResolution("/live-smith/test-native-codex");

  assert.deepEqual(closeOutcome, { status: "fulfilled" });
  const startupOutcome = await observedStartup;
  assert.equal(startupOutcome.status, "rejected");
  assert.match(
    String(startupOutcome.status === "rejected" ? startupOutcome.error : ""),
    /backend startup was canceled/i,
  );
  await observedClose;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(spawnCalls, 0);
});

test("ModelBackendManager waits for terminal backend shutdown before replacement", async () => {
  let releaseClose!: () => void;
  let closeStarted!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const closeStartedPromise = new Promise<void>((resolve) => {
    closeStarted = resolve;
  });
  const first = fakeManagedBackend();
  first.close = async function close() {
    this.closeCalls += 1;
    closeStarted();
    await closeGate;
  };
  const second = fakeManagedBackend();
  const backends = [first, second];
  let starts = 0;
  const manager = new ModelBackendManager("/private/live-smith", {
    startCodexBackend: async () => backends[starts++]!,
  });

  assert.equal(await manager.codex(), first);
  first.emitTerminal();
  assert.equal(
    await Promise.race([
      closeStartedPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]),
    true,
    "terminal notification must start closing its exact backend",
  );
  const replacement = manager.codex();
  await Promise.resolve();
  assert.equal(starts, 1);

  releaseClose();
  assert.equal(await replacement, second);
  assert.equal(starts, 2);
  assert.equal(first.closeCalls, 1);

  first.replayTerminal(new Error("late duplicate terminal event"));
  await Promise.resolve();
  assert.equal(second.closeCalls, 0);
  await manager.close();
});

test("a stale backend cannot conditionally retire its replacement", async () => {
  const first = fakeManagedBackend();
  const second = fakeManagedBackend();
  const backends = [first, second];
  let starts = 0;
  const manager = new ModelBackendManager("/private/live-smith", {
    startCodexBackend: async () => backends[starts++]!,
  });

  const firstLease = await manager.codexLease();
  assert.equal(firstLease.backend, first);
  assert.equal(await firstLease.retire(), true);
  const secondLease = await manager.codexLease();
  assert.equal(secondLease.backend, second);
  assert.equal(await firstLease.retire(), false);
  assert.equal(second.closeCalls, 0);
  await manager.close();
});

test("repeated retirement of the same slot waits for shutdown confirmation", async () => {
  let closeStarted!: () => void;
  let releaseClose!: () => void;
  const closeStartedPromise = new Promise<void>((resolve) => {
    closeStarted = resolve;
  });
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const backend = fakeManagedBackend();
  backend.close = async function close() {
    this.closeCalls += 1;
    closeStarted();
    await closeGate;
  };
  const manager = new ModelBackendManager("/private/live-smith", {
    startCodexBackend: async () => backend,
  });
  const lease = await manager.codexLease();

  const firstRetirement = lease.retire();
  await closeStartedPromise;
  let repeatedSettled = false;
  const repeatedRetirement = lease.retire().then((result) => {
    repeatedSettled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(repeatedSettled, false);

  releaseClose();
  assert.equal(await firstRetirement, true);
  assert.equal(await repeatedRetirement, false);
  assert.equal(backend.closeCalls, 1);
  await manager.close();
});

test("an unconfirmed backend shutdown poisons the manager", async () => {
  const first = fakeManagedBackend();
  first.close = async function close() {
    this.closeCalls += 1;
    throw new Error("Codex App Server process could not be stopped.");
  };
  let starts = 0;
  const manager = new ModelBackendManager("/private/live-smith", {
    startCodexBackend: async () => {
      starts += 1;
      return first;
    },
  });

  assert.equal(await manager.codex(), first);
  first.emitTerminal();
  await assert.rejects(
    manager.codex(),
    /could not be stopped/i,
  );
  await assert.rejects(
    manager.codex(),
    /could not be stopped/i,
  );
  assert.equal(starts, 1);
  assert.equal(first.closeCalls, 1);
});

test("terminal shutdown poison is published to the storage-wide owner once", {
  timeout: 1_000,
}, async () => {
  const shutdownError = new ModelBackendShutdownError(
    "Codex App Server resources could not be stopped.",
  );
  const backend = fakeManagedBackend();
  backend.close = async function close() {
    this.closeCalls += 1;
    throw shutdownError;
  };
  const published: Error[] = [];
  let publishPoison!: () => void;
  const poisonPublished = new Promise<void>((resolve) => {
    publishPoison = resolve;
  });
  const manager = new ModelBackendManager("/private/live-smith", {
    startCodexBackend: async () => backend,
    onPoison(error) {
      published.push(error);
      publishPoison();
    },
  });

  await manager.codex();
  backend.emitTerminal();
  await poisonPublished;
  backend.replayTerminal();
  await Promise.resolve();

  assert.deepEqual(published, [shutdownError]);
  await assert.rejects(manager.codex(), (error: unknown) => error === shutdownError);
  assert.equal(backend.closeCalls, 1);
});

test("an unconfirmed shutdown during startup also poisons the manager", async () => {
  const reason = new ModelBackendShutdownError(
    "Codex App Server process could not be stopped.",
  );
  let starts = 0;
  const manager = new ModelBackendManager("/private/live-smith", {
    startCodexBackend: async () => {
      starts += 1;
      throw reason;
    },
  });

  await assert.rejects(manager.codex(), (error: unknown) => error === reason);
  await assert.rejects(manager.codex(), (error: unknown) => error === reason);
  assert.equal(starts, 1);
});

test("subscription backend requires durable private storage", async () => {
  const manager = new ModelBackendManager(undefined, {
    startCodexBackend: async () => fakeManagedBackend(),
  });
  await assert.rejects(
    manager.forProfile(subscriptionProfile()),
    /requires the Ableton storage directory/i,
  );
});
