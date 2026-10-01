import assert from "node:assert/strict";
import test from "node:test";
import { createSunoPlatformOpener, createSunoWebsiteOpener } from "../../src/runtime/suno-website.js";

for (const platform of ["darwin", "win32"] as const) {
  test(`Suno uses the ${platform} default handler without a browser profile or debugger`, async () => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const open = createSunoWebsiteOpener({ platform, windowsSystemRoot: "C:\\Windows",
      runOpenCommand: async (executable, args) => { calls.push({ executable, args }); } });
    await open(new AbortController().signal);
    assert.deepEqual(calls, [platform === "darwin"
      ? { executable: "/usr/bin/open", args: ["https://suno.com/create"] }
      : { executable: "C:\\Windows\\System32\\rundll32.exe", args: ["url.dll,FileProtocolHandler", "https://suno.com/create"] }]);
  });
}

for (const platform of ["darwin", "win32"] as const) {
  test(`Suno Platform uses the ${platform} default handler`, async () => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const open = createSunoPlatformOpener({ platform, windowsSystemRoot: "C:\\Windows",
      runOpenCommand: async (executable, args) => { calls.push({ executable, args }); } });
    await open();
    assert.deepEqual(calls, [platform === "darwin"
      ? { executable: "/usr/bin/open", args: ["https://platform.suno.com/"] }
      : { executable: "C:\\Windows\\System32\\rundll32.exe", args: ["url.dll,FileProtocolHandler", "https://platform.suno.com/"] }]);
  });
}

test("opening Suno preserves cancellation and never reports sign-in success", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const open = createSunoWebsiteOpener({ platform: "darwin", runOpenCommand: async () => { calls++; } });
  await assert.rejects(open(controller.signal), { name: "AbortError" });
  assert.equal(calls, 0);
  assert.equal(await open(), undefined);
  assert.equal(calls, 1);
});
