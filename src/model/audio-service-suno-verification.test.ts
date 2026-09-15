import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import test from "node:test";
import type { AudioGenerationRequest } from "../audio-services/contracts.js";
import { createSunoAudioAdapter } from "../audio-services/suno.js";
import { createHostAbortController } from "../runtime/host.js";
import {
  API, AUTH, A, MUSIC, session, replay, accountStep, gateStep, submitStep, clip,
} from "./audio-service-suno-harness.js";

const PRIVATE_PROOF = "synthetic-private-verification-proof";
const proof = (captchaVersion: 1 | 2, issuedAtMs = Date.now()) => ({ captchaVersion, token: PRIVATE_PROOF, issuedAtMs });

for (const version of [1, 2] as const) {
  test(`version ${version} returns private proof to the same prepared request and submits once`, async () => {
    const controller = createHostAbortController();
    let calls = 0;
    const h = replay([accountStep(), gateStep({ required: true, captcha_version: version }), submitStep()], undefined, {
      verifyHuman: async (captchaVersion, signal) => {
        calls++;
        assert.equal(captchaVersion, version);
        assert.equal(signal, controller.signal);
        assert.equal(h.api().length, 2);
        return proof(version);
      },
    });
    const request: AudioGenerationRequest = { operation: "generate_music", prompt: "Literal song lyrics", instrumental: false,
      durationSeconds: 220, options: { mode: "custom", title: "Fixture title", styles: "Future bass", negativeStyles: "distortion" } };
    await h.adapter.prepare!(request, controller.signal);
    assert.equal(calls, 1);
    assert.equal(h.api().length, 2);
    await h.adapter.submit(request, controller.signal);
    const body = h.api().at(-1)!.body as Record<string, unknown>;
    assert.equal(body.token, PRIVATE_PROOF);
    assert.equal(body.token_provider, version);
    assert.equal(body.prompt, request.prompt);
    assert.equal(body.duration, 220);
    assert.equal(body.title, "Fixture title");
    await assert.rejects(h.adapter.submit(request, controller.signal));
    assert.equal(h.api().filter(entry => entry.path === "/api/generate/v2-web/").length, 1);
    h.done();
  });
}

test("a no-challenge response sends null proof fields and never invokes a verifier", async () => {
  let calls = 0;
  const h = replay([accountStep(), gateStep(), submitStep()], undefined, {
    verifyHuman: async () => { calls++; return proof(2); },
  });
  const request = { ...MUSIC };
  const signal = createHostAbortController().signal;
  await h.adapter.prepare!(request, signal);
  await h.adapter.submit(request, signal);
  const body = h.api().at(-1)!.body as Record<string, unknown>;
  assert.equal(body.token, null);
  assert.equal(body.token_provider, null);
  assert.equal(calls, 0);
});

test("verification does not regenerate either request UUID", async (t) => {
  const crypto = createRequire(import.meta.url)("node:crypto") as typeof import("node:crypto");
  const originalRandomUUID = crypto.randomUUID;
  const controller = createHostAbortController();
  let generatedAtVerification: string[] = [];
  const generated: string[] = [];
  const h = replay([accountStep(), gateStep({ required: true, captcha_version: 2 }), submitStep()], undefined, {
    verifyHuman: async () => { generatedAtVerification = [...generated]; return proof(2); },
  });
  const mock = t.mock.method(crypto, "randomUUID", () => {
    const id = originalRandomUUID();
    generated.push(id);
    return id;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const request = { ...MUSIC };
  await h.adapter.prepare!(request, controller.signal);
  await h.adapter.submit(request, controller.signal);
  const body = h.api().at(-1)!.body as Record<string, unknown>;
  // Session authentication also creates anonymous-device UUIDs. Both *request*
  // UUIDs must already exist before verification, not be created on continuation.
  const requestIds = [(body.metadata as Record<string, unknown>).create_session_token, body.transaction_uuid];
  assert.notEqual(requestIds[0], requestIds[1]);
  for (const id of requestIds) {
    assert.ok(generatedAtVerification.includes(String(id)));
    assert.equal(generated.filter(value => value === id).length, 1);
  }
});

test("unknown challenge versions fail before invoking a verifier or submitting", async () => {
  for (const captchaVersion of [undefined, null, 0, 3, "2"]) {
    let calls = 0;
    const h = replay([accountStep(), gateStep({ required: true, captcha_version: captchaVersion })], undefined, {
      verifyHuman: async () => { calls++; return proof(2); },
    });
    const request = { ...MUSIC };
    const signal = createHostAbortController().signal;
    await assert.rejects(h.adapter.prepare!(request, signal));
    await assert.rejects(h.adapter.submit(request, signal));
    assert.equal(calls, 0);
    assert.equal(h.api().length, 2);
  }
});

test("mismatched, malformed and old proofs cannot leave a usable prepared request", async () => {
  for (const value of [proof(1), proof(2, Date.now() - 301000), { ...proof(2), token: "" },
    { ...proof(2), issuedAtMs: Infinity }, { ...proof(2), extra: "unexpected" }]) {
    const h = replay([accountStep(), gateStep({ required: true, captcha_version: 2 })], undefined, {
      verifyHuman: async () => value,
    });
    const request = { ...MUSIC };
    const signal = createHostAbortController().signal;
    await assert.rejects(h.adapter.prepare!(request, signal), error => {
      assert.ok(error instanceof Error);
      assert.ok(!String(error.stack).includes(PRIVATE_PROOF));
      return true;
    });
    await assert.rejects(h.adapter.submit(request, signal));
    assert.equal(h.api().length, 2);
  }
});

test("cancellation or input mutation while verification is pending cannot submit", async () => {
  for (const scenario of ["cancel", "mutation"] as const) {
    const controller = createHostAbortController();
    const request = { ...MUSIC };
    const h = replay([accountStep(), gateStep({ required: true, captcha_version: 2 })], undefined, {
      verifyHuman: async () => {
        if (scenario === "cancel") controller.abort();
        else request.prompt = "Different requested music";
        return proof(2);
      },
    });
    await assert.rejects(h.adapter.prepare!(request, controller.signal));
    await assert.rejects(h.adapter.submit(request, controller.signal));
    assert.equal(h.api().length, 2);
  }
});

test("callback failures never expose a proof or raw credential-bearing cause", async () => {
  const h = replay([accountStep(), gateStep({ required: true, captcha_version: 2 })], undefined, {
    verifyHuman: async () => { throw new Error(PRIVATE_PROOF, { cause: new Error("private-auth-canary") }); },
  });
  await assert.rejects(h.adapter.prepare!({ ...MUSIC }, createHostAbortController().signal), error => {
    assert.ok(error instanceof Error);
    assert.ok(!String(error.stack).includes(PRIVATE_PROOF));
    assert.ok(!String(error.stack).includes("private-auth-canary"));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(h.api().length, 2);
});

test("a challenged concat keeps its existing fail-closed boundary without speculative proof fields", async () => {
  let calls = 0;
  const h = replay([
    { path: `/api/feed/?ids=${A}`, value: [clip(A, "complete", { metadata: { task: "extend" } })] },
    gateStep({ required: true, captcha_version: 2 }),
  ], undefined, { verifyHuman: async () => { calls++; return proof(2); } });
  const request: AudioGenerationRequest = { operation: "get_whole_song", clipId: A };
  const signal = createHostAbortController().signal;
  await assert.rejects(h.adapter.prepare!(request, signal));
  await assert.rejects(h.adapter.submit(request, signal));
  assert.equal(calls, 0);
  assert.equal(h.api().length, 2);
});

test("proof expiry during authentication work rejects before actual generation dispatch", async (t) => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const h = replay([accountStep(), gateStep({ required: true, captcha_version: 1 })]);
  let submitting = false;
  const fetchImpl = (async (input: unknown, init: RequestInit) => {
    if (submitting && String(input).startsWith(AUTH) && String(input).includes("/tokens?")) {
      t.mock.timers.setTime(start + 121000);
    }
    return h.fetchImpl(input as RequestInfo, init);
  }) as typeof fetch;
  const adapter = createSunoAudioAdapter(session, { fetchImpl, verifyHuman: async () => proof(1, start) });
  const request = { ...MUSIC };
  const signal = createHostAbortController().signal;
  await adapter.prepare!(request, signal);
  submitting = true;
  await assert.rejects(adapter.submit(request, signal));
  assert.equal(h.requests.filter(entry => entry.url.startsWith(API) && entry.path === "/api/generate/v2-web/").length, 0);
});
