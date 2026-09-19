import assert from "node:assert/strict";
import test from "node:test";
import type { AudioServiceConnectionView } from "../audio-services/contracts.js";
import type { SunoAccountView } from "../audio-services/suno-session-contracts.js";
import { commandCalls, createDialogHarness } from "./chat-dialog.test-harness.js";
import {
  audioState,
  broadcast,
  integrationConnectionView,
  musicService,
  selectAudioService,
  selectedAudioService,
} from "./chat-dialog.audio-test-helpers.js";

const website: AudioServiceConnectionView = {
  id: "suno-personal", name: "Personal Suno", provider: "suno", enabled: false, apiKeyConfigured: false,
};
const secondWebsite = { ...website, id: "suno-work", name: "Work Suno" };
function websiteState(status: SunoAccountView["status"] = "signed_out") {
  return { ...audioState([website, secondWebsite, musicService]), sunoAccounts: [
    { serviceId: website.id, status, ...(["signed_in", "saved"].includes(status)
      ? { accountId: "user_personal", accountName: "Personal musician" } : {}) },
    { serviceId: secondWebsite.id, status: "saved" as const },
  ] };
}
type Harness = Awaited<ReturnType<typeof createDialogHarness>>;
const text = (harness: Harness, selector: string) => harness.document.querySelector(selector)!.textContent!;
const disabled = (harness: Harness, selector: string) => harness.document.querySelector<HTMLButtonElement>(selector)!.disabled;

test("Suno uses the shared account surface and keeps model settings separate", async () => {
  const harness = await createDialogHarness(websiteState("signed_in"));
  try {
    const panel = harness.document.querySelector<HTMLElement>("#sunoLoginControls")!;
    assert.equal(panel.classList.contains("connection-auth-panel"), true);
    assert.equal(panel.dataset.authState, "signed-in");
    assert.equal(panel.querySelector(".connection-auth-state-badge")?.textContent, "Connected");
    assert.equal(panel.querySelector(".connection-auth-state-title")?.id, "sunoLoginStatus");
    assert.equal(panel.querySelector(".connection-auth-state-detail")?.id, "sunoAccountName");
    const clearCookie = harness.document.querySelector("#logoutSunoButton")!;
    assert.equal(panel.querySelector("#sunoCookieEditor")?.contains(clearCookie), true);
    assert.equal(panel.querySelector(".connection-auth-actions")?.contains(clearCookie), false);
    assert.equal(panel.contains(harness.document.querySelector("#sunoModelSelection")), false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("refresh permits saved or unavailable sessions while only authoritative status establishes connection", async () => {
  for (const status of ["signed_out", "saved", "signed_in", "expired", "unavailable"] as const) {
    const harness = await createDialogHarness(websiteState(status));
    try {
      const canRefresh = ["saved", "signed_in", "expired", "unavailable"].includes(status);
      assert.equal(disabled(harness, "#refreshSunoLoginButton"), !canRefresh, status);
      assert.equal(harness.document.querySelector<HTMLElement>("#refreshSunoLoginButton")!.hidden, !canRefresh, status);
      assert.equal(harness.document.querySelector<HTMLElement>("#sunoLoginControls")!.dataset.authState, {
        signed_out: "signed-out", saved: "pending", signed_in: "signed-in",
        expired: "unavailable", unavailable: "unavailable",
      }[status], status);
      assert.equal(text(harness, "#sunoAuthStateBadge"), {
        signed_out: "Signed out", saved: "Waiting", signed_in: "Connected",
        expired: "Needs setup", unavailable: "Unavailable",
      }[status], status);
      assert.equal(harness.document.querySelector("#openSunoWebsiteButton")!.classList.contains("primary"),
        status === "signed_out", status);
      assert.equal(harness.document.querySelector("#refreshSunoLoginButton")!.classList.contains("primary"),
        ["saved", "expired", "unavailable"].includes(status), status);
      assert.equal(text(harness, "#sunoAccountName"), ["saved", "signed_in"].includes(status)
        ? "Suno account: Personal musician" : "");
      assert.doesNotMatch(text(harness, "body"), /user_personal/);
      harness.click("#refreshSunoLoginButton");
      await harness.settle();
      assert.equal(commandCalls(harness).length, canRefresh ? 1 : 0);
      assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceEnabled")!.checked, false);
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); }
  }
});

test("a delayed refresh keeps selection, other drafts and the correct account intact", async () => {
  const harness = await createDialogHarness(websiteState("saved"));
  try {
    selectAudioService(harness, musicService.id);
    harness.input("#audioServiceName", "Unfinished music name");
    selectAudioService(harness, website.id);
    harness.holdNextCommand();
    harness.click("#refreshSunoLoginButton");
    selectAudioService(harness, secondWebsite.id);
    assert.equal(selectedAudioService(harness), secondWebsite.id);
    harness.setServerState(websiteState("signed_in"));
    harness.releaseHeldCommand();
    await harness.settle();
    assert.equal(selectedAudioService(harness), secondWebsite.id);
    assert.equal(text(harness, "#sunoAccountName"), "");
    selectAudioService(harness, website.id);
    assert.equal(text(harness, "#sunoAccountName"), "Suno account: Personal musician");
    selectAudioService(harness, musicService.id);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, "Unfinished music name");
    assert.equal(harness.document.querySelector<HTMLElement>("#sunoLoginControls")!.hidden, true);
    assert.deepEqual(commandCalls(harness).map((call) => call.body), [{ kind: "refresh_suno_login", serviceId: website.id }]);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("conflicting Suno drafts block import and maintenance while website opening needs no saved selection", async () => {
  const state = websiteState("signed_in");
  const harness = await createDialogHarness(state);
  try {
    harness.input("#audioServiceName", "Unsaved Suno name");
    assert.equal(text(harness, "#sunoAccountName"), "Suno account: Personal musician",
      "a non-secret settings draft does not change the saved account identity");
    const next = { connections: state.integrationConnections!.connections, revision: "2" };
    harness.setServerState({ ...state, integrationConnections: next });
    harness.emitServerEvent(broadcast(state, next));
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceConflict")!.hidden, false);
    for (const selector of ["#connectSunoButton", "#refreshSunoLoginButton", "#logoutSunoButton"]) {
      assert.equal(disabled(harness, selector), true);
      harness.click(selector);
    }
    assert.equal(commandCalls(harness).length, 0);
    harness.click("#openSunoWebsiteButton");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).map((call) => call.body), [{ kind: "open_suno_website" }]);
    harness.click("#reloadAudioServiceButton");
    assert.equal(disabled(harness, "#refreshSunoLoginButton"), false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("clear local Cookie confirms its precise scope and requires acceptance before issuing its exact command", async () => {
  const harness = await createDialogHarness(websiteState("signed_in"));
  try {
    harness.click("#logoutSunoButton");
    await harness.settle();
    assert.equal(commandCalls(harness).length, 0);
    assert.match(text(harness, "body"), /Your Suno browser login and browser windows stay open/);
    await harness.cancelAppConfirmation();
    assert.equal(commandCalls(harness).length, 0);
    assert.equal(text(harness, "#sunoLoginStatus"), "Connected to Suno.com");
    harness.click("#logoutSunoButton");
    harness.setServerState(websiteState());
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.deepEqual(commandCalls(harness).map((call) => call.body), [{ kind: "logout_suno", serviceId: website.id }]);
    assert.equal(text(harness, "#sunoLoginStatus"), "Not connected");
    assert.equal(text(harness, "#sunoAccountName"), "");
    assert.equal(disabled(harness, "#refreshSunoLoginButton"), true);
    selectAudioService(harness, secondWebsite.id);
    assert.equal(text(harness, "#sunoLoginStatus"), "Cookie saved; refresh to verify");
    assert.deepEqual(harness.windowOpenAttempts, []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a connection changed while clear confirmation is open cannot be cleared", async () => {
  const state = websiteState("signed_in");
  const harness = await createDialogHarness(state);
  try {
    harness.click("#logoutSunoButton");
    await harness.settle();
    const next = {
      connections: [secondWebsite, musicService].map(integrationConnectionView),
      revision: "2",
    };
    harness.emitServerEvent(broadcast(state, next));
    await harness.settle();
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.equal(commandCalls(harness).length, 0);
    assert.equal(selectedAudioService(harness), secondWebsite.id);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("unavailable evidence clears the account name but only missing evidence hides refresh", async () => {
  const harness = await createDialogHarness(websiteState("signed_in"));
  try {
    harness.setServerState(websiteState("unavailable"));
    harness.click("#refreshSunoLoginButton");
    await harness.settle();
    assert.equal(text(harness, "#sunoLoginStatus"), "Suno verification unavailable; try again later");
    assert.equal(text(harness, "#sunoAccountName"), "");
    assert.equal(disabled(harness, "#refreshSunoLoginButton"), false);
    harness.setServerState(audioState([website, secondWebsite, musicService]));
    harness.click("#openSunoWebsiteButton");
    await harness.settle();
    assert.equal(text(harness, "#sunoLoginStatus"), "No verified Suno connection");
    assert.equal(text(harness, "#sunoAccountName"), "");
    assert.equal(disabled(harness, "#refreshSunoLoginButton"), true);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

for (const language of ["en", "zh-CN"] as const) {
  test(`${language}: unavailable verification can retry and recover without Cookie reentry`, async () => {
    const state = websiteState("signed_in");
    state.settings.uiLanguage = language;
    const harness = await createDialogHarness(state);
    try {
      harness.setServerState({ ...state, sunoAccounts: [{ serviceId: website.id, status: "unavailable" }] });
      harness.failNextCommand("Suno verification is temporarily unavailable.", undefined, { status: 500 });
      harness.click("#refreshSunoLoginButton");
      await harness.settle();
      const retry = harness.document.querySelector<HTMLButtonElement>("#refreshSunoLoginButton")!;
      assert.equal(retry.hidden, false);
      assert.equal(retry.disabled, false);
      assert.equal(retry.textContent, language === "en" ? "Retry verification" : "重试验证");
      assert.equal(text(harness, "#sunoAccountName"), "");
      const unavailableStatus = text(harness, "#sunoLoginStatus");
      harness.setServerState(state);
      harness.holdNextCommand();
      harness.click("#refreshSunoLoginButton");
      harness.click("#refreshSunoLoginButton");
      assert.equal(text(harness, "#sunoLoginStatus"), unavailableStatus, "retry must not optimistically claim connection");
      assert.equal(harness.document.querySelector<HTMLInputElement>("#sunoSessionValue")!.value, "");
      assert.deepEqual(commandCalls(harness).map((call) => call.body), [
        { kind: "refresh_suno_login", serviceId: website.id },
        { kind: "refresh_suno_login", serviceId: website.id },
      ]);
      harness.releaseHeldCommand();
      await harness.settle();
      assert.equal(text(harness, "#sunoLoginStatus"), language === "en" ? "Connected to Suno.com" : "已连接 Suno.com");
      assert.equal(retry.textContent, language === "en" ? "Refresh connection" : "刷新连接");
      assert.equal(text(harness, "#sunoAccountName"), language === "en" ? "Suno account: Personal musician" : "Suno 账户：Personal musician");
      assert.equal(harness.document.querySelector<HTMLInputElement>("#sunoSessionValue")!.value, "");
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); }
  });
}

test("unavailable retry can report a missing local Cookie without claiming connection or automatically importing", async () => {
  const harness = await createDialogHarness(websiteState("unavailable"));
  try {
    harness.failNextCommand("No valid local Suno Cookie is saved.");
    harness.click("#refreshSunoLoginButton");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).map((call) => call.body), [{ kind: "refresh_suno_login", serviceId: website.id }]);
    assert.match(text(harness, "#status"), /No valid local Suno Cookie is saved/);
    assert.equal(text(harness, "#sunoAccountName"), "");
    assert.equal(text(harness, "#sunoLoginStatus"), "Suno verification unavailable; try again later");
    assert.equal(disabled(harness, "#refreshSunoLoginButton"), false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

for (const status of ["expired", "unavailable"] as const) {
  test(`HTTP 500 refresh adopts authoritative ${status} evidence before showing the original error`, async () => {
    const harness = await createDialogHarness(websiteState("signed_in"));
    try {
      const stateReads = harness.calls.filter((call) => call.path === "/state").length;
      harness.setServerState(websiteState(status));
      harness.failNextCommand("Suno verification failed.", undefined, { status: 500 });
      harness.click("#refreshSunoLoginButton");
      await harness.settle();
      assert.equal(harness.calls.filter((call) => call.path === "/state").length, stateReads + 1,
        "a failed command without state requires exactly one authoritative read");
      assert.equal(text(harness, "#sunoAccountName"), "");
      assert.equal(text(harness, "#sunoLoginStatus"), status === "expired"
        ? "Cookie expired; import a fresh Suno Cookie" : "Suno verification unavailable; try again later");
      assert.equal(text(harness, "#status"), "Suno verification failed.");
      assert.equal(disabled(harness, "#refreshSunoLoginButton"), false);
      assert.deepEqual(commandCalls(harness).map((call) => call.body), [{ kind: "refresh_suno_login", serviceId: website.id }]);
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); }
  });
}

test("a dropped website request reconciles state without claiming the browser opened or overwriting the warning", async () => {
  const harness = await createDialogHarness(websiteState());
  try {
    harness.rejectNextCommand("Open request lost before reaching the handler.");
    harness.click("#openSunoWebsiteButton");
    await harness.settle();
    harness.holdNextState();
    harness.queueNextStatePublication("101", "100");
    harness.emitServerEventError();
    await harness.settle();
    harness.queueNextStatePublication("102", "101");
    harness.emitServerEventOpen();
    await harness.settle();
    harness.releaseHeldState();
    await harness.settle();
    assert.match(text(harness, "#status"), /Open request lost before reaching the handler/);
    assert.match(text(harness, "#status"), /Authoritative state was refreshed; verify the command outcome/);
    assert.doesNotMatch(text(harness, "#status"), /Suno opened in your default browser/);
    assert.equal(text(harness, "#sunoLoginStatus"), "Not connected");
    assert.deepEqual(commandCalls(harness).map((call) => call.body), [{ kind: "open_suno_website" }]);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("an unknown website command with authoritative state keeps its warning instead of claiming opening", async () => {
  const state = websiteState();
  const harness = await createDialogHarness(state);
  try {
    harness.failNextCommand("Browser opening outcome unknown.", undefined, { status: 500, commandOutcome: "unknown", state });
    harness.click("#openSunoWebsiteButton");
    await harness.settle();
    assert.equal(text(harness, "#status"), "Browser opening outcome unknown.");
    assert.equal(text(harness, "#sunoLoginStatus"), "Not connected");
    assert.equal(disabled(harness, "#openSunoWebsiteButton"), false);
    assert.deepEqual(commandCalls(harness).map((call) => call.body), [{ kind: "open_suno_website" }]);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("failed website opening leaves the account unchanged and restores an explicit retry", async () => {
  const harness = await createDialogHarness(websiteState());
  try {
    harness.failNextCommand("Default browser could not be opened.");
    harness.click("#openSunoWebsiteButton");
    await harness.settle();
    assert.match(text(harness, "#status"), /Default browser could not be opened/);
    assert.equal(text(harness, "#sunoLoginStatus"), "Not connected");
    assert.equal(disabled(harness, "#openSunoWebsiteButton"), false);
    assert.equal(commandCalls(harness).length, 1);
    harness.click("#openSunoWebsiteButton");
    await harness.settle();
    assert.equal(commandCalls(harness).length, 2);
    assert.equal(text(harness, "#status"), "Suno opened in your default browser. Import its Cookie to connect Live Smith.");
    assert.equal(text(harness, "#sunoLoginStatus"), "Not connected");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("Chinese Cookie connection labels, help, account name and local-clear confirmation are translated", async () => {
  const state = websiteState("signed_in");
  state.settings.uiLanguage = "zh-CN";
  const harness = await createDialogHarness(state);
  try {
    assert.equal(text(harness, '#audioServiceProvider option[value="suno"]'), "Suno.com 订阅（实验性）");
    assert.equal(text(harness, "#openSunoWebsiteButton"), "打开 Suno");
    assert.equal(harness.document.querySelector("#openSunoWebsiteButton")?.getAttribute("aria-label"), "在默认浏览器中打开 Suno");
    assert.equal(text(harness, "#connectSunoButton"), "连接");
    assert.equal(text(harness, "#refreshSunoLoginButton"), "刷新连接");
    assert.equal(text(harness, "#logoutSunoButton"), "清除本地 Cookie");
    assert.equal(text(harness, "#sunoAccountName"), "Suno 账户：Personal musician");
    const cookieHelp = harness.document.querySelector<HTMLElement>(
      "#sunoCookieHelp",
    )!;
    assert.equal(cookieHelp.textContent, "?");
    assert.equal(cookieHelp.getAttribute("role"), "note");
    assert.equal(cookieHelp.tabIndex, 0);
    assert.equal(Object.hasOwn(cookieHelp, "open"), false);
    assert.match(cookieHelp.dataset.tooltip ?? "", /auth.suno.com/);
    assert.match(cookieHelp.dataset.tooltip ?? "", /复制其 Cookie 请求头/);
    assert.match(cookieHelp.dataset.tooltip ?? "", /__session/);
    assert.match(cookieHelp.dataset.tooltip ?? "", /完整请求头/);
    assert.match(cookieHelp.dataset.tooltip ?? "", /提交后清空输入框/);
    assert.equal(
      cookieHelp.getAttribute("aria-label"),
      cookieHelp.dataset.tooltip,
    );
    assert.equal(
      cookieHelp.closest(".field-label-row")?.querySelector("label")?.htmlFor,
      "sunoSessionValue",
    );
    assert.equal(harness.document.querySelector("#sunoCookieHint"), null);
    assert.equal(
      harness.document.querySelector("#sunoSessionValue")?.getAttribute(
        "aria-describedby",
      ),
      "audioServiceDisclosure",
    );
    harness.click("#logoutSunoButton");
    await harness.settle();
    assert.match(text(harness, "body"), /浏览器中的 Suno 登录和窗口会保留/);
    await harness.cancelAppConfirmation();
    harness.input("#audioServiceName", "改名");
    assert.equal(text(harness, "#connectSunoButton"), "保存并连接");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
