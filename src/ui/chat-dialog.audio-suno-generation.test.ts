import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness } from "./chat-dialog.test-harness.js";
import { audioState, audioCommands, toggle, job } from "./chat-dialog.audio-test-helpers.js";

const website = { id: "suno-personal", name: "Personal Suno", provider: "suno" as const, enabled: false, apiKeyConfigured: false };

test("connected Suno can explicitly enable and save music tools without API key or Cookie in the settings command", async () => {
  const state = { ...audioState([website]), sunoAccounts: [{ serviceId: website.id, status: "signed_in" as const, accountId: "user_personal" }] };
  const harness = await createDialogHarness(state);
  try {
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceEnabled")!.checked, false);
    assert.equal(harness.document.querySelector(".audio-service-status")!.textContent, "Disabled");
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceKeyField")!.hidden, true);
    toggle(harness, true);
    harness.input("#audioServiceModel", "chirp-account-model");
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    const command = audioCommands(harness)[0]!;
    assert.deepEqual(command, { kind: "save_global_settings", integrationConnections: {
      action: "upsert", expectedRevision: "1", connection: {
        id: website.id,
        name: website.name,
        pluginId: "live-smith.suno-website",
        enabled: true,
        configuration: { modelId: "chirp-account-model" },
      },
    } });
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceEnabled")!.checked, true);
    assert.equal(harness.document.querySelector(".audio-service-status")!.textContent, "Ready");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceModel")!.value, "chirp-account-model");
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, true);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

for (const operation of ["generate_music", "extend_music", "get_whole_song"] as const) {
  test(`Suno ${operation} results render locally and keep native-provider ownership`, async () => {
    const state = audioState([{ ...website, enabled: true }]);
    const base = job(state.activeSessionId!, { serviceId: website.id, provider: "suno", operation, stems: [], status: "completed", resumable: false });
    base.outputs = [{ ...base.outputs[0]!, role: "music", label: "Song result", origin: { kind: "generated" } }];
    state.audioJobs = [base];
    const harness = await createDialogHarness(state);
    try {
      const player = harness.document.querySelector<HTMLAudioElement>("#audioJobs audio")!;
      assert.ok(player);
      assert.match(player.src, /\/audio-assets\/asset-one/);
      assert.doesNotMatch(player.src, /suno\.ai|suno\.com|token=.*__client/);
      assert.match(harness.document.querySelector("#audioJobs")!.textContent!, /Personal Suno.*Suno.com/);
      assert.equal(harness.document.querySelector<HTMLButtonElement>("#audioServiceEnabled")!.disabled, false);
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); }
  });
}
