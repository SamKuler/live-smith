import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import { JSDOM, VirtualConsole } from "jsdom";
import { buildSunoVerificationScript } from "./suno-verification.js";

function page(version: 1 | 2 = 2, url = "https://suno.com/create") {
  const errors: unknown[] = [];
  const console = new VirtualConsole();
  console.on("jsdomError", error => errors.push(error));
  const dom = new JSDOM("<!doctype html><body></body>", { url, runScripts: "outside-only", virtualConsole: console });
  const messages: Record<string, unknown>[] = [];
  Object.assign(dom.window, { webkit: { messageHandlers: { liveSmithVerification: {
    postMessage(value: Record<string, unknown>) { messages.push(value); },
  } } } });
  dom.window.eval(buildSunoVerificationScript(version, "zh-CN", ""));
  const root = dom.window.document.getElementById("live-smith-verification")?.shadowRoot;
  return { dom, window: dom.window, root: root!, messages, errors };
}

type Callbacks = Record<string, (...args: string[]) => void>;
function sdk(h: ReturnType<typeof page>, version: 1 | 2 = 2) {
  const attempts: Callbacks[] = [];
  const elements: unknown[] = [];
  const executions: unknown[] = [];
  Object.assign(h.window, { [version === 2 ? "turnstile" : "hcaptcha"]: {
    render(element: unknown, callbacks: Callbacks) { elements.push(element); attempts.push(callbacks); return "widget-" + attempts.length; },
    execute(id: unknown) { executions.push(id); }, remove() {},
  } });
  return { attempts, elements, executions };
}

test("native client compiles for both providers and locales", () => {
  for (const version of [1, 2] as const) for (const locale of ["en", "zh-CN", "system"]) {
    assert.doesNotThrow(() => new Script(buildSunoVerificationScript(version, locale, "")));
  }
});

test("only an actual first-party HTTPS page mounts, and mounting starts nothing", () => {
  for (const url of ["http://suno.com/create", "https://suno.com.example/create", "http://127.0.0.1/"]) {
    const h = page(2, url);
    assert.equal(h.root, undefined);
    assert.equal(h.messages.length, 0);
    h.dom.window.close();
  }
  const h = page();
  assert.equal(h.window.document.querySelectorAll("script").length, 0);
  assert.equal(h.messages.length, 0);
  h.dom.window.close();
});

for (const version of [1, 2] as const) {
  test(`manual version ${version} executes its exact SDK and keeps proof out of UI`, () => {
    const h = page(version);
    const s = sdk(h, version);
    h.root.getElementById("start")!.click();
    assert.ok(s.elements[0] instanceof h.window.HTMLElement);
    assert.deepEqual(s.executions, ["widget-1"]);
    s.attempts[0]!.callback!("PRIVATE_CALLBACK_CANARY");
    assert.equal(h.messages.at(-1)!.type, "verified");
    assert.equal(h.messages.at(-1)!.captchaVersion, version);
    assert.equal(h.messages.at(-1)!.token, "PRIVATE_CALLBACK_CANARY");
    assert.ok(!h.root.textContent!.includes("PRIVATE_CALLBACK_CANARY"));
    assert.equal(h.root.getElementById("start")!.textContent, "验证完成");
    h.dom.window.close();
  });
}

test("failed attempts may be manually retried but their late callbacks cannot return proof", () => {
  const h = page();
  const s = sdk(h);
  const start = h.root.getElementById("start")!;
  start.click();
  s.attempts[0]!["error-callback"]!("110600");
  start.click();
  s.attempts[0]!.callback!("STALE_PRIVATE_CANARY");
  assert.equal(h.messages.length, 0);
  s.attempts[1]!.callback!("CURRENT_PRIVATE_CANARY");
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0]!.token, "CURRENT_PRIVATE_CANARY");
  h.dom.window.close();
});

test("unknown error text is not displayed or sent; non-retryable hostname errors settle", () => {
  for (const version of [1, 2] as const) {
    const h = page(version);
    const s = sdk(h, version);
    h.root.getElementById("start")!.click();
    s.attempts[0]!["error-callback"]!("PRIVATE_ERROR_CANARY");
    assert.ok(!h.root.textContent!.includes("PRIVATE_ERROR_CANARY"));
    assert.equal(h.messages.length, 0);
    h.root.getElementById("start")!.click();
    s.attempts[1]!["error-callback"]!(version === 2 ? "110200" : "invalid-domain");
    assert.equal(h.messages.at(-1)!.type, "failed");
    assert.equal(h.messages.at(-1)!.code, "unsupported-domain");
    h.dom.window.close();
  }
});

test("SDK loading and silent execution both have bounded waits, with no version fallback", () => {
  for (const version of [1, 2] as const) {
    const h = page(version);
    const timers: Array<{ callback: () => void; duration: number }> = [];
    h.window.setTimeout = ((callback: () => void, duration: number) => { timers.push({ callback, duration }); return timers.length; }) as typeof h.window.setTimeout;
    h.root.getElementById("start")!.click();
    const loader = h.window.document.querySelector("script")!;
    assert.equal(new URL(loader.src).hostname, version === 2 ? "challenges.cloudflare.com" : "hcaptcha-endpoint-prod.suno.com");
    timers.find(timer => timer.duration === 20000)!.callback();
    assert.equal((h.root.getElementById("start") as HTMLButtonElement).disabled, false);
    assert.equal(h.window.document.querySelectorAll("script").length, 1);
    sdk(h, version);
    h.root.getElementById("start")!.click();
    timers.find(timer => timer.duration === 180000)!.callback();
    assert.equal((h.root.getElementById("start") as HTMLButtonElement).disabled, false);
    h.dom.window.close();
  }
});

test("late SDK loads from a timed-out attempt cannot mount a retry twice", () => {
  for (const version of [1, 2] as const) {
    const h = page(version);
    const timers: Array<{ callback: () => void; duration: number }> = [];
    h.window.setTimeout = ((callback: () => void, duration: number) => { timers.push({ callback, duration }); return timers.length; }) as typeof h.window.setTimeout;
    const start = h.root.getElementById("start")!;
    start.click();
    const oldName = new URL(h.window.document.querySelector("script")!.src).searchParams.get("onload")!;
    const oldCallback = (h.window as unknown as Record<string, () => void>)[oldName]!;
    timers.find(timer => timer.duration === 20000)!.callback();
    start.click();
    const newName = new URL(h.window.document.querySelector("script")!.src).searchParams.get("onload")!;
    const newCallback = (h.window as unknown as Record<string, () => void>)[newName]!;
    const s = sdk(h, version);
    oldCallback();
    newCallback();
    newCallback();
    assert.equal(s.executions.length, 1);
    assert.equal(s.elements.length, 1);
    h.dom.window.close();
  }
});

test("cancel settles once and prevents pending callbacks from sending proof", () => {
  const h = page();
  const s = sdk(h);
  h.root.getElementById("start")!.click();
  h.root.getElementById("cancel")!.click();
  h.root.getElementById("cancel")!.click();
  s.attempts[0]!.callback!("AFTER_CANCEL_CANARY");
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages)), [{ type: "cancelled" }]);
  h.dom.window.close();
});

test("hydration reattaches the panel without starting a challenge or leaking queued DOM errors", async () => {
  const h = page();
  const host = h.window.document.getElementById("live-smith-verification")!;
  h.window.document.body.replaceChildren();
  await Promise.resolve();
  assert.equal(host.isConnected, true);
  assert.equal(h.messages.length, 0);
  assert.equal(h.window.document.querySelectorAll("script").length, 0);
  h.window.document.body.replaceChildren();
  h.dom.window.close();
  await Promise.resolve();
  assert.deepEqual(h.errors, []);
});
