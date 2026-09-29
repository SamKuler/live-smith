import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { startPluginAppSandbox } from "./plugin-app-sandbox.js";

const HOST = "http://127.0.0.1:31234";

test("MCP App sandbox binds a separate loopback origin and retires individual registrations", async (t) => {
  const sandbox = await startPluginAppSandbox(HOST);
  t.after(() => sandbox.close());
  const first = sandbox.register();
  const second = sandbox.register({ connectDomains: ["https://api.example.test"], resourceDomains: ["https://cdn.example.test"] });
  assert.notEqual(new URL(first.url).origin, HOST);
  assert.notEqual(first.url, second.url);
  const response = await fetch(first.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy")!, /connect-src 'none'/u);
  assert.match(response.headers.get("content-security-policy")!, /frame-src 'none'/u);
  assert.match(response.headers.get("content-security-policy")!, /object-src 'none'/u);
  assert.match(response.headers.get("content-security-policy")!, /media-src data: blob:/u);
  assert.match(response.headers.get("content-security-policy")!, /font-src data: blob:/u);
  assert.doesNotMatch(response.headers.get("content-security-policy")!, /unsafe-eval|default-src 'self'/u);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const declared = await fetch(second.url);
  assert.match(declared.headers.get("content-security-policy")!, /connect-src https:\/\/api\.example\.test/u);
  assert.match(declared.headers.get("content-security-policy")!, /script-src 'unsafe-inline' https:\/\/cdn\.example\.test/u);
  first.dispose();
  assert.equal((await fetch(first.url)).status, 404);
  assert.equal((await fetch(second.url)).status, 200);
  assert.equal((await fetch(second.url + "?token=untrusted")).status, 404);
  assert.equal((await fetch(second.url, { method: "POST", body: "untrusted" })).status, 405);
  const spoofedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const pending = request(second.url, { headers: { Host: "untrusted.example" } }, (response) => {
      response.resume(); response.once("end", () => resolve(response.statusCode));
    });
    pending.once("error", reject);
    pending.end();
  });
  assert.equal(spoofedHostStatus, 404);
  await sandbox.close();
  await sandbox.close();
  assert.throws(() => sandbox.register(), /closed/u);
});

test("MCP App sandbox rejects CSP directive injection and unsupported origin shapes", async (t) => {
  const sandbox = await startPluginAppSandbox(HOST);
  t.after(() => sandbox.close());
  for (const origin of [
    "https://cdn.example; script-src *", "https://*.example.test", "https://cdn.example/path", "data:",
    "http://remote.example", "https://user:password@example.test", "https://example.test#part", "wss://example.test",
  ]) assert.throws(() => sandbox.register({ resourceDomains: [origin] }), /MCP App CSP/u);
  assert.throws(() => sandbox.register({ connectDomains: Array.from({ length: 33 }, () => "https://example.test") }), /too many/u);
  for (const origin of ["http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000", "https://example.test"]) {
    const resource = sandbox.register({ connectDomains: [origin] });
    assert.equal((await fetch(resource.url)).status, 200);
  }
  await assert.rejects(startPluginAppSandbox("http://127.0.0.1:31234/chat"), /origin/u);
});

test("sandbox proxy accepts only its parent and opaque child and never relays sandbox control messages", async (t) => {
  const sandbox = await startPluginAppSandbox(HOST);
  t.after(() => sandbox.close());
  const registration = sandbox.register();
  const html = await (await fetch(registration.url)).text();
  const dom = new JSDOM(html, { url: registration.url, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const sent: { data: unknown; origin: string }[] = [];
  const parent = { postMessage(data: unknown, origin: string) { sent.push({ data, origin }); } };
  Object.defineProperty(dom.window, "parent", { value: parent });
  dom.window.eval(dom.window.document.querySelector("script")!.textContent!);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ data: {
    jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {},
  }, origin: HOST }]);
  const frame = dom.window.document.querySelector("iframe")!;
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
  const send = (source: unknown, origin: string, data: unknown) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
    source: source as Window, origin, data,
  }));
  const ready = { jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: {
    html: "<!doctype html><p>App</p>", sandbox: "allow-scripts allow-same-origin", permissions: { camera: {} },
  } };
  send(parent, "https://untrusted.example", ready);
  send({}, HOST, ready);
  assert.equal(frame.srcdoc, "");
  send(parent, HOST, ready);
  assert.equal(frame.srcdoc, ready.params.html);
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
  assert.equal(frame.getAttribute("allow"), null);
  send(parent, HOST, { ...ready, params: { html: "replacement" } });
  assert.equal(frame.srcdoc, ready.params.html);
  const child = frame.contentWindow!;
  const received: unknown[] = [];
  child.postMessage = (data: unknown) => { received.push(data); };
  const initialize = { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} };
  send(child, "https://untrusted.example", initialize);
  send({}, "null", initialize);
  assert.equal(sent.length, 1);
  send(child, "null", ready);
  assert.equal(sent.length, 1);
  send(child, "null", initialize);
  assert.deepEqual(sent[1], { data: initialize, origin: HOST });
  const response = { jsonrpc: "2.0", id: 1, result: {} };
  send(parent, HOST, response);
  assert.deepEqual(received, [response]);
  send(parent, HOST, { jsonrpc: "2.0", method: "ui/notifications/sandbox-forbidden", params: {} });
  assert.equal(received.length, 1);
});
