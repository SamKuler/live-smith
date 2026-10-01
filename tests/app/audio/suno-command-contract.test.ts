import assert from "node:assert/strict";
import test from "node:test";
import { parseCommandInput } from "../../../src/app/chat/chat-bridge-http.js";

test("local audio export accepts only a Session-owned asset reference", () => {
  const input = { kind: "open_audio_download", sessionId: "session-one", assetId: "asset-one" };
  assert.deepEqual(parseCommandInput(input), input);
  for (const patch of [{ assetId: "../asset" }, { sessionId: "../session" }, { url: "https://example.test" },
    { path: "/private/file" }, { token: "secret" }, { serviceId: "suno-one" }]) {
    assert.throws(() => parseCommandInput({ ...input, ...patch }));
  }
});

test("explicit Suno download selects exactly one existing job output, never a URL or generation", () => {
  const input = { kind: "download_audio_output", sessionId: "session-one", jobId: "audiojob-one",
    outputKey: "11111111-1111-4111-8111-111111111111" };
  assert.deepEqual(parseCommandInput(input), input);
  for (const patch of [{ sessionId: "../session" }, { jobId: "../job" }, { outputKey: "" },
    { outputKey: "https://suno.com/song/" + input.outputKey }, { outputKey: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
    { outputKey: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, { outputKeys: [input.outputKey] },
    { serviceId: "other-service" }, { url: "https://example.test" }, { apiKey: "fixture-secret" },
    { prompt: "generate again" }, { purchase: true }]) {
    assert.throws(() => parseCommandInput({ ...input, ...patch }));
  }
});

test("opening the Suno website accepts no destination, connection or credential", () => {
  for (const kind of ["open_suno_website", "open_suno_platform"] as const) {
    assert.deepEqual(parseCommandInput({ kind }), { kind });
    for (const extra of [{ serviceId: "suno-one" }, { url: "https://example.test" }, { cookie: "fixture-secret" }]) {
      assert.throws(() => parseCommandInput({ kind, ...extra }));
    }
  }
  assert.throws(() => parseCommandInput({ kind: "open_suno_login", serviceId: "suno-one" }));
});

test("Suno Cookie import has a separate bounded credential command", () => {
  const input = { kind: "import_suno_session", serviceId: "suno-one", sessionValue: "header.payload.signature" };
  assert.deepEqual(parseCommandInput(input), input);
  const cookieHeader = { ...input, sessionValue: "Cookie: __session=header.payload.signature; __client_uat=123" };
  assert.deepEqual(parseCommandInput(cookieHeader), cookieHeader);
  for (const extra of [{ serviceId: "../outside" }, { sessionValue: "" }, { sessionValue: "x".repeat(16_385) },
    { sessionValue: "line\r\nheader" }, { sessionValue: 42 }, { password: "fixture-secret" }, { url: "https://example.test" }]) {
    assert.throws(() => parseCommandInput({ ...input, ...extra }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /fixture-secret|line\r\nheader/);
      return true;
    });
  }
});

test("checking and disconnecting Suno cannot carry browser data or redirect destinations", () => {
  for (const kind of ["refresh_suno_login", "logout_suno"]) {
    assert.deepEqual(parseCommandInput({ kind, serviceId: "suno-one" }), { kind, serviceId: "suno-one" });
    for (const extra of [{ cookie: "fixture" }, { sessionValue: "fixture" }, { serviceId: "../outside" }, { url: "https://suno.com" }]) {
      assert.throws(() => parseCommandInput({ kind, serviceId: "suno-one", ...extra }));
    }
  }
});
