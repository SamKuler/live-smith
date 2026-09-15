import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import test from "node:test";
import { createHostAbortController } from "./host.js";
import { createSunoHumanVerifier } from "./suno-human-verification.js";

const files = ["Contents/MacOS/SunoVerification", "Contents/Info.plist", "Contents/_CodeSignature/CodeResources"]
  .map(path => ({ path, base64: Buffer.from("own-synthetic-file").toString("base64"),
    sha256: createHash("sha256").update("own-synthetic-file").digest("hex") }));
const capsule = JSON.stringify({ version: 1, files });
const proof = { type: "verified", captchaVersion: 2, token: "PRIVATE_CALLBACK_CANARY", issuedAtMs: Date.now() };
const options = () => ({ captchaVersion: 2 as const, signal: createHostAbortController().signal,
  interfaceLanguage: "zh-CN", networkProxy: { mode: "manual" as const, url: "http://127.0.0.1:7897" }, connectionName: "My Suno" });

test("native invocation uses a fixed staged executable, private stdin, no arguments or inherited credentials", async () => {
  let directory = "";
  const verify = createSunoHumanVerifier({ platform: "darwin", capsule, styles: "compiled-own-style", run: async (executable, input, command) => {
    assert.ok(executable.endsWith("SunoVerification.app/Contents/MacOS/SunoVerification"));
    directory = executable.slice(0, executable.indexOf("/SunoVerification.app/"));
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    const request = JSON.parse(input);
    assert.equal(request.protocol, 1);
    assert.equal(request.captchaVersion, 2);
    assert.deepEqual(request.networkProxy, { mode: "manual", url: "http://127.0.0.1:7897" });
    assert.deepEqual(Object.keys(request).sort(), ["captchaVersion", "connectionName", "networkProxy", "protocol", "script"]);
    assert.equal(request.script.includes("compiled-own-style"), true);
    assert.equal(command.signal.aborted, false);
    assert.deepEqual(command.env, {});
    assert.equal(command.maxBuffer, 65536);
    assert.equal(command.timeout, 600000);
    return JSON.stringify(proof);
  } });
  const result = await verify(options());
  assert.equal(result.token, proof.token);
  assert.deepEqual(Object.keys(result).sort(), ["captchaVersion", "issuedAtMs", "token"]);
  await assert.rejects(fs.stat(directory));
});

test("untrusted native output or command errors never expose tokens, private causes or stderr", async () => {
  for (const value of ["bad-private-canary", " ".repeat(65537), JSON.stringify({ ...proof, captchaVersion: 1 }),
    JSON.stringify({ ...proof, issuedAtMs: Date.now() - 301000 }), JSON.stringify({ ...proof, extra: "private-canary" }),
    JSON.stringify({ type: "failed", code: "private-canary" }), JSON.stringify({ type: "cancelled", token: "private-canary" })]) {
    const verify = createSunoHumanVerifier({ platform: "darwin", capsule, styles: "", run: async () => value });
    await assert.rejects(verify(options()), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(String(error.stack), /PRIVATE_CALLBACK_CANARY|private-canary/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  const verify = createSunoHumanVerifier({ platform: "darwin", capsule, styles: "", run: async () => {
    throw new Error("private-canary", { cause: new Error(proof.token) });
  } });
  await assert.rejects(verify(options()), error => {
    assert.doesNotMatch(String((error as Error).stack), /private-canary|PRIVATE_CALLBACK_CANARY/);
    return true;
  });
});

test("native close and parent Stop are cancellations, never usable success results", async () => {
  const verify = createSunoHumanVerifier({ platform: "darwin", capsule, styles: "", run: async () => '{"type":"cancelled"}' });
  await assert.rejects(verify(options()), { name: "AbortError" });
  const controller = createHostAbortController();
  const stopped = createSunoHumanVerifier({ platform: "darwin", capsule, styles: "", run: async () => {
    controller.abort(); return JSON.stringify(proof);
  } });
  await assert.rejects(stopped({ ...options(), signal: controller.signal }), { name: "AbortError" });
});

test("unsupported platforms and corrupted capsules fail before launching a helper", async () => {
  for (const [platform, data] of [["win32", capsule], ["darwin", JSON.stringify({ version: 1, files: [{ ...files[0], path: "../evil" }] })]] as const) {
    let calls = 0;
    const verify = createSunoHumanVerifier({ platform, capsule: data, styles: "", run: async () => { calls++; return JSON.stringify(proof); } });
    await assert.rejects(verify(options()));
    assert.equal(calls, 0);
  }
});
