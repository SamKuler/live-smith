import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { URL } from "node:url";

import { CodexExecutableUnavailableError } from "../../runtime/codex-executable.js";
import { createHostAbortController } from "../../runtime/host.js";
import { ModelBackendManager } from "../backend-registry.js";
import { MAX_CODEX_RPC_LINE_BYTES } from "./codex-limits.js";
import { CodexRpcClient } from "./codex-rpc.js";

const maximumLineBytes = MAX_CODEX_RPC_LINE_BYTES;

test("start performs the exact initialization handshake and accepts 0.148.x", async (t) => {
  const harness = await startHarness(t, "codex_cli_rs/0.148.27 (macOS 15; arm64)");
  const initialize = harness.outbound[0];
  assert.deepEqual(initialize, {
    id: 1,
    method: "initialize",
    params: {
      clientInfo: {
        name: "live-smith",
        title: "Live Smith",
        version: "0.1.1",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    },
  });
  assert.deepEqual(harness.outbound[1], { method: "initialized" });
  await harness.client.close();
});

test("aborting startup cancels initialize and confirms child shutdown", async (t) => {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-rpc-"));
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const child = new FakeCodexProcess();
  const controller = createHostAbortController();
  const reason = new Error("last managed owner closed");
  let launchArgs: readonly string[] | undefined;
  let markInitializeStarted!: () => void;
  const initializeStarted = new Promise<void>((resolve) => {
    markInitializeStarted = resolve;
  });
  let pendingInput = "";
  child.stdin.on("data", (chunk: Buffer) => {
    pendingInput += chunk.toString("utf8");
    if (pendingInput.includes("\n")) markInitializeStarted();
  });
  const spawnImpl = ((
    _command: string,
    args: readonly string[],
  ) => {
    launchArgs = args;
    return child;
  }) as unknown as typeof spawn;
  const startup = CodexRpcClient.start({
    storageDirectory,
    signal: controller.signal,
    spawnImpl,
    resolveExecutableImpl: resolveTestExecutable,
  });

  await initializeStarted;
  controller.abort(reason);
  await assert.rejects(startup, (error: unknown) => error === reason);
  assert.deepEqual(child.killSignals, []);
  await assertMetadataUnavailable(metadataBaseUrlFromArgs(launchArgs));
});

test("aborting startup during executable resolution prevents a late child launch", async (t) => {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-rpc-"));
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const controller = createHostAbortController();
  const reason = new Error("final managed owner closed");
  let markResolutionStarted!: () => void;
  const resolutionStarted = new Promise<void>((resolve) => {
    markResolutionStarted = resolve;
  });
  let finishResolution!: (executable: string) => void;
  const resolutionGate = new Promise<string>((resolve) => {
    finishResolution = resolve;
  });
  let spawnCalls = 0;
  const startup = CodexRpcClient.start({
    storageDirectory,
    signal: controller.signal,
    resolveExecutableImpl: async () => {
      markResolutionStarted();
      return resolutionGate;
    },
    spawnImpl: (() => {
      spawnCalls += 1;
      return new FakeCodexProcess();
    }) as unknown as typeof spawn,
  });
  const observedStartup = startup.then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );

  await resolutionStarted;
  controller.abort(reason);
  let outcome: Awaited<typeof observedStartup> | { status: "pending" };
  try {
    outcome = await Promise.race([
      observedStartup,
      new Promise<{ status: "pending" }>((resolve) => {
        setTimeout(() => resolve({ status: "pending" }), 50);
      }),
    ]);
  } finally {
    finishResolution("/live-smith/test-native-codex");
  }

  assert.deepEqual(outcome, { status: "rejected", error: reason });
  assert.equal(spawnCalls, 0);
  await observedStartup;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(spawnCalls, 0);
});

test("final owner close cancels post-initialize home verification and closes resources", {
  timeout: 2_000,
}, async (t) => {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-rpc-"));
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const codexHome = path.join(storageDirectory, "codex-subscription");
  const child = new FakeCodexProcess();
  let launchArgs: readonly string[] | undefined;
  let pendingInput = "";
  child.stdin.on("data", (chunk: Buffer) => {
    pendingInput += chunk.toString("utf8");
    for (;;) {
      const newline = pendingInput.indexOf("\n");
      if (newline < 0) return;
      const message = JSON.parse(pendingInput.slice(0, newline)) as RpcMessage;
      pendingInput = pendingInput.slice(newline + 1);
      if (message.method === "initialize") {
        if (typeof message.id !== "number") {
          throw new TypeError("Initialize request is missing its numeric id.");
        }
        child.send({
          id: message.id,
          result: {
            userAgent: "codex_cli_rs/0.148.0",
            codexHome,
          },
        });
      }
    }
  });
  const spawnImpl = ((
    _command: string,
    args: readonly string[],
  ) => {
    launchArgs = args;
    return child;
  }) as unknown as typeof spawn;
  let markRealpathStarted!: () => void;
  const realpathStarted = new Promise<void>((resolve) => {
    markRealpathStarted = resolve;
  });
  let finishRealpath!: () => void;
  const realpathGate = new Promise<void>((resolve) => {
    finishRealpath = resolve;
  });
  let realpathCalls = 0;
  const manager = new ModelBackendManager(storageDirectory, {
    startCodexBackend: async (directory, signal) => {
      let client: CodexRpcClient | undefined;
      try {
        client = await CodexRpcClient.start({
          storageDirectory: directory,
          signal,
          spawnImpl,
          resolveExecutableImpl: resolveTestExecutable,
          realpathImpl: async () => {
            realpathCalls += 1;
            markRealpathStarted();
            await realpathGate;
            return codexHome;
          },
        });
        throw new Error("the canceled startup unexpectedly completed");
      } finally {
        await client?.close();
      }
    },
  });
  const startup = manager.codex();
  const observedStartup = startup.then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );

  await realpathStarted;
  const closing = manager.close();
  const observedClose = closing.then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  let closeOutcome: Awaited<typeof observedClose> | { status: "pending" };
  try {
    closeOutcome = await Promise.race([
      observedClose,
      new Promise<{ status: "pending" }>((resolve) => {
        setTimeout(() => resolve({ status: "pending" }), 50);
      }),
    ]);
  } finally {
    finishRealpath();
  }
  const [eventualClose, startupOutcome] = await Promise.all([
    observedClose,
    observedStartup,
  ]);

  assert.deepEqual(closeOutcome, { status: "fulfilled" });
  assert.deepEqual(eventualClose, { status: "fulfilled" });
  assert.equal(startupOutcome.status, "rejected");
  assert.match(
    String(startupOutcome.status === "rejected" ? startupOutcome.error : ""),
    /backend startup was canceled/i,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(realpathCalls, 1);
  await assertMetadataUnavailable(metadataBaseUrlFromArgs(launchArgs));
});

test("version parsing accepts the official Codex Desktop user agent", async (t) => {
  const harness = await startHarness(
    t,
    "Codex Desktop/0.148.0 (Mac OS 15.6.1; arm64)",
  );
  await harness.client.close();
});

test("actual missing executable error followed by close stays safe and needs no kill", {
  timeout: 2_000,
}, async (t) => {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-rpc-"));
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const missingExecutable = path.join(storageDirectory, "missing-codex-executable");
  const lifecycleEvents: string[] = [];
  const killSignals: Array<NodeJS.Signals | number | undefined> = [];
  let launchArgs: readonly string[] | undefined;
  const spawnImpl = ((
    _command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => {
    launchArgs = args;
    const child = spawn(missingExecutable, args, options);
    const kill = child.kill.bind(child);
    child.kill = (signal?: NodeJS.Signals | number): boolean => {
      killSignals.push(signal);
      return kill(signal);
    };
    child.once("error", () => lifecycleEvents.push("error"));
    child.once("exit", () => lifecycleEvents.push("exit"));
    child.once("close", () => lifecycleEvents.push("close"));
    return child;
  }) as unknown as typeof spawn;

  await assert.rejects(
    CodexRpcClient.start({
      storageDirectory,
      spawnImpl,
      resolveExecutableImpl: resolveTestExecutable,
    }),
    (error: unknown) => {
      assert.equal(
        error instanceof Error && error.message,
        "Codex executable unavailable.",
      );
      assert.equal(String(error).includes(missingExecutable), false);
      return true;
    },
  );
  assert.deepEqual(lifecycleEvents, ["error", "close"]);
  assert.deepEqual(killSignals, []);
  await assertMetadataUnavailable(metadataBaseUrlFromArgs(launchArgs));
});

test("resolver failure preserves the safe executable-unavailable result", async (t) => {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-rpc-"));
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));

  await assert.rejects(
    CodexRpcClient.start({
      storageDirectory,
      resolveExecutableImpl: async () => {
        throw new CodexExecutableUnavailableError();
      },
    }),
    (error: unknown) => {
      assert.equal(error instanceof CodexExecutableUnavailableError, true);
      assert.equal(
        error instanceof Error && error.message,
        "Codex executable unavailable.",
      );
      assert.equal(String(error).includes(storageDirectory), false);
      return true;
    },
  );
});

test("start rejects an App Server outside the isolated Codex home", async (t) => {
  await assert.rejects(
    startHarness(
      t,
      "codex_cli_rs/0.148.0",
      new FakeCodexProcess(),
      "/private/unexpected-codex-home",
    ),
    /isolated credential directory/,
  );
});

test("start rejects malformed and out-of-range Codex versions before exposure", async (t) => {
  for (const userAgent of [
    "codex_cli_rs/0.147.9",
    "codex_cli_rs/0.149.0",
    "codex_cli_rs/1.148.0",
    "not-a-version",
  ]) {
    const launchCapture: LaunchCapture = {};
    await assert.rejects(
      startHarness(t, userAgent, new FakeCodexProcess(), undefined, launchCapture),
      /Live Smith requires Codex CLI version 0\.148\.x/,
    );
    await assertMetadataUnavailable(
      metadataBaseUrlFromArgs(launchCapture.args),
    );
  }
});

test("RPC close confirms metadata firewall shutdown after explicit and terminal close", async (t) => {
  const explicit = await startHarness(t);
  await explicit.client.close();
  await assertMetadataUnavailable(explicit.metadataBaseUrl);

  const terminal = await startHarness(t);
  terminal.child.stdout.end();
  await terminal.client.close();
  await assertMetadataUnavailable(terminal.metadataBaseUrl);
});

test("RPC framing handles split lines, multiple lines, and notification unsubscribe", async (t) => {
  const harness = await startHarness(t);
  const notifications: unknown[] = [];
  const unsubscribe = harness.client.onNotification("turn/started", (params) => {
    notifications.push(params);
  });

  const first = harness.client.request<{ value: number }>("first", {});
  const second = harness.client.request<{ value: number }>("second", {});
  const firstId = harness.request("first").id;
  const secondId = harness.request("second").id;
  const payload = [
    JSON.stringify({ method: "turn/started", params: { turn: "one" } }),
    JSON.stringify({ id: firstId, result: { value: 1 } }),
    JSON.stringify({ id: secondId, result: { value: 2 } }),
    "",
  ].join("\n");
  const split = Math.floor(payload.length / 2);
  harness.child.stdout.write(payload.slice(0, split));
  harness.child.stdout.write(payload.slice(split));

  assert.deepEqual(await first, { value: 1 });
  assert.deepEqual(await second, { value: 2 });
  assert.deepEqual(notifications, [{ turn: "one" }]);

  unsubscribe();
  harness.child.send({ method: "turn/started", params: { turn: "two" } });
  assert.deepEqual(notifications, [{ turn: "one" }]);
  await harness.client.close();
});

test("RPC accepts attachment-sized echoes and rejects a line beyond its derived bound", async (t) => {
  const attachmentHarness = await startHarness(t);
  const attachmentEcho = attachmentHarness.client.request<string>("attachment", {});
  const attachmentId = attachmentHarness.request("attachment").id;
  const attachmentLine = responseLineAtSize(attachmentId, 7 * 1024 * 1024);
  attachmentHarness.child.stdout.write(`${attachmentLine}\n`);
  assert.equal((await attachmentEcho).length > 4 * 1024 * 1024, true);
  await attachmentHarness.client.close();

  const oversizedHarness = await startHarness(t);
  const oversized = oversizedHarness.client.request("oversized", {});
  const oneMiB = Buffer.alloc(1024 * 1024, 0x78);
  for (let offset = 0; offset <= maximumLineBytes; offset += oneMiB.length) {
    oversizedHarness.child.stdout.write(oneMiB);
  }
  await assert.rejects(oversized, /invalid protocol data/);
  await oversizedHarness.client.close();
});

test("non-JSON, unknown response IDs, and server requests fail closed", async (t) => {
  for (const invalid of [
    "credential sk-secret-value\n",
    `${JSON.stringify({ id: 999, result: {} })}\n`,
    `${JSON.stringify({ id: 41, method: "item/tool/call", params: {} })}\n`,
  ]) {
    const harness = await startHarness(t);
    const pending = harness.client.request("pending", {});
    harness.child.stdout.write(invalid);
    await assert.rejects(pending, (error: unknown) => {
      assert.equal(
        error instanceof Error && error.message,
        "Codex App Server returned invalid protocol data.",
      );
      assert.equal(String(error).includes("sk-secret-value"), false);
      return true;
    });
    await harness.client.close();
  }
});

test("server errors are redacted and affect only their matching request", async (t) => {
  const harness = await startHarness(t);
  const failed = harness.client.request("failed", {});
  const healthy = harness.client.request<{ ok: boolean }>("healthy", {});
  harness.child.send({
    id: harness.request("failed").id,
    error: { code: -32_000, message: "secret sk-proj-example request body" },
  });
  harness.child.send({
    id: harness.request("healthy").id,
    result: { ok: true },
  });

  await assert.rejects(failed, (error: unknown) => {
    assert.equal(
      error instanceof Error && error.message,
      "Codex App Server request failed.",
    );
    assert.equal(String(error).includes("sk-proj-example"), false);
    return true;
  });
  assert.deepEqual(await healthy, { ok: true });
  await harness.client.close();
});

test("request timeout and abort remove bounded pending state", async (t) => {
  const harness = await startHarness(t);
  await assert.rejects(
    harness.client.request("invalid-timeout", {}, { timeoutMs: 0 }),
    /timeout must be positive/,
  );
  await assert.rejects(
    harness.client.request("slow", {}, { timeoutMs: 5 }),
    /Codex App Server request timed out/,
  );
  harness.child.send({ id: harness.request("slow").id, result: {} });

  const controller = new AbortController();
  const reason = new Error("caller stopped");
  const aborted = harness.client.request("abort", {}, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(aborted, (error: unknown) => error === reason);
  harness.child.send({ id: harness.request("abort").id, result: {} });
  await harness.client.close();
});

test("stdout EOF and process exit reject pending work without stderr disclosure", async (t) => {
  for (const terminate of [
    (child: FakeCodexProcess) => child.stdout.end(),
    (child: FakeCodexProcess) => {
      child.stderr.write("credential sk-secret-stderr");
      child.exit(17, null);
    },
  ]) {
    const harness = await startHarness(t);
    const pending = harness.client.request("pending", {});
    terminate(harness.child);
    await assert.rejects(pending, (error: unknown) => {
      assert.equal(String(error).includes("sk-secret-stderr"), false);
      assert.match(String(error), /Codex App Server connection closed/);
      return true;
    });
    await harness.client.close();
  }
});

test("connection failure listeners observe EOF even with no pending RPC", async (t) => {
  const harness = await startHarness(t);
  const failed = new Promise<Error>((resolve) => {
    harness.client.onConnectionFailure(resolve);
  });

  harness.child.stdout.end();

  assert.equal((await failed).message, "Codex App Server connection closed.");
  await harness.client.close();
});

test("stdout EOF automatically escalates owned-process teardown", {
  timeout: 2_000,
}, async (t) => {
  const child = new FakeCodexProcess({
    exitOnStdinFinish: false,
    ignoreSigterm: true,
  });
  const harness = await startHarness(t, "codex_cli_rs/0.148.0", child);

  child.stdout.end();

  await waitFor(() => child.killSignals.includes("SIGKILL"));
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  await harness.client.close();
});

test("stdout errors automatically escalate owned-process teardown", {
  timeout: 2_000,
}, async (t) => {
  const child = new FakeCodexProcess({
    exitOnStdinFinish: false,
    ignoreSigterm: true,
  });
  const harness = await startHarness(t, "codex_cli_rs/0.148.0", child);

  child.stdout.emit("error", new Error("untrusted stdout failure"));

  await waitFor(() => child.killSignals.includes("SIGKILL"));
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  await harness.client.close();
});

test("an observed child exit needs no redundant process signal", async (t) => {
  const child = new FakeCodexProcess({ exitOnStdinFinish: false });
  const harness = await startHarness(t, "codex_cli_rs/0.148.0", child);
  const pending = harness.client.request("pending", {});

  child.exit(17, null);

  await assert.rejects(pending, /connection closed/i);
  await harness.client.close();
  assert.deepEqual(child.killSignals, []);
});

test("an observed child close remains a runtime failure without redundant signals", {
  timeout: 2_000,
}, async (t) => {
  const child = new FakeCodexProcess({ exitOnStdinFinish: false });
  const harness = await startHarness(t, "codex_cli_rs/0.148.0", child);
  const pending = harness.client.request("pending", {}, { timeoutMs: 100 });

  child.close(17, null);

  try {
    await assert.rejects(pending, /connection closed/i);
  } finally {
    await harness.client.close();
  }
  assert.deepEqual(child.killSignals, []);
});

test("protocol failure automatically escalates beyond an ignored SIGTERM", {
  timeout: 2_000,
}, async (t) => {
  const child = new FakeCodexProcess({
    exitOnStdinFinish: false,
    ignoreSigterm: true,
  });
  const harness = await startHarness(t, "codex_cli_rs/0.148.0", child);
  const pending = harness.client.request("pending", {});

  child.stdout.write("not-json\n");

  await assert.rejects(pending, /invalid protocol data/i);
  await waitFor(() => child.killSignals.includes("SIGKILL"));
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  await harness.client.close();
});

test("asynchronous stdin errors fail closed without leaking raw EPIPE details", async (t) => {
  const harness = await startHarness(t);
  const pending = harness.client.request("pending", {});

  harness.child.stdin.emit(
    "error",
    new Error("EPIPE credential sk-secret-stdin"),
  );

  await assert.rejects(pending, (error: unknown) => {
    assert.equal(
      error instanceof Error && error.message,
      "Codex App Server connection closed.",
    );
    assert.equal(String(error).includes("sk-secret-stdin"), false);
    return true;
  });
  await harness.client.close();
});

test("close is idempotent, ends stdin, and rejects pending requests", async (t) => {
  const harness = await startHarness(t);
  const pending = harness.client.request("pending", {});
  const rejected = assert.rejects(pending, /Codex App Server client is closed/);
  await Promise.all([harness.client.close(), harness.client.close()]);
  await rejected;
  assert.equal(harness.child.stdin.writableEnded, true);
});

test("close escalates to SIGKILL when the child ignores stdin and SIGTERM", async (t) => {
  const child = new FakeCodexProcess({
    exitOnStdinFinish: false,
    ignoreSigterm: true,
  });
  const harness = await startHarness(
    t,
    "codex_cli_rs/0.148.0",
    child,
  );

  await harness.client.close();

  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
});

test("close rejects when SIGKILL is not followed by an observed exit", {
  timeout: 2_000,
}, async (t) => {
  const child = new FakeCodexProcess({
    exitOnStdinFinish: false,
    ignoreSigterm: true,
    ignoreSigkill: true,
  });
  const harness = await startHarness(t, "codex_cli_rs/0.148.0", child);

  await assert.rejects(
    harness.client.close(),
    /could not be stopped/i,
  );
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  await assertMetadataUnavailable(harness.metadataBaseUrl);
});

interface Harness {
  child: FakeCodexProcess;
  client: CodexRpcClient;
  metadataBaseUrl: string;
  outbound: RpcMessage[];
  request(method: string): RpcMessage & { id: number };
}

interface LaunchCapture {
  args?: readonly string[];
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

async function startHarness(
  t: TestContext,
  userAgent = "codex_cli_rs/0.148.0",
  child = new FakeCodexProcess(),
  reportedCodexHome?: string,
  launchCapture: LaunchCapture = {},
): Promise<Harness> {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-rpc-"));
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const outbound: RpcMessage[] = [];
  let pendingInput = "";
  child.stdin.on("data", (chunk: Buffer) => {
    pendingInput += chunk.toString("utf8");
    for (;;) {
      const newline = pendingInput.indexOf("\n");
      if (newline < 0) break;
      const line = pendingInput.slice(0, newline);
      pendingInput = pendingInput.slice(newline + 1);
      const message = JSON.parse(line) as RpcMessage;
      outbound.push(message);
      if (message.method === "initialize") {
        if (typeof message.id !== "number") {
          throw new TypeError("Initialize request is missing its numeric id.");
        }
        child.send({
          id: message.id,
          result: {
            userAgent,
            codexHome: reportedCodexHome ?? path.join(
              storageDirectory,
              "codex-subscription",
            ),
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      }
    }
  });
  const spawnImpl = ((
    _command: string,
    args: readonly string[],
    _options: SpawnOptions,
  ) => {
    launchCapture.args = args;
    return child;
  }) as unknown as typeof spawn;
  const client = await CodexRpcClient.start({
    storageDirectory,
    spawnImpl,
    resolveExecutableImpl: resolveTestExecutable,
  });
  return {
    child,
    client,
    metadataBaseUrl: metadataBaseUrlFromArgs(launchCapture.args),
    outbound,
    request(method: string): RpcMessage & { id: number } {
      const message = outbound.find((candidate) => candidate.method === method);
      assert.equal(typeof message?.id, "number");
      return message as RpcMessage & { id: number };
    },
  };
}

async function resolveTestExecutable(): Promise<string> {
  return "/live-smith/test-native-codex";
}

function metadataBaseUrlFromArgs(args: readonly string[] | undefined): string {
  const configuration = args?.find((argument) =>
    argument.startsWith('chatgpt_base_url="')
  );
  assert.notEqual(configuration, undefined);
  const match = /^chatgpt_base_url="(http:\/\/127\.0\.0\.1:[1-9]\d*\/[0-9a-f]{64}\/backend-api\/)"$/u
    .exec(configuration ?? "");
  assert.notEqual(match, null);
  return match?.[1] ?? "";
}

async function assertMetadataUnavailable(baseUrl: string): Promise<void> {
  const base = new URL(baseUrl);
  await assert.rejects(
    new Promise<void>((resolve, reject) => {
      const request = httpRequest({
        host: base.hostname,
        port: base.port,
        path: base.pathname,
        method: "GET",
        headers: { Connection: "close" },
      }, (response) => {
        response.resume();
        response.once("end", resolve);
      });
      request.once("error", reject);
      request.end();
    }),
    (error: unknown) => {
      assert.match((error as NodeJS.ErrnoException).code ?? "", /^ECONN/u);
      return true;
    },
  );
}

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: Array<NodeJS.Signals | undefined> = [];
  private exited = false;
  private closed = false;

  constructor(private readonly options: {
    exitOnStdinFinish?: boolean;
    ignoreSigterm?: boolean;
    ignoreSigkill?: boolean;
  } = {}) {
    super();
    if (options.exitOnStdinFinish !== false) {
      this.stdin.once("finish", () => this.exit(0, null));
    }
  }

  send(message: RpcMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code, signal);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    if (signal === "SIGTERM" && this.options.ignoreSigterm) return true;
    if (signal === "SIGKILL" && this.options.ignoreSigkill) return true;
    this.exit(null, signal ?? "SIGTERM");
    return true;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for process lifecycle evidence.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function responseLineAtSize(id: number, size: number): string {
  const prefix = `{"id":${id},"result":"`;
  const suffix = `"}`;
  const padding = size - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  assert.equal(padding >= 0, true);
  return `${prefix}${"x".repeat(padding)}${suffix}`;
}
