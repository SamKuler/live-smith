import assert from "node:assert/strict";
import test from "node:test";

import type { SavedProfile } from "../model/profile.js";
import {
  capabilities,
  commandCalls,
  createDialogHarness,
  modelStateSourceFixture,
  pendingAudio,
  pendingDocument,
  pendingImage,
  profileFixture,
  stateFixture,
} from "./chat-dialog.test-harness.js";

function subscriptionProfile(): SavedProfile {
  return profileFixture({
    connection: { kind: "codex-subscription", provider: "openai" },
    parameters: {
      maxOutputTokens: 8192,
      reasoning: { mode: "default" },
    },
    advanced: {},
  });
}

function submitFromComposer(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
): void {
  harness.document.querySelector("#prompt")?.dispatchEvent(
    new harness.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "Enter",
    }),
  );
}

test("connection selection separates Direct API from experimental ChatGPT subscription", async () => {
  const state = stateFixture();
  state.capabilities = {
    ...capabilities(),
    reasoning: {
      supported: true,
      canDisable: true,
      efforts: ["high"],
      budgetTokens: true,
      strategy: "budget-thinking",
    },
  };
  const harness = await createDialogHarness(state);
  try {
    assert.equal(harness.document.querySelector<HTMLElement>("#directApiFields")?.hidden, false);
    assert.equal(harness.document.querySelector<HTMLElement>("#codexAuthPanel")?.hidden, true);

    harness.select("#apiFamily", "anthropic");
    assert.equal(
      harness.document.querySelector<HTMLElement>("#anthropicSubscriptionHint")?.hidden,
      false,
    );
    assert.match(
      harness.document.querySelector("#anthropicSubscriptionHint")?.textContent ?? "",
      /subscription login is not supported.*prior written approval/i,
    );

    harness.select("#apiFamily", "openai");
    harness.select("#apiMode", "responses");
    harness.input("#temperature", "0.8");
    harness.select("#reasoningMode", "disabled");
    harness.input("#reasoningBudgetTokens", "4096");
    harness.click("#webSearchEnabled");
    harness.select("#overrideInputImage", "true");
    harness.input("#extraBody", '{"custom":true}');

    harness.select("#connectionKind", "codex-subscription");

    assert.equal(harness.document.querySelector<HTMLElement>("#directApiFields")?.hidden, true);
    assert.equal(harness.document.querySelector<HTMLElement>("#codexAuthPanel")?.hidden, false);
    assert.equal(harness.document.querySelector<HTMLDetailsElement>("#advancedSettings")?.hidden, true);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#temperature")?.value, "");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#temperature")?.disabled, true);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.value, "8192");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.disabled, true);
    assert.match(
      harness.document.querySelector("#maxOutputTokensHint")?.textContent ?? "",
      /App Server owns the output limit/i,
    );
    assert.equal(harness.document.querySelector<HTMLInputElement>("#reasoningBudgetTokens")?.value, "");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#reasoningBudgetTokens")?.disabled, true);
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#reasoningMode")?.value, "default");
    assert.equal(
      [...harness.document.querySelectorAll<HTMLOptionElement>("#reasoningMode option")]
        .some((option) => option.value === "disabled"),
      false,
    );
    assert.equal(harness.document.querySelector<HTMLInputElement>("#webSearchEnabled")?.checked, false);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#webSearchEnabled")?.disabled, true);
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#overrideInputImage")?.value, "inherit");
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#overrideInputImage")?.disabled, true);
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#extraBody")?.value, "");
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#extraBody")?.disabled, true);
    assert.match(
      harness.document.querySelector("#codexAuthPanel")?.textContent ?? "",
      /Codex CLI 0\.148\.x.*experimental.*No API key fallback/is,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("subscription model discovery and Save use only the managed connection contract", async () => {
  const harness = await createDialogHarness();
  try {
    harness.select("#connectionKind", "codex-subscription");
    harness.click("#discoverModelsButton");
    await harness.settle();

    const discovery = commandCalls(harness).at(-1)?.body as {
      kind: string;
      profile: SavedProfile;
    };
    assert.equal(discovery.kind, "discover_models");
    assert.deepEqual(discovery.profile.connection, {
      kind: "codex-subscription",
      provider: "openai",
    });
    assert.deepEqual(discovery.profile.advanced, {});
    assert.deepEqual(discovery.profile.parameters, {
      maxOutputTokens: 8192,
      reasoning: { mode: "default" },
    });
    assert.equal("apiKey" in discovery.profile, false);

    harness.input("#model", "model-discovered");
    harness.click("#saveProfileButton");
    await harness.settle();

    const saved = commandCalls(harness).at(-1)?.body as {
      kind: string;
      profile: SavedProfile;
    };
    assert.equal(saved.kind, "save_profile");
    assert.deepEqual(saved.profile.connection, {
      kind: "codex-subscription",
      provider: "openai",
    });
    assert.deepEqual(saved.profile.advanced, {});
    assert.deepEqual(saved.profile.parameters, {
      maxOutputTokens: 8192,
      reasoning: { mode: "default" },
    });
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("device-code login controls send strict commands and render backend state safely", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.codexAuth = { status: "signed-out" };
  const harness = await createDialogHarness(state);
  try {
    const panel = harness.document.querySelector<HTMLElement>("#codexAuthPanel");
    const signIn = harness.document.querySelector<HTMLButtonElement>(
      "#codexSignInButton",
    );
    const check = harness.document.querySelector<HTMLButtonElement>(
      "#codexCheckAccountButton",
    );
    const logout = harness.document.querySelector<HTMLButtonElement>(
      "#codexLogoutButton",
    );
    assert.equal(
      harness.document.querySelector("#codexAuthHeading")?.tagName,
      "H3",
    );
    assert.equal(
      harness.document.querySelector("#codexAuthState")?.getAttribute("role"),
      "status",
    );
    assert.equal(
      harness.document.querySelector("#codexAuthState")?.getAttribute("aria-atomic"),
      "true",
    );
    assert.equal(panel?.dataset.authState, "signed-out");
    assert.equal(
      harness.document.querySelector("#codexAuthStateBadge")?.textContent,
      "Signed out",
    );
    assert.match(
      harness.document.querySelector(".subscription-auth-state-title")?.textContent ?? "",
      /sign in to continue/i,
    );
    assert.equal(signIn?.classList.contains("primary"), true);
    assert.equal(signIn?.hidden, false);
    assert.equal(check?.textContent, "Check account");
    assert.equal(logout?.hidden, true);

    harness.holdNextCommand();
    signIn?.focus();
    harness.click("#codexSignInButton");
    await Promise.resolve();
    harness.document.body.tabIndex = -1;
    harness.document.body.focus();
    assert.equal(harness.document.activeElement, harness.document.body);
    harness.releaseHeldCommand();
    await harness.settle();

    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: { kind: "start_codex_login" },
    });
    const link = harness.document.querySelector<HTMLAnchorElement>("#codexAuthStatus a");
    assert.equal(link?.href, "https://auth.openai.com/codex/device");
    assert.equal(link?.target, "_blank");
    assert.match(link?.rel ?? "", /\bnoopener\b/);
    assert.match(link?.rel ?? "", /\bnoreferrer\b/);
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#codexUserCode")?.value,
      "ABCD-EFGH",
    );
    assert.equal(panel?.dataset.authState, "pending");
    assert.equal(
      harness.document.querySelector("#codexAuthStateBadge")?.textContent,
      "Waiting",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#codexDeviceCodeTicket")?.hidden,
      false,
    );
    assert.match(link?.textContent ?? "", /open OpenAI sign-in page/i);
    assert.equal(signIn?.hidden, true);
    assert.equal(check?.textContent, "Check sign-in");
    assert.equal(check?.classList.contains("primary"), true);
    assert.equal(logout?.textContent, "Cancel sign-in");
    assert.equal(logout?.dataset.busyLabel, "Cancelling…");
    assert.equal(logout?.hidden, false);
    assert.equal(harness.document.activeElement, link);
    assert.equal(
      harness.document.querySelector("#codexAuthState a"),
      null,
      "the polite status region must not contain interactive controls",
    );

    harness.click("#codexCheckAccountButton");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: { kind: "refresh_codex_account" },
    });
    assert.match(
      harness.document.querySelector("#codexAuthStatus")?.textContent ?? "",
      /studio@example\.test \(pro\)/i,
    );
    assert.equal(panel?.dataset.authState, "signed-in");
    assert.equal(
      harness.document.querySelector("#codexAuthStateBadge")?.textContent,
      "Connected",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#codexDeviceCodeTicket")?.hidden,
      true,
    );
    assert.equal(check?.textContent, "Refresh account");
    assert.equal(logout?.textContent, "Sign out");
    assert.equal(logout?.dataset.busyLabel, "");

    logout?.focus();
    harness.click("#codexLogoutButton");
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: { kind: "refresh_codex_account" },
    });
    assert.match(
      harness.document.querySelector("#appConfirmation")?.textContent ?? "",
      /Sign out of ChatGPT.*pending device login/is,
    );
    await harness.cancelAppConfirmation();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: { kind: "refresh_codex_account" },
    });

    harness.click("#codexLogoutButton");
    harness.document.querySelector<HTMLButtonElement>("#appConfirmationCancel")
      ?.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    await Promise.resolve();
    assert.equal(
      harness.document.querySelector<HTMLElement>("#appConfirmation")?.hidden,
      true,
    );
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: { kind: "refresh_codex_account" },
    });

    harness.holdNextCommand();
    harness.click("#codexLogoutButton");
    await harness.acceptAppConfirmation();
    assert.equal(logout?.textContent, "Signing out…");
    harness.document.body.focus();
    assert.equal(harness.document.activeElement, harness.document.body);
    harness.releaseHeldCommand();
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: { kind: "logout_codex" },
    });
    assert.match(
      harness.document.querySelector("#codexAuthStatus")?.textContent ?? "",
      /sign in to continue.*eligible ChatGPT/is,
    );
    assert.equal(panel?.dataset.authState, "signed-out");
    assert.equal(signIn?.hidden, false);
    assert.equal(logout?.hidden, true);
    assert.equal(harness.document.activeElement, signIn);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("pending sign-in cancellation restores its action after a failed command", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.codexAuth = {
    status: "pending",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
  };
  const harness = await createDialogHarness(state);
  try {
    const logout = harness.document.querySelector<HTMLButtonElement>(
      "#codexLogoutButton",
    );
    const link = harness.document.querySelector<HTMLAnchorElement>(
      "#codexVerificationLink",
    );
    harness.failNextCommand("Could not cancel sign-in");
    harness.holdNextCommand();
    logout?.focus();
    harness.click("#codexLogoutButton");
    await harness.acceptAppConfirmation();

    assert.equal(logout?.textContent, "Cancelling…");
    harness.document.body.tabIndex = -1;
    harness.document.body.focus();
    harness.releaseHeldCommand();
    await harness.settle();

    assert.equal(logout?.textContent, "Cancel sign-in");
    assert.equal(logout?.disabled, false);
    assert.equal(harness.document.activeElement, link);
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /could not cancel sign-in/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("device-code values are text-only and unsafe backend URLs are not links", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.codexAuth = {
    status: "pending",
    verificationUrl: "javascript:alert(1)",
    userCode: '<img src=x onerror="alert(1)">',
  };
  const harness = await createDialogHarness(state);
  try {
    const status = harness.document.querySelector("#codexAuthStatus");
    const link = status?.querySelector<HTMLAnchorElement>("#codexVerificationLink");
    assert.equal(link?.hidden, true);
    assert.equal(link?.hasAttribute("href"), false);
    assert.equal(status?.querySelector("img"), null);
    assert.equal(
      status?.querySelector<HTMLInputElement>("#codexUserCode")?.value,
      '<img src=x onerror="alert(1)">',
    );
    assert.doesNotMatch(status?.textContent ?? "", /javascript:alert\(1\)/);
    assert.match(status?.textContent ?? "", /could not verify the sign-in page/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("device-code links are limited to the verified OpenAI HTTPS host", async () => {
  for (const verificationUrl of [
    "http://auth.openai.com/codex/device",
    "https://example.test/codex/device",
    "https://user@auth.openai.com/codex/device",
  ]) {
    const state = stateFixture();
    const profile = subscriptionProfile();
    state.settings.profiles = [profile];
    state.settings.activeProfileId = profile.id;
    state.modelStateSource = modelStateSourceFixture(profile);
    state.codexAuth = {
      status: "pending",
      verificationUrl,
      userCode: "ABCD-EFGH",
    };
    const harness = await createDialogHarness(state);
    try {
      const link = harness.document.querySelector<HTMLAnchorElement>(
        "#codexVerificationLink",
      );
      assert.equal(link?.hidden, true);
      assert.equal(link?.hasAttribute("href"), false);
      assert.doesNotMatch(
        harness.document.querySelector("#codexAuthStatus")?.textContent ?? "",
        new RegExp(verificationUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      assert.match(
        harness.document.querySelector("#codexAuthStatus")?.textContent ?? "",
        /could not verify the sign-in page/i,
      );
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  }
});

test("global follow-up saves and events preserve pending credential-free auth state", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.codexAuth = {
    status: "pending",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
  };
  const harness = await createDialogHarness(state);
  try {
    harness.select("#defaultFollowUpBehavior", "steer");
    await harness.settle();

    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "save_global_settings",
        defaultFollowUpBehavior: "steer",
      },
    });
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#codexUserCode")?.value,
      "ABCD-EFGH",
    );

    harness.emitServerEvent({
      type: "default_follow_up_behavior_changed",
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "2",
      commandId: "other-dialog-save",
    });
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#codexUserCode")?.value,
      "ABCD-EFGH",
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>(
        "#defaultFollowUpBehavior",
      )?.value,
      "queue",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Apply confirmation locks Profile and auth controls but permits follow-up saves", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.codexAuth = {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Prepare a protected Live change");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "subscription-confirm",
      message: "Apply the proposed changes?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });

    for (const selector of [
      "#profileName",
      "#connectionKind",
      "#saveProfileButton",
      "#codexSignInButton",
      "#codexCheckAccountButton",
      "#codexLogoutButton",
    ]) {
      assert.equal(
        harness.document.querySelector<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
          selector,
        )?.disabled,
        true,
        selector,
      );
    }
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>(
        "#defaultFollowUpBehavior",
      )?.disabled,
      false,
    );

    harness.select("#defaultFollowUpBehavior", "steer");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "save_global_settings",
        defaultFollowUpBehavior: "steer",
      },
    });
    assert.ok(harness.document.querySelector(".confirm-card"));
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>(
        "#codexCheckAccountButton",
      )?.disabled,
      true,
    );
    assert.match(
      harness.document.querySelector("#codexAuthStatus")?.textContent ?? "",
      /studio@example\.test \(pro\)/i,
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("clean subscription Profiles disable Send until an eligible account is signed in", async () => {
  const cases = [
    {
      auth: { status: "signed-out" } as const,
      badge: "Signed out",
      checkLabel: "Check account",
      logoutHidden: true,
      message: /sign in to ChatGPT before sending/i,
      panelState: "signed-out",
      signInHidden: false,
      title: /sign in to continue/i,
    },
    {
      auth: {
        status: "pending",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      } as const,
      badge: "Waiting",
      checkLabel: "Check sign-in",
      logoutHidden: false,
      message: /complete ChatGPT sign-in before sending/i,
      panelState: "pending",
      signInHidden: true,
      title: /finish sign-in/i,
    },
    {
      auth: {
        status: "unavailable",
        message: "Codex App Server is unavailable.",
      } as const,
      badge: "Unavailable",
      checkLabel: "Check again",
      logoutHidden: true,
      message: /ChatGPT subscription is unavailable/i,
      panelState: "unavailable",
      signInHidden: true,
      title: /subscription unavailable/i,
    },
    {
      auth: {
        status: "signed-in",
        accountLabel: "managed@example.test",
        planType: "business",
        subscriptionEligible: false,
      } as const,
      badge: "Not eligible",
      checkLabel: "Refresh account",
      logoutHidden: false,
      message: /account is not eligible for subscription requests/i,
      panelState: "ineligible",
      signInHidden: true,
      title: /account isn.t supported/i,
    },
  ];

  for (const entry of cases) {
    const state = stateFixture();
    const profile = subscriptionProfile();
    state.settings.profiles = [profile];
    state.settings.activeProfileId = profile.id;
    state.modelStateSource = modelStateSourceFixture(profile);
    state.codexAuth = entry.auth;
    const harness = await createDialogHarness(state);
    try {
      const send = harness.document.querySelector<HTMLButtonElement>("#sendButton");
      assert.equal(
        harness.document.querySelector<HTMLElement>("#codexAuthPanel")?.dataset.authState,
        entry.panelState,
      );
      assert.equal(
        harness.document.querySelector("#codexAuthStateBadge")?.textContent,
        entry.badge,
      );
      assert.match(
        harness.document.querySelector("#codexAuthStateLabel")?.textContent ?? "",
        entry.title,
      );
      assert.equal(
        harness.document.querySelector<HTMLButtonElement>("#codexSignInButton")?.hidden,
        entry.signInHidden,
      );
      assert.equal(
        harness.document.querySelector("#codexCheckAccountButton")?.textContent,
        entry.checkLabel,
      );
      assert.equal(
        harness.document.querySelector<HTMLButtonElement>("#codexLogoutButton")?.hidden,
        entry.logoutHidden,
      );
      assert.equal(send?.disabled, true, entry.auth.status);
      assert.match(send?.title ?? "", entry.message);
      assert.match(
        harness.document.querySelector("#status")?.textContent ?? "",
        entry.message,
      );
      harness.input("#prompt", `Blocked ${entry.auth.status} subscription request`);
      submitFromComposer(harness);
      await harness.settle();
      assert.equal(
        harness.calls.some((call) => call.path === "/send"),
        false,
        entry.auth.status,
      );
      assert.equal(
        harness.document.querySelector("#status")?.textContent,
        send?.title,
        entry.auth.status,
      );
      if (entry.auth.status === "signed-in") {
        assert.match(
          harness.document.querySelector("#codexAuthStatus")?.textContent ?? "",
          /workspace-managed.*supported.*sign out.*personal/i,
        );
        assert.equal(
          harness.document.querySelector<HTMLButtonElement>(
            "#codexCheckAccountButton",
          )?.disabled,
          false,
        );
        assert.equal(
          harness.document.querySelector<HTMLButtonElement>(
            "#codexLogoutButton",
          )?.disabled,
          false,
        );
      }
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  }
});

test("clean subscription Profiles enable Send for an eligible signed-in account", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.codexAuth = {
    status: "signed-in",
    accountLabel: '<img src=x onerror="alert(1)">',
    planType: "pro",
    subscriptionEligible: true,
  };
  const harness = await createDialogHarness(state);
  try {
    assert.equal(harness.document.querySelector("#codexAuthStatus img"), null);
    assert.match(
      harness.document.querySelector("#codexAuthStatus")?.textContent ?? "",
      /<img src=x onerror="alert\(1\)">/,
    );
    const send = harness.document.querySelector<HTMLButtonElement>("#sendButton");
    assert.equal(send?.disabled, false);
    assert.equal(send?.title, "");
    harness.input("#prompt", "Send through the eligible subscription");
    submitFromComposer(harness);
    await harness.settle();
    assert.equal(
      harness.calls.filter((call) => call.path === "/send").length,
      1,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("clean Direct API Profiles keep the composer shortcut available", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
    harness.input("#prompt", "Send through the direct API");
    submitFromComposer(harness);
    await harness.settle();

    assert.equal(
      harness.calls.filter((call) => call.path === "/send").length,
      1,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("verified subscription image and audio inputs are sendable while PDF stays disabled", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.codexAuth = {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  state.runtimeProfile = {
    profile: {
      id: profile.id,
      name: profile.name,
      connectionKind: "codex-subscription",
      apiFamily: "openai",
      apiMode: null,
      model: profile.model,
    },
    capabilities: {
      ...capabilities(),
      inputs: { image: true, audio: true, pdf: true },
    },
    inputCapabilityEvidence: {
      image: "supported",
      audio: "supported",
      pdf: "supported",
    },
  };
  state.pendingAttachments = [
    pendingImage("image-1", "cover.png"),
    pendingAudio("audio-1", "mix.wav"),
  ];
  const supportedHarness = await createDialogHarness(state);
  try {
    supportedHarness.input("#prompt", "Review these inputs");
    supportedHarness.click("#sendButton");
    await supportedHarness.settle();
    assert.equal(
      supportedHarness.calls.filter((call) => call.path === "/send").length,
      1,
    );
    assert.deepEqual(supportedHarness.errors, []);
  } finally {
    supportedHarness.close();
  }

  state.pendingAttachments = [pendingDocument("pdf-1", "score.pdf", "application/pdf")];
  const pdfHarness = await createDialogHarness(state);
  try {
    pdfHarness.input("#prompt", "Review the PDF");
    pdfHarness.click("#sendButton");
    await pdfHarness.settle();
    assert.equal(pdfHarness.calls.some((call) => call.path === "/send"), false);
    assert.match(
      pdfHarness.document.querySelector("#status")?.textContent ?? "",
      /PDF attachments require verified PDF input support with OpenAI Responses or Anthropic Messages/i,
    );
    assert.deepEqual(pdfHarness.errors, []);
  } finally {
    pdfHarness.close();
  }
});
