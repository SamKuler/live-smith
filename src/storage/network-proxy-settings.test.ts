import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { decodeAgentSettings } from "./settings-migrations.js";
import { loadAgentSettings, saveGlobalSettings } from "./settings.js";

const schemaV7Settings = {
  schemaVersion: 7,
  activeProfileId: null,
  profiles: [],
  approvalMode: "manual",
  defaultFollowUpBehavior: "queue",
  defaultFollowUpBehaviorRevision: "0",
  showContextUsage: true,
  contextUsageVisibilityRevision: "0",
} as const;

test("schema-v7 settings migrate without changing the existing direct route", () => {
  assert.deepEqual(decodeAgentSettings(schemaV7Settings), {
    ...schemaV7Settings,
    schemaVersion: 8,
    networkProxy: { mode: "none", url: "" },
    networkProxyRevision: "0",
  });
});

test("current network proxy settings are strict and normalize proxy origins", () => {
  const current = {
    ...schemaV7Settings,
    schemaVersion: 8,
    networkProxy: {
      mode: "manual",
      url: "  HTTPS://Proxy.Example:443/  ",
    },
    networkProxyRevision: "90071992547409931234567890",
  } as const;
  assert.deepEqual(decodeAgentSettings(current), {
    ...current,
    networkProxy: {
      mode: "manual",
      url: "https://proxy.example",
    },
  });

  for (const url of [
    "ftp://proxy.example",
    "http://user:secret@proxy.example",
    "http://proxy.example/path",
    "http://proxy.example?query=1",
    "http://proxy.example#fragment",
    `http://${"a".repeat(2_048)}.example`,
  ]) {
    assert.throws(
      () => decodeAgentSettings({
        ...current,
        networkProxy: { mode: "manual", url },
      }),
      /Network proxy/i,
    );
  }
  for (const networkProxy of [
    { mode: "manual", url: "" },
    { mode: "automatic", url: "http://proxy.example" },
    { mode: "system", url: "", extra: true },
    { mode: "system" },
    null,
  ]) {
    assert.throws(
      () => decodeAgentSettings({ ...current, networkProxy }),
      /Network proxy|does not support property/i,
    );
  }
  for (const invalid of [undefined, 0, "00", "01", "+1", " 1"] ) {
    assert.throws(
      () => decodeAgentSettings({
        ...current,
        networkProxyRevision: invalid,
      }),
      /Network proxy revision must be a canonical nonnegative decimal string/,
    );
  }
});

test("global network proxy patches normalize values and increment only their revision", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-network-proxy-settings-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const manual = await saveGlobalSettings(directory, {
    networkProxy: {
      mode: "manual",
      url: "https://Proxy.Example:443/",
    },
  });
  assert.deepEqual(manual.networkProxy, {
    mode: "manual",
    url: "https://proxy.example",
  });
  assert.equal(manual.networkProxyRevision, "1");
  assert.equal(manual.defaultFollowUpBehaviorRevision, "0");
  assert.equal(manual.contextUsageVisibilityRevision, "0");

  const disabled = await saveGlobalSettings(directory, {
    networkProxy: {
      mode: "none",
      url: "socks5://proxy.example:1080",
    },
  });
  assert.deepEqual(disabled.networkProxy, {
    mode: "none",
    url: "socks5://proxy.example:1080",
  });
  assert.equal(disabled.networkProxyRevision, "2");
  assert.deepEqual((await loadAgentSettings(directory)).networkProxy, disabled.networkProxy);

  for (const invalid of [
    {},
    {
      networkProxy: { mode: "system", url: "" },
      showContextUsage: false,
    },
    { networkProxy: { mode: "manual", url: "" } },
    { networkProxy: { mode: "system", url: "", extra: true } },
  ]) {
    await assert.rejects(
      saveGlobalSettings(directory, invalid as never),
      /exactly one setting|Network proxy|does not support property/i,
    );
  }
});
