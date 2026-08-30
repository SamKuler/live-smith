import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers";

import {
  ModelBackendManager,
  createDirectApiBackend,
} from "./backend-registry.js";
import type {
  OAuthSubscriptionBackend,
  TransportRequest,
} from "./provider.js";
import type {
  DraftProfile,
  OAuthSubscriptionProvider,
  SavedProfile,
} from "./profile.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function directProfile(): SavedProfile {
  return {
    id: "direct",
    name: "Direct",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "https://example.test/v1",
      apiKey: "key",
    },
    defaultModel: "model-1",
    models: [{
      model: "model-1",
      parameters: {
        maxOutputTokens: 4_096,
        reasoning: { mode: "default" },
      },
      advanced: {},
    }],
  };
}

function fakeBackend(_provider: OAuthSubscriptionProvider): OAuthSubscriptionBackend & {
  closeCalls: number;
} {
  return {
    kind: "oauth-subscription",
    closeCalls: 0,
    async listModels(_profile: DraftProfile) {
      return [];
    },
    async createToolTurn(_request: TransportRequest) {
      return { content: "ok", toolCalls: [] };
    },
    async readAuthState() {
      return { status: "signed-out" } as const;
    },
    async beginLogin() {
      return { status: "signed-out" } as const;
    },
    async logout() {
      return { status: "signed-out" } as const;
    },
    async close() {
      this.closeCalls += 1;
    },
  };
}

test("Direct API backends remain short-lived transports", async () => {
  const backend = await createDirectApiBackend(directProfile(), {
    fetchImpl: async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(backend.kind, "direct-api");
  await backend.close();
});

test("OAuth backend manager shares one slot per provider", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-backends-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const starts: OAuthSubscriptionProvider[] = [];
  const backends = new Map<OAuthSubscriptionProvider, ReturnType<typeof fakeBackend>>();
  const manager = new ModelBackendManager(directory, {
    async startOAuthBackend(_storage, provider) {
      starts.push(provider);
      const backend = fakeBackend(provider);
      backends.set(provider, backend);
      return backend;
    },
  });

  const [openai1, openai2, google] = await Promise.all([
    manager.oauth("openai"),
    manager.oauth("openai"),
    manager.oauth("google"),
  ]);
  assert.equal(openai1, openai2);
  assert.notEqual(openai1, google);
  assert.deepEqual(starts.sort(), ["google", "openai"]);

  await manager.invalidateOAuth("openai");
  assert.equal(backends.get("openai")?.closeCalls, 1);
  assert.notEqual(await manager.oauth("openai"), openai1);
  await manager.close();
});

test("OAuth backend manager requires durable private storage", async () => {
  const manager = new ModelBackendManager(undefined);
  await assert.rejects(manager.oauth("anthropic"), /storage directory/i);
  await manager.close();
});

test("concurrent backend manager closes share backend cleanup", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-backends-close-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const releaseBackendClose = deferred<void>();
  const backend = fakeBackend("openai");
  backend.close = async function close() {
    this.closeCalls += 1;
    await releaseBackendClose.promise;
  };
  const manager = new ModelBackendManager(directory, {
    async startOAuthBackend() {
      return backend;
    },
  });
  await manager.oauth("openai");
  let firstSettled = false;
  let secondSettled = false;
  const first = manager.close().then(() => {
    firstSettled = true;
  });
  const second = manager.close().then(() => {
    secondSettled = true;
  });
  await Promise.resolve();
  const firstSettledBeforeBackend = firstSettled;
  const secondSettledBeforeBackend = secondSettled;
  releaseBackendClose.resolve(undefined);
  await Promise.all([first, second]);

  assert.equal(firstSettledBeforeBackend, false);
  assert.equal(secondSettledBeforeBackend, false);
  assert.equal(backend.closeCalls, 1);
});

test("backend manager close waits for an existing OAuth invalidation", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-backends-retire-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const releaseBackendClose = deferred<void>();
  const backend = fakeBackend("openai");
  backend.close = async function close() {
    this.closeCalls += 1;
    await releaseBackendClose.promise;
  };
  const manager = new ModelBackendManager(directory, {
    async startOAuthBackend() {
      return backend;
    },
  });
  await manager.oauth("openai");
  const invalidation = manager.invalidateOAuth("openai");
  let managerCloseSettled = false;
  const managerClose = manager.close().then(() => {
    managerCloseSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closeSettledBeforeRetirement = managerCloseSettled;
  releaseBackendClose.resolve(undefined);
  await Promise.all([invalidation, managerClose]);

  assert.equal(closeSettledBeforeRetirement, false);
  assert.equal(backend.closeCalls, 1);
});

test("backend manager close waits for every provider before propagating failure", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-backends-all-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const releaseGoogleClose = deferred<void>();
  const closeFailure = new Error("OpenAI backend close failed");
  const openai = fakeBackend("openai");
  openai.close = async function close() {
    this.closeCalls += 1;
    throw closeFailure;
  };
  const google = fakeBackend("google");
  google.close = async function close() {
    this.closeCalls += 1;
    await releaseGoogleClose.promise;
  };
  const manager = new ModelBackendManager(directory, {
    async startOAuthBackend(_storage, provider) {
      return provider === "openai" ? openai : google;
    },
  });
  await Promise.all([manager.oauth("openai"), manager.oauth("google")]);

  let closeSettled = false;
  const closeResult = manager.close().then(
    () => undefined,
    (error: unknown) => error,
  ).finally(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeGoogle = closeSettled;
  releaseGoogleClose.resolve(undefined);
  const error = await closeResult;

  assert.equal(settledBeforeGoogle, false);
  assert.equal(error, closeFailure);
  assert.equal(openai.closeCalls, 1);
  assert.equal(google.closeCalls, 1);
});
