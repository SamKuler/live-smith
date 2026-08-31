import assert from "node:assert/strict";
import test from "node:test";

import { createOAuthBrowserOpener } from "./oauth-browser.js";

test("the macOS OAuth browser opens each trusted provider host", async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const openOAuthAuthorizationUrl = createOAuthBrowserOpener({
    platform: "darwin",
    runOpenCommand: async (executable, args) => {
      calls.push({ executable, args });
    },
  });
  const targets = [
    "https://auth.openai.com/codex/device",
    "https://claude.ai/oauth/authorize?state=claude-state",
    "https://accounts.google.com/o/oauth2/v2/auth?state=google-state",
  ];

  for (const target of targets) await openOAuthAuthorizationUrl(target);

  assert.deepEqual(calls, targets.map((target) => ({
    executable: "/usr/bin/open",
    args: [target],
  })));
});

test("the OAuth browser rejects untrusted URLs before launching", async () => {
  let calls = 0;
  const openOAuthAuthorizationUrl = createOAuthBrowserOpener({
    platform: "darwin",
    runOpenCommand: async () => {
      calls += 1;
    },
  });

  for (const url of [
    "http://auth.openai.com/codex/device",
    "https://user:secret@auth.openai.com/codex/device",
    "https://example.test/oauth/authorize",
    "not a URL",
  ]) {
    await assert.rejects(
      openOAuthAuthorizationUrl(url),
      /trusted HTTPS authorization URL/i,
    );
  }
  assert.equal(calls, 0);
});

test("the Windows OAuth browser uses the fixed System32 handler for Antigravity", async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const openOAuthAuthorizationUrl = createOAuthBrowserOpener({
    platform: "win32",
    windowsSystemRoot: "C:\\Windows",
    runOpenCommand: async (executable, args) => {
      calls.push({ executable, args });
    },
  });

  const target = "https://accounts.google.com/o/oauth2/auth?state=antigravity-state";
  await openOAuthAuthorizationUrl(target);

  assert.deepEqual(calls, [{
    executable: "C:\\Windows\\System32\\rundll32.exe",
    args: [
      "url.dll,FileProtocolHandler",
      target,
    ],
  }]);
});

test("the OAuth browser fails explicitly outside desktop Live platforms", async () => {
  const openOAuthAuthorizationUrl = createOAuthBrowserOpener({
    platform: "linux",
    runOpenCommand: async () => assert.fail("The command must not run."),
  });

  await assert.rejects(
    openOAuthAuthorizationUrl("https://auth.openai.com/codex/device"),
    /available only on macOS and Windows/i,
  );
});

test("the Windows OAuth browser rejects untrusted system directories", async () => {
  let calls = 0;
  for (const windowsSystemRoot of [
    "",
    "Windows",
    "\\Windows",
    "\\\\server\\share\\Windows",
    "\\\\?\\C:\\Windows",
    "C:\\Temp\\..\\Windows",
    "C:\\Windows:alternate",
  ]) {
    const openOAuthAuthorizationUrl = createOAuthBrowserOpener({
      platform: "win32",
      windowsSystemRoot,
      runOpenCommand: async () => {
        calls += 1;
      },
    });
    await assert.rejects(
      openOAuthAuthorizationUrl("https://auth.openai.com/codex/device"),
      /system browser command is unavailable/i,
    );
  }
  assert.equal(calls, 0);
});

test("OAuth browser launch failures do not echo the target URL", async () => {
  const target = "https://accounts.google.com/o/oauth2/v2/auth?state=private-state";
  const openOAuthAuthorizationUrl = createOAuthBrowserOpener({
    platform: "darwin",
    runOpenCommand: async () => {
      throw new Error(`Could not open ${target}`);
    },
  });

  await assert.rejects(
    openOAuthAuthorizationUrl(target),
    (error: unknown) => {
      assert.equal(
        error instanceof Error ? error.message : String(error),
        "The OAuth browser could not be opened.",
      );
      return true;
    },
  );
});

test("OAuth browser launch preserves cancellation and passes its signal", async () => {
  const controller = new AbortController();
  const reason = new Error("Stop opening the browser.");
  let receivedSignal: AbortSignal | undefined;
  const openOAuthAuthorizationUrl = createOAuthBrowserOpener({
    platform: "darwin",
    runOpenCommand: async (_executable, _args, signal) => {
      receivedSignal = signal;
      controller.abort(reason);
      throw reason;
    },
  });

  await assert.rejects(
    openOAuthAuthorizationUrl(
      "https://auth.openai.com/codex/device",
      controller.signal,
    ),
    (error: unknown) => error === reason,
  );
  assert.equal(receivedSignal, controller.signal);
});
