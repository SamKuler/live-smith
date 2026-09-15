import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import type { AudioGenerationRequest, AudioJob } from "../audio-services/contracts.js";
import { createSunoAudioAdapter } from "../audio-services/suno.js";
import { createHostAbortController } from "../runtime/host.js";

export const API = "https://studio-api-prod.suno.com";
export const AUTH = "https://auth.suno.com/v1/client";
export const A = "00000000-0000-4000-8000-000000000001";
export const B = "00000000-0000-4000-8000-000000000002";
export const C = "00000000-0000-4000-8000-000000000003";
export const MODEL = "catalog-model-fixture";
export const accountId = "user_synthetic";
export const sessionId = "sess_synthetic";
export function token(claims: object) {
  return [JSON.stringify({ alg: "RS256" }), JSON.stringify(claims), "synthetic-signature"]
    .map((part) => Buffer.from(part).toString("base64url")).join(".");
}
export const clientToken = token({ sub: "client_synthetic" });
export const session = { clientToken, accountId };
export const MUSIC: Extract<AudioGenerationRequest, { operation: "generate_music" }> = { operation: "generate_music", prompt: "A warm instrumental groove", instrumental: true };
export const MANIFEST = [{ key: A, role: "music" }, { key: B, role: "music_alternative" }] satisfies AudioJob["expectedOutputs"];
export const single = [MANIFEST[0]!];
export const signal = () => createHostAbortController().signal;
export function model(overrides: Record<string, unknown> = {}) {
  return { external_key: MODEL, name: "Music model", can_use: true, is_default_model: true,
    major_version: 6,
    max_lengths: { prompt: 5000, gpt_description_prompt: 1000, title: 160, tags: 1000, negative_tags: 1000 }, ...overrides };
}
export function catalog(models: unknown[] = [model()], extra: Record<string, unknown> = {}) {
  return { total_credits_left: 123, plan: { name: "Fixture plan" }, models, ...extra };
}
export function clip(id = A, status = "complete", extra: Record<string, unknown> = {}) {
  return { id, status, title: "Fixture song", model_name: MODEL, audio_url: `https://cdn1.suno.ai/${id}.mp3`,
    is_download_unlocked: true, metadata: { duration: 30, tags: "jazz", make_instrumental: true }, ...extra };
}
export const downloadPath = (id = A) => `/api/download/clip/${id}?format=mp3`;
export function receipt(ids: string[] = [B, A]) { return { status: "submitted", clips: ids.map((id) => clip(id, "submitted")) }; }
export type Step = { path: string; value?: unknown; response?: Response; run?: () => Promise<Response> };
export function replay(steps: Step[] = [], modelId?: string,
  options: NonNullable<Parameters<typeof createSunoAudioAdapter>[1]> = {}) {
  const requests: Array<{ path: string; url: string; init: RequestInit; body: unknown; headers: Headers }> = [];
  const pending = [...steps];
  const jwt = token({ sub: accountId, sid: sessionId, exp: Math.floor(Date.now() / 1000) + 600 });
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const path = url.startsWith(API) ? url.slice(API.length) : url;
    requests.push({ url, path, init, headers: new Headers(init.headers),
      body: typeof init.body === "string" && init.body ? JSON.parse(init.body) : init.body });
    if (url.startsWith(AUTH + "?")) return Response.json({ response: {
      object: "client", last_active_session_id: sessionId,
      sessions: [{ object: "session", id: sessionId, status: "active", expire_at: Date.now() + 60_000,
        user: { object: "user", id: accountId } }],
    } });
    if (url.startsWith(`${AUTH}/sessions/${sessionId}/tokens?`)) return Response.json({ jwt });
    const step = pending.shift();
    assert.ok(step, `unexpected request ${path}`);
    assert.equal(path, step.path);
    return step.run ? step.run() : step.response ?? Response.json(step.value);
  }) as typeof fetch;
  return {
    adapter: createSunoAudioAdapter(session, { ...options, fetchImpl, ...(modelId === undefined ? {} : { modelId }) }),
    fetchImpl, requests, jwt, api: () => requests.filter((entry) => entry.url.startsWith(API)),
    done: () => assert.equal(pending.length, 0),
  };
}
export const accountStep = (value: unknown = catalog()): Step => ({ path: "/api/billing/info/", value });
export const gateStep = (value: unknown = { required: false }): Step => ({ path: "/api/c/check", value });
export const submitStep = (value: unknown = receipt()): Step => ({ path: "/api/generate/v2-web/", value });
export const pollStep = (value: unknown, ids = `${A},${B}`): Step => ({ path: `/api/feed/?ids=${ids}`, value });
export async function safeFailure(promise: Promise<unknown>, pattern = /Suno/u) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    assert.equal(error.cause, undefined);
    assert.ok(!String(error.stack).includes(clientToken));
    assert.doesNotMatch(String(error.stack), /remote-secret|untrusted\.test/u);
    return true;
  });
}
export async function preparedSubmit(harness: ReturnType<typeof replay>, request: AudioGenerationRequest = { ...MUSIC }) {
  const abort = signal();
  await harness.adapter.prepare!(request, abort);
  return harness.adapter.submit(request, abort);
}
