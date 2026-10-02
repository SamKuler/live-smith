import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import * as esbuild from "esbuild";
import { saveGlobalSettings } from "../../src/storage/settings.js";
import type { signInMcpOAuth } from "../../src/app/plugins/mcp-oauth.js";
import { oauthServer } from "../app/plugins/support/mcp-oauth-server.js";

test("bundled MCP OAuth executes PKCE without ambient Node URL, crypto, encoding, or base64 globals", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-mcp-oauth-vm-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const server = await oauthServer(t);
  await saveGlobalSettings(directory, { integrationConnections: { action: "upsert", expectedRevision: "0", connection: {
    id: "vm-account", name: "VM account", enabled: true, mcp: { type: "streamable-http", url: `${server.origin}/mcp` },
    oauth: {}, artifactInputApproved: false, artifactOutputApproved: false,
  } } });
  const build = await esbuild.build({ entryPoints: ["src/app/plugins/mcp-oauth.ts"], bundle: true,
    format: "cjs", banner: { js: "(function () {" }, footer: { js: "})();" }, platform: "node", inject: ["src/runtime/network-node-globals.ts"], write: false, logLevel: "silent" });
  const bundledModule: { exports: Record<string, unknown> } = { exports: {} };
  const context = vm.createContext({ AbortController, AbortSignal, Headers, Request, Response, fetch,
    clearTimeout, setTimeout, clearInterval, setInterval, console,
    module: bundledModule, exports: bundledModule.exports, require: createRequire(import.meta.url) });
  assert.equal(vm.runInContext("typeof TextEncoder", context), "undefined");
  vm.runInContext(build.outputFiles[0]!.text, context);
  await (bundledModule.exports.signInMcpOAuth as typeof signInMcpOAuth)({ storageDirectory: directory,
    connectionId: "vm-account", signal: new AbortController().signal, fetchImpl: fetch,
    openBrowser: (url) => server.authorize(url) });
  assert.equal(server.tokenCalls, 1);
});
