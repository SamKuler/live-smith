import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowHostController } from "../../../src/app/window-hosts.js";
import type { LiveInteractionContext } from "../../../src/live/context.js";

const selected: LiveInteractionContext = {
  summary: "Track", presentation: { origin: "object", objectKind: "track", title: "Track", details: [] },
  scope: { kind: "track", identity: "track-1", label: "Track" }, target: {},
};

test("native startup is neutral, idempotent, silent, and adopts right-click context on one bridge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst3-host-"));
  const published: Array<{bridgeId: string; capability: string; port: number}> = [];
  const opened: string[] = [];
  let cleared = 0;
  let modalShown = false;
  const context = { application: { song: { handle: { id: 1n }, tracks: [], scenes: [] } },
    environment: { storageDirectory: directory },
    ui: { showModalDialog: async () => { modalShown = true; } } };
  const controller = createWindowHostController(context as never, {
    renderHtml: () => "<html></html>",
    openBrowser: async url => { opened.push(url); },
    publishVst3: async broker => {
      published.push(broker);
      return { clear: async () => { cleared++; } };
    },
  });
  try {
    await controller.start();
    await controller.start();
    assert.equal(modalShown, false);
    assert.equal(published.length, 1);
    assert.equal(opened.length, 0);
    await controller.open(selected);
    assert.equal(opened.length, 1); // Ordinary right-click still opens Smith without a VST3 editor.
    const broker = published[0]!;
    const origin = `http://127.0.0.1:${broker.port}`;
    const ticket = await (await fetch(`${origin}/vst3/tickets`, {
      method: "POST", headers: { Authorization: `Bearer ${broker.capability}` },
    })).json() as { launchUrl: string };
    const launch = await fetch(ticket.launchUrl);
    const cookie = launch.headers.get("set-cookie")!.split(";")[0]!;
    const eventsAbort = new AbortController();
    try {
      const events = await fetch(`${origin}/events`, { headers: { Cookie: cookie }, signal: eventsAbort.signal });
      assert.equal(events.status, 200);
      await controller.open(selected);
      assert.equal(opened.length, 1); // A connected VST3 editor adopts context without a browser popup.
      assert.equal(published.length, 1);
    } finally { eventsAbort.abort(); }
    context.application.song.handle.id = 2n;
    await controller.start();
    assert.equal(published.length, 2);
    assert.notEqual(published[0]!.bridgeId, published[1]!.bridgeId);
    assert.equal(cleared, 1);
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(cleared, 2);
});
