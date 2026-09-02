import assert from "node:assert/strict";
import test from "node:test";

import {
  commandCalls,
  createDialogHarness,
  stateFixture,
} from "./chat-dialog.test-harness.js";

type ProxyMode = "none" | "system" | "manual";

function proxyModeControl(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
  mode: ProxyMode,
): HTMLInputElement {
  const control = harness.document.querySelector<HTMLInputElement>(
    `input[name="networkProxyMode"][value="${mode}"]`,
  );
  assert.ok(control, `Expected the ${mode} proxy mode control.`);
  return control;
}

function chooseProxyMode(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
  mode: ProxyMode,
): void {
  const control = proxyModeControl(harness, mode);
  control.checked = true;
  control.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
}

function selectedProxyMode(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
): string | undefined {
  return harness.document.querySelector<HTMLInputElement>(
    'input[name="networkProxyMode"]:checked',
  )?.value;
}

function proxyCommands(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
): Array<Record<string, unknown>> {
  return commandCalls(harness)
    .map((call) => call.body as Record<string, unknown>)
    .filter((body) =>
      body.kind === "save_global_settings" && body.networkProxy !== undefined
    );
}

test("Network settings expose explicit no, system, and manual proxy modes", async () => {
  const harness = await createDialogHarness();
  try {
    const mode = harness.document.querySelector<HTMLFieldSetElement>(
      "#networkProxyMode",
    );
    const urlField = harness.document.querySelector<HTMLElement>(
      "#networkProxyUrlField",
    );
    const url = harness.document.querySelector<HTMLInputElement>(
      "#networkProxyUrl",
    );
    assert.equal(mode?.tagName, "FIELDSET");
    const routeHint = harness.document.querySelector<HTMLElement>("#networkProxyHint");
    assert.equal(routeHint?.classList.contains("network-proxy-route-hint"), false);
    assert.equal(mode?.getAttribute("aria-describedby"), null);
    assert.equal(routeHint?.hidden, true);
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLInputElement>(
        'input[name="networkProxyMode"]',
      )].map((control) => control.value),
      ["none", "system", "manual"],
    );
    assert.equal(selectedProxyMode(harness), "none");
    assert.equal(urlField?.hidden, true);
    const apply = harness.document.querySelector<HTMLButtonElement>(
      "#applyNetworkProxyButton",
    );
    assert.equal(apply?.disabled, true);
    assert.equal(apply?.dataset.busyLabel, "Applying…");
    assert.ok(apply?.closest(".network-proxy-commit"));

    const manual = proxyModeControl(harness, "manual");
    manual.focus();
    chooseProxyMode(harness, "manual");
    await harness.settle();
    assert.equal(urlField?.hidden, false);
    assert.equal(routeHint?.hidden, false);
    assert.equal(mode?.getAttribute("aria-describedby"), "networkProxyHint");
    assert.match(routeHint?.textContent ?? "", /local endpoints.*direct/i);
    assert.equal(harness.document.activeElement, manual);
    assert.deepEqual(proxyCommands(harness), []);
    assert.equal(apply?.disabled, false);

    if (url) {
      url.value = "http://127.0.0.1:10808";
      url.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
    }
    harness.click("#applyNetworkProxyButton");
    await harness.settle();
    assert.deepEqual(proxyCommands(harness).at(-1), {
      kind: "save_global_settings",
      networkProxy: {
        mode: "manual",
        url: "http://127.0.0.1:10808",
      },
    });
    assert.equal(apply?.disabled, true);
    harness.click("#applyNetworkProxyButton");
    await harness.settle();
    assert.equal(proxyCommands(harness).length, 1);

    chooseProxyMode(harness, "system");
    assert.equal(proxyCommands(harness).length, 1);
    harness.click("#applyNetworkProxyButton");
    await harness.settle();
    assert.deepEqual(proxyCommands(harness).at(-1), {
      kind: "save_global_settings",
      networkProxy: {
        mode: "system",
        url: "http://127.0.0.1:10808",
      },
    });
    assert.equal(urlField?.hidden, true);
    assert.match(routeHint?.textContent ?? "", /macOS.*no PAC\/WPAD/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a peer Network setting is adopted by its independent revision", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  try {
    harness.click("#contextTab");
    chooseProxyMode(harness, "manual");
    harness.input("#networkProxyUrl", "ftp://stale.example:21");
    harness.failNextCommand(
      "Network proxy URL must use HTTP, HTTPS, SOCKS, or SOCKS5.",
      "networkProxy.url",
    );
    harness.click("#applyNetworkProxyButton");
    await harness.settle();
    assert.equal(harness.document.activeElement?.id, "networkProxyUrl");
    assert.ok(harness.document.querySelector("#networkProxyUrlError"));
    assert.equal(
      harness.document.querySelector("#appTab")?.getAttribute("aria-selected"),
      "true",
    );
    assert.equal(harness.document.querySelector<HTMLElement>("#appPanel")?.hidden, false);

    harness.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision:
        state.settings.defaultFollowUpBehaviorRevision,
      showContextUsage: state.settings.showContextUsage,
      contextUsageVisibilityRevision:
        state.settings.contextUsageVisibilityRevision,
      networkProxy: {
        mode: "manual",
        url: "socks5://proxy.example:1080",
      },
      networkProxyRevision: "1",
      commandId: "peer-network-proxy",
    });
    await harness.settle();

    assert.equal(
      selectedProxyMode(harness),
      "manual",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#networkProxyUrl")
        ?.value,
      "socks5://proxy.example:1080",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#networkProxyUrlField")
        ?.hidden,
      false,
    );
    assert.equal(
      harness.document.querySelector("#networkProxyUrlError"),
      null,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>(
        "#applyNetworkProxyButton",
      )?.disabled,
      true,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("applying Network settings preserves unrelated Profile field errors", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Local Profile edit");
    harness.failNextCommand("Profile name needs review.", "name");
    harness.click("#saveProfileButton");
    await harness.settle();
    assert.match(
      harness.document.querySelector("#profileNameError")?.textContent ?? "",
      /needs review/,
    );

    chooseProxyMode(harness, "manual");
    harness.input("#networkProxyUrl", "ftp://proxy.example:21");
    harness.failNextCommand(
      "Network proxy URL must use HTTP, HTTPS, SOCKS, or SOCKS5.",
      "networkProxy.url",
    );
    harness.click("#applyNetworkProxyButton");
    await harness.settle();

    assert.match(
      harness.document.querySelector("#profileNameError")?.textContent ?? "",
      /needs review/,
    );
    assert.match(
      harness.document.querySelector("#networkProxyUrlError")?.textContent ??
        "",
      /must use HTTP, HTTPS, SOCKS, or SOCKS5/,
    );
    assert.equal(proxyCommands(harness).length, 1);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a rejected Manual proxy keeps its draft and clears its field error after retry", async () => {
  const harness = await createDialogHarness();
  try {
    chooseProxyMode(harness, "manual");
    const url = harness.document.querySelector<HTMLInputElement>(
      "#networkProxyUrl",
    );
    harness.failNextCommand(
      "Network proxy URL must use HTTP, HTTPS, SOCKS, or SOCKS5.",
      "networkProxy.url",
    );
    if (url) {
      url.value = "ftp://proxy.example:21";
      url.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
    }
    harness.click("#applyNetworkProxyButton");
    await harness.settle();

    assert.equal(
      selectedProxyMode(harness),
      "manual",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#networkProxyUrlField")
        ?.hidden,
      false,
    );
    assert.equal(url?.value, "ftp://proxy.example:21");
    assert.equal(url?.getAttribute("aria-invalid"), "true");
    assert.match(
      harness.document.querySelector("#networkProxyUrlError")?.textContent ?? "",
      /must use HTTP, HTTPS, SOCKS, or SOCKS5/,
    );
    assert.equal(harness.document.querySelector("#status")?.textContent, "");

    if (url) {
      url.value = "http://127.0.0.1:10808";
      url.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
    }
    harness.click("#applyNetworkProxyButton");
    await harness.settle();
    assert.equal(url?.hasAttribute("aria-invalid"), false);
    assert.equal(
      harness.document.querySelector("#networkProxyUrlError"),
      null,
    );
    assert.deepEqual(proxyCommands(harness).at(-1), {
      kind: "save_global_settings",
      networkProxy: {
        mode: "manual",
        url: "http://127.0.0.1:10808",
      },
    });
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Network controls lock while their save is unresolved", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextCommand();
    chooseProxyMode(harness, "system");
    const apply = harness.document.querySelector<HTMLButtonElement>(
      "#applyNetworkProxyButton",
    );
    apply?.focus();
    harness.click("#applyNetworkProxyButton");
    assert.equal(
      harness.document.querySelector<HTMLFieldSetElement>("#networkProxyMode")
        ?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>(
        "#applyNetworkProxyButton",
      )?.disabled,
      true,
    );
    assert.equal(apply?.textContent, "Applying…");
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#networkProxyUrl")
        ?.disabled,
      true,
    );

    harness.releaseHeldCommand();
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLFieldSetElement>("#networkProxyMode")
        ?.disabled,
      false,
    );
    assert.equal(apply?.textContent, "Apply Proxy");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
