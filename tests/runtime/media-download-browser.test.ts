import assert from "node:assert/strict";
import test from "node:test";
import { createMediaDownloadBrowserOpener } from "../../src/runtime/media-download-browser.js";
import { createSystemBrowserOpener } from "../../src/runtime/system-browser.js";

const target = "http://127.0.0.1:45678/audio-download?token=11111111-1111-4111-8111-111111111111";

test("local audio export uses the OS default browser with an exact resource-only destination", async () => {
  const calls: unknown[] = [];
  const runOpenCommand = async (executable: string, args: readonly string[]) => { calls.push([executable, [...args]]); };
  await createMediaDownloadBrowserOpener({ platform: "darwin", runOpenCommand })(target);
  await createMediaDownloadBrowserOpener({ platform: "win32", windowsSystemRoot: "C:\\Windows", runOpenCommand })(target);
  assert.deepEqual(calls, [["/usr/bin/open", [target]], ["C:\\Windows\\System32\\rundll32.exe", ["url.dll,FileProtocolHandler", target]]]);
  await assert.rejects(createSystemBrowserOpener({ platform: "darwin", runOpenCommand })(target), /HTTPS/);
  for (const value of [target.replace("127.0.0.1", "evil.test"), target.replace("127.0.0.1", "localhost"),
    target.replace("/audio-download", "/chat"), target + "&sessionId=private", target + "#hash",
    target.replace("http:", "file:"), target.replace("127.0.0.1", "user@127.0.0.1"), "file:///private/key"]) {
    await assert.rejects(createMediaDownloadBrowserOpener({ runOpenCommand })(value), /resource-scoped/);
  }
  assert.equal(calls.length, 2);
});


test("portable MIDI export opens the same scoped browser delivery path", async () => {
  const calls: string[] = [];
  const url = target.replace("/audio-download", "/midi-download");
  await createMediaDownloadBrowserOpener({ platform: "darwin", runOpenCommand: async (_executable, args) => { calls.push(args[0]!); } })(url);
  assert.deepEqual(calls, [url]);
});
