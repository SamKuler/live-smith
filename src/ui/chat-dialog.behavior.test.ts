import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";

import { JSDOM, VirtualConsole } from "jsdom";

import { AgentPartialCompletionError } from "../agent/loop.js";
import type { SavedProfile } from "../model/profile.js";
import type { ChatDialogState } from "./chat-state.js";
import { composeChatDocument } from "./chat-document.js";

interface BridgeCall {
  path: string;
  body: unknown;
}

interface DialogHarness {
  calls: BridgeCall[];
  clipboardWrites: string[];
  commandIds: string[];
  click(selector: string): void;
  clickButton(label: string): void;
  close(): void;
  document: Document;
  emitServerEvent(payload: unknown): void;
  emitServerEventError(): void;
  errors: unknown[];
  eventSourceUrls: string[];
  failNextCommand(
    error: string,
    field?: string,
    details?: {
      commandOutcome?: "unknown";
      reconciliationRequired?: boolean;
      state?: ChatDialogState;
    },
  ): void;
  failNextConfirmation(error: string): void;
  failNextSend(error: string, promptPersistence?: string): void;
  failNextState(error: string): void;
  rejectNextSend(error: string): void;
  rejectNextCommand(error: string): void;
  rejectNextCommandResponse(error: string): void;
  rejectNextState(error: string): void;
  holdNextCommand(): void;
  holdNextConfirmation(): void;
  holdNextSend(): void;
  holdNextState(): void;
  hostMessages: unknown[];
  input(selector: string, value: string): void;
  releaseHeldCommand(): void;
  releaseHeldConfirmation(): void;
  releaseHeldSend(): void;
  releaseHeldState(): void;
  queueStopTerminals(...values: boolean[]): void;
  sendIds: string[];
  stopIds: string[];
  select(selector: string, value: string): void;
  setConfirmResult(value: boolean): void;
  settle(): Promise<void>;
  window: JSDOM["window"];
}

const chatTemplate = fs.readFileSync(
  new URL("./templates/chat-dialog.html", import.meta.url),
  "utf8",
);
const clientScripts = {
  bootstrap: readClientScript("bootstrap"),
  bridgeClient: readClientScript("bridge-client"),
  capabilityPreview: readClientScript("capability-preview"),
  hostAdapter: readClientScript("host-adapter"),
  profileEditor: readClientScript("profile-editor"),
  sessionTimeline: readClientScript("session-timeline"),
};

function renderChatHtml(
  state: ChatDialogState,
  bridge: { baseUrl: string; token: string },
): string {
  return composeChatDocument(chatTemplate, state, bridge, clientScripts);
}

function readClientScript(name: string): string {
  return fs.readFileSync(
    new URL(`./client/${name}.script.html`, import.meta.url),
    "utf8",
  );
}

function capabilities(): ChatDialogState["capabilities"] {
  return {
    tools: true,
    streaming: true,
    temperature: "supported",
    maxOutputTokens: 8192,
    reasoning: {
      supported: false,
      canDisable: false,
      efforts: [],
      budgetTokens: false,
      strategy: "none",
    },
  };
}

function profileFixture(
  overrides: Partial<SavedProfile> = {},
): SavedProfile {
  return {
    id: "profile-1",
    name: "Studio",
    apiFamily: "openai",
    apiMode: "chat-completions",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "model-a",
    parameters: {
      maxOutputTokens: 8192,
      temperature: 0.4,
      reasoning: { mode: "default" },
    },
    advanced: {},
    ...overrides,
  };
}

function modelStateSourceFixture(profile: SavedProfile) {
  return {
    profileId: profile.id,
    apiFamily: profile.apiFamily,
    apiMode: profile.apiMode,
    baseUrl: profile.baseUrl.replace(/\/+$/, ""),
    apiKey: profile.apiKey,
    model: profile.model,
  };
}

function stateFixture(): ChatDialogState {
  return {
    defaultPrompt: "Make a bassline",
    contextSummary: "Selected track: Bass",
    sessions: [
      {
        id: "session-1",
        title: "Bass session",
        projectKey: "project-1",
        scope: { kind: "track", identity: "track-bass", label: "Bass" },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "session-2",
        title: "Lead session",
        projectKey: "project-1",
        scope: { kind: "track", identity: "track-lead", label: "Lead" },
        createdAt: "2026-08-01T00:01:00.000Z",
        updatedAt: "2026-08-01T00:01:00.000Z",
      },
    ],
    recoverableSessions: [],
    activeSessionId: "session-1",
    events: [],
    capabilities: capabilities(),
    availableModels: [],
    modelStateSource: modelStateSourceFixture(profileFixture()),
    runtimeProfile: {
      profile: profileFixture(),
      capabilities: capabilities(),
    },
    settings: {
      schemaVersion: 1,
      activeProfileId: "profile-1",
      autoApprove: false,
      profiles: [
        profileFixture(),
        profileFixture({
          id: "profile-2",
          name: "Mix review",
          apiFamily: "anthropic",
          apiMode: "messages",
          model: "model-b",
        }),
      ],
    },
    openSettingsOnLoad: true,
  };
}

function cloneState(state: ChatDialogState): ChatDialogState {
  return JSON.parse(JSON.stringify(state)) as ChatDialogState;
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function createDialogHarness(
  initialState: ChatDialogState = stateFixture(),
  bridge = { baseUrl: "http://bridge.test", token: "test-token" },
): Promise<DialogHarness> {
  const calls: BridgeCall[] = [];
  const clipboardWrites: string[] = [];
  const commandIds: string[] = [];
  const errors: unknown[] = [];
  const eventSourceUrls: string[] = [];
  const sendIds: string[] = [];
  const stopIds: string[] = [];
  const eventSources: Array<{
    onmessage: ((event: { data: string }) => void) | null;
    onerror: (() => void) | null;
  }> = [];
  const hostMessages: unknown[] = [];
  let confirmResult = true;
  let nextCommandError: {
    error: string;
    field?: string;
    commandOutcome?: "unknown";
    reconciliationRequired?: boolean;
    state?: ChatDialogState;
  } | null = null;
  let nextConfirmationError: { error: string } | null = null;
  let nextSendError: { error: string; promptPersistence?: string } | null = null;
  let nextStateError: { error: string } | null = null;
  let nextSendRejection: Error | null = null;
  let nextCommandRejection: Error | null = null;
  let nextCommandResponseRejection: Error | null = null;
  let nextStateRejection: Error | null = null;
  let heldCommand: Promise<void> | null = null;
  let heldConfirmation: Promise<void> | null = null;
  const heldSends: Promise<void>[] = [];
  let heldState: Promise<void> | null = null;
  let releaseCommand: (() => void) | null = null;
  let releaseConfirmation: (() => void) | null = null;
  const releaseSends: Array<() => void> = [];
  let releaseState: (() => void) | null = null;
  const stopTerminals: boolean[] = [];
  let serverState = cloneState(initialState);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));

  const dom = new JSDOM(
    renderChatHtml(cloneState(initialState), bridge),
    {
      url: "http://dialog.test/chat",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        window.addEventListener("error", (event) => errors.push(event.error));
        Object.defineProperty(window, "webkit", {
          configurable: true,
          value: {
            messageHandlers: {
              live: {
                postMessage: (message: unknown) => hostMessages.push(message),
              },
            },
          },
        });
        Object.defineProperty(window, "confirm", {
          configurable: true,
          value: () => confirmResult,
        });
        Object.defineProperty(window.navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (value: string) => {
              clipboardWrites.push(value);
            },
          },
        });
        Object.defineProperty(window, "EventSource", {
          configurable: true,
          value: class {
            onmessage: ((event: { data: string }) => void) | null = null;
            onerror: (() => void) | null = null;
            constructor(url: string | URL) {
              eventSourceUrls.push(String(url));
              eventSources.push(this);
            }
            close(): void {}
          },
        });
        Object.defineProperty(window, "fetch", {
          configurable: true,
          value: async (input: string | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            const body = typeof init?.body === "string"
              ? JSON.parse(init.body) as unknown
              : undefined;
            if (url.pathname === "/send") {
              const headers = init?.headers as Record<string, string> | undefined;
              sendIds.push(headers?.["X-Live-Smith-Send-Id"] ?? "");
            }
            if (url.pathname === "/stop") {
              const headers = init?.headers as Record<string, string> | undefined;
              stopIds.push(headers?.["X-Live-Smith-Send-Id"] ?? "");
            }
            if (url.pathname === "/command") {
              const headers = init?.headers as Record<string, string> | undefined;
              commandIds.push(headers?.["X-Live-Smith-Command-Id"] ?? "");
            }
            calls.push({ path: url.pathname, body });

            if (url.pathname === "/command") {
              if (nextCommandRejection) {
                const error = nextCommandRejection;
                nextCommandRejection = null;
                throw error;
              }
              if (heldCommand) {
                const wait = heldCommand;
                heldCommand = null;
                await wait;
              }
              if (nextCommandError) {
                const error = nextCommandError;
                nextCommandError = null;
                return failedResponse(error, 400, "Bad Request");
              }
              const command = body as {
                kind?: string;
                profile?: SavedProfile;
                profileId?: string;
                sessionId?: string;
                title?: string;
              };
              if (command.kind === "save_profile" && command.profile) {
                const profiles = serverState.settings.profiles.filter(
                  (profile) => profile.id !== command.profile?.id,
                );
                profiles.push(JSON.parse(JSON.stringify(command.profile)) as SavedProfile);
                serverState.settings.profiles = profiles;
                serverState.settings.activeProfileId = command.profile.id;
                serverState.modelStateSource = modelStateSourceFixture(command.profile);
                serverState.runtimeProfile = {
                  profile: command.profile,
                  capabilities: capabilities(),
                };
              } else if (command.kind === "discover_models") {
                serverState.availableModels = [{
                  id: "model-discovered",
                  displayName: "Discovered model",
                  capabilities: capabilities(),
                }];
                if (command.profile) {
                  serverState.modelStateSource = modelStateSourceFixture(command.profile);
                  serverState.capabilities = capabilities();
                }
              } else if (command.kind === "activate_profile" && command.profileId) {
                serverState.settings.activeProfileId = command.profileId;
                const profile = serverState.settings.profiles.find(
                  (entry) => entry.id === command.profileId,
                );
                serverState.modelStateSource = profile
                  ? modelStateSourceFixture(profile)
                  : null;
                serverState.runtimeProfile = profile
                  ? { profile, capabilities: capabilities() }
                  : null;
              } else if (command.kind === "delete_profile" && command.profileId) {
                serverState.settings.profiles = serverState.settings.profiles.filter(
                  (entry) => entry.id !== command.profileId,
                );
                if (serverState.settings.activeProfileId === command.profileId) {
                  serverState.settings.activeProfileId =
                    serverState.settings.profiles[0]?.id ?? null;
                }
                const profile = serverState.settings.profiles.find(
                  (entry) => entry.id === serverState.settings.activeProfileId,
                );
                serverState.modelStateSource = profile
                  ? modelStateSourceFixture(profile)
                  : null;
                serverState.runtimeProfile = profile
                  ? { profile, capabilities: capabilities() }
                  : null;
              } else if (command.kind === "select_session" && command.sessionId) {
                serverState.activeSessionId = command.sessionId;
              } else if (command.kind === "restore_session" && command.sessionId) {
                const restored = serverState.recoverableSessions.find(
                  (entry) => entry.id === command.sessionId,
                );
                if (restored) {
                  serverState.recoverableSessions = serverState.recoverableSessions.filter(
                    (entry) => entry.id !== command.sessionId,
                  );
                  restored.projectKey = serverState.sessions[0]?.projectKey ?? "project-1";
                  serverState.sessions = [restored, ...serverState.sessions];
                  serverState.activeSessionId = restored.id;
                }
              } else if (
                command.kind === "rename_session" &&
                command.sessionId &&
                command.title
              ) {
                const session = serverState.sessions.find(
                  (entry) => entry.id === command.sessionId,
                );
                if (session) session.title = command.title;
              } else if (command.kind === "delete_session" && command.sessionId) {
                serverState.sessions = serverState.sessions.filter(
                  (entry) => entry.id !== command.sessionId,
                );
                serverState.activeSessionId = serverState.sessions[0]?.id ?? "";
              }
              if (nextCommandResponseRejection) {
                const error = nextCommandResponseRejection;
                nextCommandResponseRejection = null;
                throw error;
              }
              return response(cloneState(serverState));
            }

            if (url.pathname === "/state") {
              if (nextStateError) {
                const error = nextStateError;
                nextStateError = null;
                return failedResponse(error, 503, "Service Unavailable");
              }
              if (nextStateRejection) {
                const error = nextStateRejection;
                nextStateRejection = null;
                throw error;
              }
              if (heldState) {
                const wait = heldState;
                heldState = null;
                await wait;
              }
              return response(cloneState(serverState));
            }
            if (url.pathname === "/send") {
              const wait = heldSends.shift();
              if (wait) await wait;
              if (nextSendError) {
                const error = nextSendError;
                nextSendError = null;
                return failedResponse(error, 500, "Internal Server Error");
              }
              if (nextSendRejection) {
                const error = nextSendRejection;
                nextSendRejection = null;
                throw error;
              }
              return response({ ok: true });
            }
            if (url.pathname === "/confirm") {
              if (heldConfirmation) {
                const wait = heldConfirmation;
                heldConfirmation = null;
                await wait;
              }
              if (nextConfirmationError) {
                const error = nextConfirmationError;
                nextConfirmationError = null;
                return failedResponse(error, 503, "Service Unavailable");
              }
            }
            if (url.pathname === "/stop") {
              return response({
                ok: true,
                terminal: stopTerminals.shift() ?? true,
              });
            }
            return response({ ok: true });
          },
        });
      },
    },
  );
  const { window } = dom;
  if (window.document.readyState !== "complete") {
    await new Promise<void>((resolve) => {
      window.addEventListener("load", () => resolve(), { once: true });
    });
  }

  const required = <T extends Element>(selector: string): T => {
    const element = window.document.querySelector<T>(selector);
    assert.ok(element, `Expected ${selector} to exist`);
    return element;
  };

  return {
    calls,
    clipboardWrites,
    commandIds,
    click(selector) {
      required<HTMLElement>(selector).click();
    },
    clickButton(label) {
      const button = [...window.document.querySelectorAll<HTMLButtonElement>("button")]
        .find((candidate) => candidate.textContent?.trim() === label);
      assert.ok(button, `Expected button ${label} to exist`);
      button.click();
    },
    close() {
      window.close();
    },
    document: window.document,
    emitServerEvent(payload) {
      const source = eventSources.at(-1);
      assert.ok(source?.onmessage, "Expected the EventSource to be connected");
      source.onmessage({ data: JSON.stringify(payload) });
    },
    emitServerEventError() {
      const source = eventSources.at(-1);
      assert.ok(source?.onerror, "Expected the EventSource to be connected");
      source.onerror();
    },
    errors,
    eventSourceUrls,
    failNextCommand(error, field, details) {
      nextCommandError = {
        error,
        ...(field ? { field } : {}),
        ...(details || {}),
      };
    },
    failNextConfirmation(error) {
      nextConfirmationError = { error };
    },
    failNextSend(error, promptPersistence) {
      nextSendError = {
        error,
        ...(promptPersistence ? { promptPersistence } : {}),
      };
    },
    failNextState(error) {
      nextStateError = { error };
    },
    rejectNextSend(error) {
      nextSendRejection = new Error(error);
    },
    rejectNextCommand(error) {
      nextCommandRejection = new Error(error);
    },
    rejectNextCommandResponse(error) {
      nextCommandResponseRejection = new Error(error);
    },
    rejectNextState(error) {
      nextStateRejection = new Error(error);
    },
    holdNextCommand() {
      heldCommand = new Promise<void>((resolve) => {
        releaseCommand = resolve;
      });
    },
    holdNextConfirmation() {
      heldConfirmation = new Promise<void>((resolve) => {
        releaseConfirmation = resolve;
      });
    },
    holdNextSend() {
      heldSends.push(new Promise<void>((resolve) => {
        releaseSends.push(resolve);
      }));
    },
    holdNextState() {
      heldState = new Promise<void>((resolve) => {
        releaseState = resolve;
      });
    },
    hostMessages,
    input(selector, value) {
      const field = required<HTMLInputElement | HTMLTextAreaElement>(selector);
      field.value = value;
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    releaseHeldCommand() {
      assert.ok(releaseCommand, "Expected a held command");
      const release = releaseCommand;
      releaseCommand = null;
      release();
    },
    releaseHeldConfirmation() {
      assert.ok(releaseConfirmation, "Expected a held confirmation");
      const release = releaseConfirmation;
      releaseConfirmation = null;
      release();
    },
    releaseHeldSend() {
      const release = releaseSends.shift();
      assert.ok(release, "Expected a held send");
      release();
    },
    releaseHeldState() {
      assert.ok(releaseState, "Expected a held state refresh");
      const release = releaseState;
      releaseState = null;
      release();
    },
    queueStopTerminals(...values) {
      stopTerminals.push(...values);
    },
    sendIds,
    stopIds,
    select(selector, value) {
      const field = required<HTMLSelectElement>(selector);
      field.value = value;
      field.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    setConfirmResult(value) {
      confirmResult = value;
    },
    async settle() {
      await Promise.resolve();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      await Promise.resolve();
    },
    window,
  };
}

function failedResponse(
  body: unknown,
  status: number,
  statusText: string,
): {
  json(): Promise<unknown>;
  ok: false;
  status: number;
  statusText: string;
} {
  return {
    ok: false,
    status,
    statusText,
    json: async () => body,
  };
}

function response(body: unknown): {
  json(): Promise<unknown>;
  ok: true;
  status: 200;
  statusText: "OK";
} {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  };
}

function commandCalls(harness: DialogHarness): BridgeCall[] {
  return harness.calls.filter((call) => call.path === "/command");
}

test("real script boots and Add then Discard restores the saved profile", async () => {
  const harness = await createDialogHarness();
  try {
    const selector = harness.document.querySelector<HTMLSelectElement>("#profileSelector");
    assert.equal(selector?.value, "profile-1");
    assert.deepEqual(harness.eventSourceUrls, [
      "http://bridge.test/events?token=test-token",
    ]);
    assert.equal(harness.document.activeElement?.id, "profileName");

    harness.clickButton("Add");
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Unsaved changes");
    assert.equal(
      [...(selector?.options ?? [])].some((option) => option.text === "Unsaved profile"),
      true,
    );

    harness.click("#discardProfileButton");
    assert.equal(selector?.value, "profile-1");
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Studio",
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    assert.equal(
      [...(selector?.options ?? [])].some((option) => option.text === "Unsaved profile"),
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a valid Profile starts in chat-first mode and exposes an accessible Inspector", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const app = harness.document.querySelector(".app");
    const inspector = harness.document.querySelector<HTMLElement>("#inspectorPane");
    const settingsToggle = harness.document.querySelector<HTMLButtonElement>(
      "#inspectorToggleButton",
    );
    assert.equal(app?.classList.contains("inspector-open"), false);
    assert.equal(inspector?.hidden, true);
    assert.equal(settingsToggle?.getAttribute("aria-expanded"), "false");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    assert.equal(harness.document.activeElement?.id, "prompt");
    assert.match(
      harness.document.querySelector("#profileSummaryButton")?.textContent ?? "",
      /Studio.*model-a/s,
    );
    assert.equal(
      harness.document.querySelector("#profileSummaryButton")?.getAttribute("aria-label"),
      "Profile Studio, model model-a. Open Profile Settings.",
    );

    settingsToggle?.click();

    assert.equal(app?.classList.contains("inspector-open"), true);
    assert.equal(inspector?.hidden, false);
    assert.equal(settingsToggle?.getAttribute("aria-expanded"), "true");
    assert.equal(
      harness.document.querySelector("#settingsTab")?.getAttribute("aria-selected"),
      "true",
    );

    harness.click("#contextTab");
    assert.equal(
      harness.document.querySelector("#contextTab")?.getAttribute("aria-selected"),
      "true",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#contextPanel")?.hidden,
      false,
    );
    harness.document.querySelector("#contextTab")?.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    assert.equal(
      harness.document.querySelector("#settingsTab")?.getAttribute("aria-selected"),
      "true",
    );
    harness.document.querySelector("#settingsTab")?.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    assert.equal(
      harness.document.querySelector("#contextTab")?.getAttribute("aria-selected"),
      "true",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("the dialog exposes accessible names, tabs, and live status semantics", async () => {
  const harness = await createDialogHarness();
  try {
    assert.equal(
      harness.document.querySelector("#prompt")?.getAttribute("aria-label"),
      "Message Live Smith",
    );
    for (const [selector, label] of [
      ["#closeButton", "Close Live Smith"],
      ["#newSessionButton", "New Session"],
      ["#deleteSession", "Delete Session"],
    ] as const) {
      assert.equal(harness.document.querySelector(selector)?.getAttribute("aria-label"), label);
    }
    const status = harness.document.querySelector("#status");
    assert.equal(status?.getAttribute("role"), "status");
    assert.equal(status?.getAttribute("aria-live"), "polite");
    assert.equal(status?.getAttribute("aria-atomic"), "true");
    assert.equal(
      harness.document.querySelector(".tab-bar")?.getAttribute("role"),
      "tablist",
    );
    assert.equal(harness.document.querySelector("#settingsTab")?.getAttribute("role"), "tab");
    assert.equal(
      harness.document.querySelector("#settingsPanel")?.getAttribute("role"),
      "tabpanel",
    );
    for (const section of [
      "#profileSettingsSection",
      "#connectionSettingsSection",
      "#generationSettingsSection",
      "#advancedSettingsSection",
    ]) assert.ok(harness.document.querySelector(section));
    const autoApproveLabel = harness.document.querySelector("#autoApprove")?.closest("label");
    assert.match(autoApproveLabel?.textContent ?? "", /undoable changes/i);
    assert.match(
      autoApproveLabel?.getAttribute("title") ?? "",
      /Deletes and MIDI clip writes still require confirmation/i,
    );
    assert.doesNotMatch(autoApproveLabel?.textContent ?? "", /non-destructive/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Profile actions stay outside the scrollable Settings form", async () => {
  const harness = await createDialogHarness();
  try {
    const panel = harness.document.querySelector<HTMLElement>("#settingsPanel");
    const scroll = harness.document.querySelector<HTMLElement>(".settings-scroll");
    const actions = harness.document.querySelector<HTMLElement>(".settings-actions");
    const generation = harness.document.querySelector<HTMLElement>(
      "#generationSettingsSection",
    );

    assert.ok(panel);
    assert.ok(scroll);
    assert.ok(actions);
    assert.ok(generation);
    assert.equal(actions.parentElement, panel);
    assert.equal(scroll.contains(actions), false);
    assert.equal(scroll.contains(generation), true);
    assert.equal(harness.window.getComputedStyle(panel).display, "grid");
    assert.equal(harness.window.getComputedStyle(panel).overflow, "hidden");
    assert.equal(harness.window.getComputedStyle(scroll).overflowY, "auto");
    assert.equal(harness.window.getComputedStyle(actions).position, "static");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("closing a dirty Profile requires explicit discard confirmation", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Unsaved studio");
    harness.setConfirmResult(false);
    harness.click("#closeButton");
    assert.deepEqual(harness.hostMessages, []);

    harness.setConfirmResult(true);
    harness.click("#closeButton");
    assert.deepEqual(JSON.parse(JSON.stringify(harness.hostMessages)), [{
      method: "close_and_send",
      params: [JSON.stringify({ kind: "close" })],
    }]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("closing while a send is active requires explicit confirmation", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Keep working");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();

    harness.setConfirmResult(false);
    harness.click("#closeButton");

    assert.deepEqual(harness.hostMessages, []);
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("API key visibility exposes an accessible Show and Hide state", async () => {
  const harness = await createDialogHarness();
  try {
    const field = harness.document.querySelector<HTMLInputElement>("#apiKey");
    const toggle = harness.document.querySelector<HTMLButtonElement>(
      "#apiKeyVisibilityButton",
    );
    assert.equal(field?.type, "password");
    assert.equal(toggle?.textContent, "Show");
    assert.equal(toggle?.getAttribute("aria-pressed"), "false");

    toggle?.click();
    assert.equal(field?.type, "text");
    assert.equal(toggle?.textContent, "Hide");
    assert.equal(toggle?.getAttribute("aria-pressed"), "true");

    toggle?.click();
    assert.equal(field?.type, "password");
    assert.equal(toggle?.textContent, "Show");
    assert.equal(toggle?.getAttribute("aria-pressed"), "false");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Session delete is guarded and rename is available from the toolbar and F2", async () => {
  const harness = await createDialogHarness();
  try {
    harness.setConfirmResult(false);
    harness.click("#deleteSession");
    await harness.settle();
    assert.equal(
      commandCalls(harness).some(
        (call) => (call.body as { kind?: string }).kind === "delete_session",
      ),
      false,
    );

    harness.click("#renameSessionButton");
    const cancelledRename = harness.document.querySelector<HTMLInputElement>(
      ".session-rename-input",
    );
    assert.ok(cancelledRename);
    cancelledRename.value = "Do not save this";
    cancelledRename.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    await harness.settle();
    assert.equal(
      commandCalls(harness).some(
        (call) => (call.body as { kind?: string }).kind === "rename_session",
      ),
      false,
    );

    const activeRow = harness.document.querySelector<HTMLButtonElement>(
      '.session-row[aria-pressed="true"]',
    );
    activeRow?.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "F2",
      bubbles: true,
    }));
    assert.ok(harness.document.querySelector(".session-rename-input"));
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a prior-activation Session requires explicit restore to the current Live object", async () => {
  const state = stateFixture();
  state.recoverableSessions = [{
    id: "session-previous",
    title: "Previous Bass arrangement",
    projectKey: "previous-activation",
    scope: { kind: "track", identity: "old-bass-handle", label: "Bass" },
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:15:00.000Z",
  }];
  const harness = await createDialogHarness(state);
  try {
    assert.match(
      harness.document.querySelector("#sessions")?.textContent ?? "",
      /Previous sessions.*Previous Bass arrangement/s,
    );
    const restore = harness.document.querySelector<HTMLButtonElement>(
      '.restore-session-button[data-session-id="session-previous"]',
    );
    assert.ok(restore);

    harness.setConfirmResult(false);
    restore.click();
    await harness.settle();
    assert.equal(commandCalls(harness).length, 0);

    harness.setConfirmResult(true);
    restore.click();
    await harness.settle();

    assert.deepEqual(commandCalls(harness), [{
      path: "/command",
      body: { kind: "restore_session", sessionId: "session-previous" },
    }]);
    assert.equal(
      harness.document.querySelector('.session-row[aria-pressed="true"] .session-title')
        ?.textContent,
      "Previous Bass arrangement",
    );
    assert.equal(harness.document.querySelector(".restore-session-button"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("double-clicking an inactive Session selects it and keeps rename editing open", async () => {
  const harness = await createDialogHarness();
  try {
    const leadRow = [...harness.document.querySelectorAll<HTMLButtonElement>(".session-row")]
      .find((row) => row.textContent?.includes("Lead session"));
    assert.ok(leadRow);
    leadRow.dispatchEvent(new harness.window.MouseEvent("dblclick", { bubbles: true }));
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.value,
      "profile-1",
    );
    assert.ok(harness.document.querySelector(".session-rename-input"));
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("keyboard Session selection and rename restore focus to the current row", async () => {
  const harness = await createDialogHarness();
  try {
    const leadRow = [...harness.document.querySelectorAll<HTMLButtonElement>(".session-row")]
      .find((row) => row.textContent?.includes("Lead session"));
    assert.ok(leadRow);
    leadRow.focus();
    leadRow.dispatchEvent(new harness.window.MouseEvent("click", {
      bubbles: true,
      detail: 0,
    }));
    await harness.settle();

    const selectedRow = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-2"] .session-row',
    );
    assert.equal(selectedRow?.getAttribute("aria-pressed"), "true");
    assert.equal(harness.document.activeElement, selectedRow);

    selectedRow?.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "F2",
      bubbles: true,
    }));
    const rename = harness.document.querySelector<HTMLInputElement>(
      ".session-rename-input",
    );
    assert.ok(rename);
    rename.value = "Lead ideas";
    rename.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    }));
    await harness.settle();

    const renamedRow = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-2"] .session-row',
    );
    assert.match(renamedRow?.textContent ?? "", /Lead ideas/);
    assert.equal(harness.document.activeElement, renamedRow);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a running Session can be left in the background and shows an unread completion dot", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Build a 64 bar bass arrangement");
    harness.click("#sendButton");
    await Promise.resolve();
    const bassSendId = harness.sendIds[0];
    assert.ok(bassSendId);

    const leadRow = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-2"] .session-row',
    );
    assert.equal(leadRow?.disabled, false);
    leadRow?.click();
    await harness.settle();

    assert.equal(
      harness.document.querySelector('.session-row[aria-pressed="true"]')
        ?.closest<HTMLElement>(".session-entry")?.dataset.sessionId,
      "session-2",
    );
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#autoApprove")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#saveProfileButton")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#contextTab")?.disabled,
      false,
    );
    assert.match(
      harness.document.querySelector("#autoApprove")?.closest("label")?.getAttribute("title") ?? "",
      /locked while a Session is running/i,
    );
    assert.equal(
      harness.document.querySelector("#autoApprove")?.getAttribute("aria-describedby"),
      "autoApproveLockHint",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#autoApproveLockHint")?.hidden,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#settingsLockNotice")?.hidden,
      false,
    );
    assert.match(
      harness.document.querySelector("#settingsLockNotice")?.textContent ?? "",
      /another Session is running/i,
    );

    const selectedLeadRow = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-2"] .session-row',
    );
    selectedLeadRow?.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "F2",
      bubbles: true,
    }));
    const leadRename = harness.document.querySelector<HTMLInputElement>(
      ".session-rename-input",
    );
    assert.ok(leadRename);
    leadRename.value = "Lead renamed while Bass runs";
    leadRename.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    }));
    await harness.settle();

    harness.holdNextSend();
    harness.input("#prompt", "Build a lead counterline");
    harness.click("#sendButton");
    await Promise.resolve();
    const leadSendId = harness.sendIds[1];
    assert.ok(leadSendId);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");

    harness.emitServerEvent({
      type: "progress",
      sendId: bassSendId,
      sessionId: "session-1",
      message: "Writing MIDI clip",
    });
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Writing MIDI clip/,
    );

    harness.emitServerEvent({
      type: "session_event",
      sendId: leadSendId,
      sessionId: "session-2",
      event: {
        id: "lead-live-event",
        kind: "assistant",
        content: "Lead event received while Bass was finishing.",
        createdAt: "2026-08-01T00:03:00.000Z",
      },
    });

    const completedState = cloneState(stateFixture());
    completedState.activeSessionId = "session-2";
    completedState.sessionActivities = [{
      sessionId: "session-1",
      sendId: bassSendId,
      status: "completed",
      message: "Completed",
      unread: true,
    }];
    harness.emitServerEvent({
      type: "done",
      sendId: bassSendId,
      sessionId: "session-1",
      state: completedState,
    });
    await harness.settle();

    const bassEntry = harness.document.querySelector(
      '.session-entry[data-session-id="session-1"]',
    );
    assert.equal(bassEntry?.querySelector(".session-unread-dot") !== null, true);
    assert.match(bassEntry?.textContent ?? "", /Completed/);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.match(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-2"]',
      )?.textContent ?? "",
      /Lead renamed while Bass runs/,
    );
    assert.match(
      harness.document.querySelector("#timeline")?.textContent ?? "",
      /Lead event received while Bass was finishing/,
    );

    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-1"] .session-unread-dot',
      ),
      null,
    );
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.deepEqual(harness.errors, []);

    harness.releaseHeldSend();
    harness.releaseHeldSend();
    await harness.settle();
  } finally {
    harness.close();
  }
});

test("a background assistant event resets only that Session's streaming draft", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Run a multi-turn Bass task");
    harness.click("#sendButton");
    await Promise.resolve();
    const bassSendId = harness.sendIds[0];
    assert.ok(bassSendId);

    harness.emitServerEvent({
      type: "assistant_delta",
      sendId: bassSendId,
      sessionId: "session-1",
      delta: "Old draft",
    });
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    harness.emitServerEvent({
      type: "session_event",
      sendId: bassSendId,
      sessionId: "session-1",
      event: {
        id: "bass-assistant-turn-1",
        kind: "assistant",
        content: "First assistant turn",
        createdAt: "2026-08-01T00:03:00.000Z",
      },
    });
    harness.emitServerEvent({
      type: "assistant_delta",
      sendId: bassSendId,
      sessionId: "session-1",
      delta: "Fresh draft",
    });

    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(
      harness.document.querySelector(".timeline-item.streaming .timeline-content")
        ?.textContent,
      "Fresh draft",
    );
    assert.deepEqual(harness.errors, []);

    harness.releaseHeldSend();
    await harness.settle();
  } finally {
    harness.close();
  }
});

test("Live Set confirmations announce their action count, focus Cancel, and support Escape", async () => {
  const state = stateFixture();
  state.events = [{
    id: "tool-event",
    kind: "tool_call",
    name: "inspect_track",
    content: "Inspect Bass",
    createdAt: "2026-08-01T00:02:00.000Z",
  }];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#prompt", "Prepare confirmation");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    const priorSummary = harness.document.querySelector<HTMLElement>(".timeline-item summary");
    priorSummary?.focus();
    assert.equal(harness.document.activeElement, priorSummary);
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      id: "confirm-1",
      message: "Add a track and update the mix.",
      groups: [
        { title: "Tracks", rows: ["Create MIDI track Bass", "Rename track Lead"] },
        { title: "Mix", rows: ["Set tempo to 124 BPM"] },
        {
          title: "Write MIDI",
          rows: [
            'Replace MIDI clip "Full arrangement" at beat 0, relative beats 16-32 (24 notes)',
          ],
        },
      ],
    });

    const dialog = harness.document.querySelector<HTMLElement>(".confirm-card");
    assert.equal(dialog?.getAttribute("role"), "alertdialog");
    assert.equal(dialog?.getAttribute("aria-modal"), "true");
    const labelledBy = dialog?.getAttribute("aria-labelledby") ?? "";
    assert.equal(
      harness.document.getElementById(labelledBy)?.textContent,
      "Apply 4 changes to the Live Set?",
    );
    assert.match(dialog?.textContent ?? "", /relative beats 16-32.*24 notes/i);
    const cancel = dialog?.querySelector<HTMLButtonElement>("[data-confirm-cancel]");
    const apply = dialog?.querySelector<HTMLButtonElement>(".primary");
    assert.equal(harness.document.activeElement, cancel);
    assert.equal(harness.document.querySelector("header")?.hasAttribute("inert"), true);
    assert.equal(
      harness.document.querySelector(".sessions-pane")?.hasAttribute("inert"),
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>(
        '.session-entry[data-session-id="session-2"] .session-row',
      )?.disabled,
      false,
    );
    assert.equal(
      [...(harness.document.querySelector("#timeline")?.children ?? [])]
        .filter((child) => child !== dialog)
        .every((child) => child.hasAttribute("inert")),
      true,
    );

    cancel?.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
    }));
    assert.equal(harness.document.activeElement, apply);
    apply?.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
    }));
    assert.equal(harness.document.activeElement, cancel);

    harness.document.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    await harness.settle();

    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.equal(harness.document.querySelector("header")?.hasAttribute("inert"), false);
    assert.equal(
      harness.document.activeElement,
      harness.document.querySelector("#sendButton"),
    );
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(
      harness.calls.filter((call) => call.path === "/confirm"),
      [{ path: "/confirm", body: { id: "confirm-1", apply: false } }],
    );
    assert.deepEqual(harness.errors, []);
    harness.releaseHeldSend();
    await harness.settle();
  } finally {
    harness.close();
  }
});

test("a failed confirmation request terminates the send before dismissing the decision", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Prepare retry confirmation");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      id: "confirm-retry",
      message: "Set tempo.",
      groups: [{ title: "Song", rows: ["Set tempo to 124 BPM"] }],
    });
    harness.failNextConfirmation("Confirmation could not be sent.");
    harness.clickButton("Apply");
    await harness.settle();

    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.equal(harness.document.querySelector("header")?.hasAttribute("inert"), false);
    assert.equal(
      [...harness.document.querySelectorAll("#timeline > *")]
        .every((child) => !child.hasAttribute("inert")),
      true,
    );
    assert.equal(
      harness.calls.filter((call) => call.path === "/stop").length,
      1,
    );
    assert.deepEqual(harness.stopIds, [sendId]);
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);
    harness.releaseHeldSend();
    await harness.settle();
  } finally {
    harness.close();
  }
});

test("a network-interrupted send stops to terminal state before clearing confirmation inertness", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Interrupt while confirming");
    harness.holdNextSend();
    harness.rejectNextSend("Bridge connection was interrupted.");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      id: "confirm-interrupted",
      message: "Set tempo.",
      groups: [{ title: "Song", rows: ["Set tempo to 124 BPM"] }],
    });
    assert.equal(harness.document.querySelector("header")?.hasAttribute("inert"), true);

    harness.releaseHeldSend();
    await harness.settle();

    assert.equal(harness.calls.filter((call) => call.path === "/stop").length, 1);
    assert.deepEqual(harness.stopIds, [sendId]);
    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.equal(harness.document.querySelector("header")?.hasAttribute("inert"), false);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      false,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /interrupted|unknown/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a network-interrupted send polls Stop by send ID until terminal and state refresh", async () => {
  const harness = await createDialogHarness();
  try {
    harness.queueStopTerminals(false, true);
    harness.rejectNextSend("Bridge connection was interrupted.");
    harness.input("#prompt", "Recover this interrupted send");
    harness.click("#sendButton");

    await waitForCondition(
      () => harness.stopIds.length === 2,
      "Expected the interrupted send to retry Stop until terminal.",
    );
    await harness.settle();

    assert.equal(harness.sendIds.length, 1);
    assert.deepEqual(harness.stopIds, [harness.sendIds[0], harness.sendIds[0]]);
    const recoveryCalls = harness.calls
      .filter((call) => call.path === "/stop" || call.path === "/state")
      .map((call) => call.path);
    assert.deepEqual(recoveryCalls, ["/stop", "/stop", "/state"]);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("settling send A cancels its Stop poll before send B starts", async () => {
  const harness = await createDialogHarness();
  try {
    harness.queueStopTerminals(false);
    harness.holdNextSend();
    harness.input("#prompt", "Prompt A");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendA = harness.sendIds[0];
    assert.ok(sendA);

    harness.click("#sendButton");
    await harness.settle();
    assert.deepEqual(harness.stopIds, [sendA]);

    harness.emitServerEvent({
      type: "done",
      sendId: sendA,
      state: cloneState(stateFixture()),
    });
    harness.releaseHeldSend();
    await harness.settle();

    harness.holdNextSend();
    harness.input("#prompt", "Prompt B");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendB = harness.sendIds[1];
    assert.ok(sendB);
    assert.notEqual(sendB, sendA);

    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(harness.stopIds, [sendA]);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a late confirmation response from send A cannot block or clear send B", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Prompt A");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    const sendA = harness.sendIds[0];
    assert.ok(sendA);

    harness.emitServerEvent({
      type: "confirm_request",
      sendId: sendA,
      id: "confirm-a",
      message: "Apply A?",
      groups: [{ title: "Song", rows: ["Set tempo to 120 BPM"] }],
    });
    harness.holdNextConfirmation();
    harness.clickButton("Apply");
    await Promise.resolve();

    harness.emitServerEvent({
      type: "done",
      sendId: sendA,
      state: cloneState(stateFixture()),
    });
    harness.releaseHeldSend();
    await Promise.resolve();

    harness.input("#prompt", "Prompt B");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    const sendB = harness.sendIds[1];
    assert.ok(sendB);

    harness.emitServerEvent({
      type: "confirm_request",
      sendId: sendB,
      id: "confirm-b-1",
      message: "Apply B first?",
      groups: [{ title: "Song", rows: ["Set tempo to 121 BPM"] }],
    });
    harness.clickButton("Apply");
    await harness.settle();
    assert.equal(
      harness.calls.filter((call) => call.path === "/confirm").length,
      2,
    );

    harness.emitServerEvent({
      type: "confirm_request",
      sendId: sendB,
      id: "confirm-b-2",
      message: "Apply B second?",
      groups: [{ title: "Song", rows: ["Set tempo to 122 BPM"] }],
    });
    harness.releaseHeldConfirmation();
    await harness.settle();

    assert.match(
      harness.document.querySelector(".confirm-card")?.textContent ?? "",
      /Apply B second/,
    );
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Waiting for your confirmation",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a background Session confirmation response cannot clear the active Session status", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Prepare Bass changes");
    harness.click("#sendButton");
    await Promise.resolve();
    const bassSendId = harness.sendIds[0];
    assert.ok(bassSendId);
    harness.emitServerEvent({
      type: "confirm_request",
      sendId: bassSendId,
      sessionId: "session-1",
      id: "confirm-bass",
      message: "Apply Bass changes?",
      groups: [{ title: "Bass", rows: ["Create MIDI clip"] }],
    });
    harness.holdNextConfirmation();
    harness.clickButton("Apply");
    await Promise.resolve();

    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    harness.holdNextSend();
    harness.input("#prompt", "Build Lead while Bass waits");
    harness.click("#sendButton");
    await Promise.resolve();
    const leadSendId = harness.sendIds[1];
    assert.ok(leadSendId);
    harness.emitServerEvent({
      type: "progress",
      sendId: leadSendId,
      sessionId: "session-2",
      message: "Writing Lead MIDI",
    });

    harness.releaseHeldConfirmation();
    await harness.settle();
    assert.equal(harness.document.querySelector("#status")?.textContent, "Writing Lead MIDI");
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.deepEqual(harness.errors, []);

    harness.releaseHeldSend();
    harness.releaseHeldSend();
    await harness.settle();
  } finally {
    harness.close();
  }
});

test("Session metadata uses locale-aware date formatting and ignores invalid dates", async () => {
  const state = stateFixture();
  state.sessions[1]!.updatedAt = "not-a-date";
  const harness = await createDialogHarness(state);
  try {
    const formatter = new harness.window.Intl.DateTimeFormat(undefined, {
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
    });
    const metadata = [...harness.document.querySelectorAll<HTMLElement>(".session-meta")]
      .map((element) => element.textContent);
    assert.equal(
      metadata[0],
      `track · ${formatter.format(new harness.window.Date("2026-08-01T00:00:00.000Z"))}`,
    );
    assert.equal(metadata[1], "track / Lead");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("assistant deltas update one draft node without rebuilding existing timeline items", async () => {
  const state = stateFixture();
  state.events = [{
    id: "event-1",
    kind: "user",
    content: "Make the chorus wider",
    createdAt: "2026-08-01T00:02:00.000Z",
  }];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#prompt", "Stream a response");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    const existingEvent = harness.document.querySelector(".timeline-item.user");
    assert.ok(existingEvent);

    harness.emitServerEvent({ type: "assistant_delta", sendId, delta: "I’ll widen" });
    const firstDraft = harness.document.querySelector(".timeline-item.streaming");
    assert.ok(firstDraft);
    assert.equal(firstDraft.querySelector(".timeline-content")?.textContent, "I’ll widen");
    assert.equal(
      harness.document.querySelector("#conversationAnnouncements")?.textContent,
      "",
    );

    harness.emitServerEvent({ type: "assistant_delta", sendId, delta: " the chorus." });
    const secondDraft = harness.document.querySelector(".timeline-item.streaming");
    assert.equal(secondDraft, firstDraft);
    assert.equal(harness.document.querySelector(".timeline-item.user"), existingEvent);
    assert.equal(
      secondDraft?.querySelector(".timeline-content")?.textContent,
      "I’ll widen the chorus.",
    );
    harness.emitServerEvent({
      type: "session_event",
      sendId,
      event: {
        id: "event-2",
        kind: "assistant",
        content: "I’ll widen the chorus.",
        createdAt: "2026-08-01T00:03:00.000Z",
      },
    });
    assert.equal(
      harness.document.querySelector("#conversationAnnouncements")?.textContent,
      "Live Smith: I’ll widen the chorus.",
    );
    assert.deepEqual(harness.errors, []);
    harness.releaseHeldSend();
    await harness.settle();
  } finally {
    harness.close();
  }
});

test("a full timeline render preserves expanded details and summary focus", async () => {
  const state = stateFixture();
  state.events = [{
    id: "tool-event",
    kind: "tool_call",
    name: "inspect_track",
    content: "Inspect Bass",
    createdAt: "2026-08-01T00:02:00.000Z",
  }];
  const harness = await createDialogHarness(state);
  try {
    const details = harness.document.querySelector<HTMLDetailsElement>(".timeline-item");
    const summary = details?.querySelector<HTMLElement>("summary");
    assert.ok(details);
    assert.ok(summary);
    details.open = true;
    summary.focus();

    harness.click("#newSessionButton");
    await harness.settle();

    const renderedDetails = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-item",
    );
    const renderedSummary = renderedDetails?.querySelector("summary");
    assert.equal(renderedDetails?.open, true);
    assert.equal(harness.document.activeElement, renderedSummary);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Duplicate then Discard restores the active saved profile", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#duplicateProfileButton");
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Studio Copy",
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Unsaved changes");

    harness.click("#discardProfileButton");
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Studio",
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.value,
      "profile-1",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("dirty drafts disable Send and Discard restores the clean gate", async () => {
  const harness = await createDialogHarness();
  try {
    const send = harness.document.querySelector<HTMLButtonElement>("#sendButton");
    const discard = harness.document.querySelector<HTMLButtonElement>("#discardProfileButton");
    assert.equal(send?.disabled, false);
    assert.equal(discard?.disabled, true);

    harness.input("#profileName", "Edited locally");
    assert.equal(send?.disabled, true);
    assert.equal(discard?.disabled, false);
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Unsaved changes");

    harness.click("#discardProfileButton");
    assert.equal(send?.disabled, false);
    assert.equal(discard?.disabled, true);
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("cancelling a dirty Profile switch preserves the draft and selector", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Keep this draft");
    harness.setConfirmResult(false);
    harness.select("#profileSelector", "profile-2");
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.value,
      "profile-1",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Keep this draft",
    );
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("failed global settings and Profile activation commands restore the saved UI state", async () => {
  const harness = await createDialogHarness();
  try {
    harness.failNextCommand("Could not save global settings.");
    harness.click("#autoApprove");
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#autoApprove")?.checked,
      false,
    );

    harness.failNextCommand("Could not activate Profile.");
    harness.select("#profileSelector", "profile-2");
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.value,
      "profile-1",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Studio",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("command IDs stay in headers and stale command SSE state cannot roll back newer UI state", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#newSessionButton");
    await harness.settle();
    const oldCommandId = harness.commandIds[0];
    assert.ok(oldCommandId);
    assert.deepEqual(commandCalls(harness)[0], {
      path: "/command",
      body: { kind: "new_session" },
    });

    harness.select("#profileSelector", "profile-2");
    await harness.settle();
    assert.equal(
      harness.document.querySelector("#activeProfileName")?.textContent,
      "Mix review",
    );

    harness.emitServerEvent({
      type: "state",
      commandId: oldCommandId,
      state: cloneState(stateFixture()),
    });

    assert.equal(
      harness.document.querySelector("#activeProfileName")?.textContent,
      "Mix review",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an unknown settings commit applies authoritative state instead of reverting the control", async () => {
  const harness = await createDialogHarness();
  try {
    const authoritative = cloneState(stateFixture());
    authoritative.settings.autoApprove = true;
    harness.failNextCommand(
      "Storage replacement completed, but its durable commit could not be confirmed.",
      undefined,
      { commandOutcome: "unknown", state: authoritative },
    );

    harness.click("#autoApprove");
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#autoApprove")?.checked,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /could not be confirmed/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an unreconciled command outcome keeps sends and settings blocked", async () => {
  const harness = await createDialogHarness();
  try {
    harness.failNextCommand(
      "Storage replacement completed, but its durable commit could not be confirmed.",
      undefined,
      { commandOutcome: "unknown", reconciliationRequired: true },
    );

    harness.click("#autoApprove");
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector("#settingsPanel")?.getAttribute("aria-busy"),
      "true",
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /could not be confirmed/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a command network error reconciles through state after the event stream disconnects", async () => {
  const harness = await createDialogHarness();
  try {
    harness.rejectNextCommand("Bridge response was lost.");
    harness.click("#autoApprove");
    await harness.settle();

    harness.emitServerEventError();
    await harness.settle();

    assert.equal(
      harness.calls.filter((call) => call.path === "/state").length,
      1,
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#autoApprove")?.checked,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.equal(
      harness.document.querySelector("#settingsPanel")?.getAttribute("aria-busy"),
      "false",
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /refreshed|verify/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a response-lost Profile save rebuilds the editor from reconciled state", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Studio reconciled");
    harness.rejectNextCommandResponse("Bridge response was lost.");
    harness.click("#saveProfileButton");
    await harness.settle();
    harness.emitServerEventError();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Studio reconciled",
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a response-lost Profile activation rebuilds the editor without rolling back", async () => {
  const harness = await createDialogHarness();
  try {
    harness.rejectNextCommandResponse("Bridge response was lost.");
    harness.select("#profileSelector", "profile-2");
    await harness.settle();
    harness.emitServerEventError();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.value,
      "profile-2",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Mix review",
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a response-lost Profile deletion rebuilds the editor from reconciled state", async () => {
  const harness = await createDialogHarness();
  try {
    harness.rejectNextCommandResponse("Bridge response was lost.");
    harness.click("#deleteProfileButton");
    await harness.settle();
    harness.emitServerEventError();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.value,
      "profile-2",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Mix review",
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a command network error blocks mutations when stream and state reconciliation fail", async () => {
  const harness = await createDialogHarness();
  try {
    harness.rejectNextCommand("Bridge response was lost.");
    harness.rejectNextState("Bridge state is unavailable.");
    harness.click("#autoApprove");
    await harness.settle();

    harness.emitServerEventError();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector("#settingsPanel")?.getAttribute("aria-busy"),
      "true",
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /could not.*reconcil|state.*unavailable/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Load Models sends the current draft without saving or overwriting it", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Draft discovery");
    harness.input("#apiKey", "draft-key");
    harness.input("#baseUrl", "https://draft.example/v1");
    harness.input("#model", "typed-model");
    harness.clickButton("Load Models");
    await harness.settle();

    const commands = commandCalls(harness);
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0], {
      path: "/command",
      body: {
        kind: "discover_models",
        profile: profileFixture({
          name: "Draft discovery",
          apiKey: "draft-key",
          baseUrl: "https://draft.example/v1",
          model: "typed-model",
        }),
      },
    });
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Draft discovery",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#model")?.value,
      "typed-model",
    );
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>("#modelOptions option")]
        .map((option) => option.value),
      ["model-discovered"],
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Load Models permits blank Draft name and model without changing Runtime display", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "");
    harness.input("#model", "");

    assert.equal(
      harness.document.querySelector("#activeProfileName")?.textContent,
      "Studio",
    );
    assert.equal(
      harness.document.querySelector("#activeProfileModel")?.textContent,
      "model-a",
    );
    assert.equal(
      harness.document.querySelector("#draftPreviewLabel")?.textContent,
      "Unsaved Draft preview",
    );

    harness.clickButton("Load Models");
    await harness.settle();

    const command = commandCalls(harness).at(-1);
    const body = command?.body as {
      kind: string;
      profile: { name: string; model: string };
    };
    assert.equal(body.kind, "discover_models");
    assert.equal(body.profile.name, "");
    assert.equal(body.profile.model, "");
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#model")?.value,
      "",
    );
    assert.equal(
      harness.document.querySelector("#activeProfileModel")?.textContent,
      "model-a",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a later discovery SSE state cannot replace the settled HTTP command state", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Draft discovery");
    harness.input("#apiKey", "draft-key");
    harness.input("#baseUrl", "https://draft.example/v1");
    harness.input("#model", "typed-model");
    harness.clickButton("Load Models");
    await harness.settle();

    assert.equal(harness.document.querySelectorAll("#modelOptions option").length, 1);
    const draft = profileFixture({
      name: "Draft discovery",
      apiKey: "draft-key",
      baseUrl: "https://draft.example/v1",
      model: "typed-model",
    });
    const discoveryState = Object.assign(cloneState(stateFixture()), {
      availableModels: [{
        id: "typed-model",
        displayName: "Typed model",
        capabilities: { ...capabilities(), maxOutputTokens: 24_000 },
      }],
      capabilities: { ...capabilities(), maxOutputTokens: 24_000 },
      modelStateSource: modelStateSourceFixture(draft),
    });

    harness.emitServerEvent({
      type: "state",
      commandId: harness.commandIds.at(-1),
      state: discoveryState,
    });

    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>("#modelOptions option")]
        .map((option) => option.value),
      ["model-discovered"],
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.max,
      "8192",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Draft discovery",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an earlier discovery SSE state is usable before its HTTP response arrives", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#apiKey", "draft-key");
    harness.input("#baseUrl", "https://draft.example/v1");
    harness.input("#model", "typed-model");
    const draft = profileFixture({
      apiKey: "draft-key",
      baseUrl: "https://draft.example/v1",
      model: "typed-model",
    });
    const discoveryState = Object.assign(cloneState(stateFixture()), {
      availableModels: [{
        id: "typed-model",
        displayName: "Typed model",
        capabilities: { ...capabilities(), maxOutputTokens: 24_000 },
      }],
      capabilities: { ...capabilities(), maxOutputTokens: 24_000 },
      modelStateSource: modelStateSourceFixture(draft),
    });
    harness.holdNextCommand();
    harness.clickButton("Load Models");
    await Promise.resolve();
    const commandId = harness.commandIds.at(-1);
    assert.ok(commandId);

    harness.emitServerEvent({ type: "state", commandId, state: discoveryState });
    await harness.settle();

    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>("#modelOptions option")]
        .map((option) => option.value),
      ["typed-model"],
    );
    harness.releaseHeldCommand();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Save Changes sends the complete current draft for its selected API mode", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Anthropic studio");
    harness.select("#apiFamily", "anthropic");
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>("#apiMode option")]
        .map((option) => option.value),
      ["messages"],
    );
    harness.input("#apiKey", "anthropic-key");
    harness.input("#baseUrl", "https://anthropic.example/v1");
    harness.input("#model", "claude-test");
    harness.input("#temperature", "0.7");
    harness.input("#maxOutputTokens", "4096");
    harness.input("#extraBody", "{\"metadata\":{\"source\":\"live\"}}");
    harness.click("#saveProfileButton");
    await harness.settle();

    assert.deepEqual(commandCalls(harness), [{
      path: "/command",
      body: {
        kind: "save_profile",
        profile: {
          id: "profile-1",
          name: "Anthropic studio",
          apiFamily: "anthropic",
          apiMode: "messages",
          apiKey: "anthropic-key",
          baseUrl: "https://anthropic.example/v1",
          model: "claude-test",
          parameters: {
            maxOutputTokens: 4096,
            temperature: 0.7,
            reasoning: { mode: "default" },
          },
          advanced: {
            extraBody: { metadata: { source: "live" } },
          },
        },
      },
    }]);
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("unsupported discovered parameters become an explicit repair draft before Save", async () => {
  const state = stateFixture();
  state.settings.profiles[0] = profileFixture({
    parameters: {
      maxOutputTokens: 32_000,
      temperature: 0.7,
      reasoning: { mode: "enabled", effort: "high", budgetTokens: 4096 },
    },
  });
  state.availableModels = [{
    id: "model-a",
    displayName: "Model A",
    capabilities: {
      ...capabilities(),
      temperature: "unsupported",
      reasoning: {
        supported: false,
        canDisable: false,
        efforts: [],
        budgetTokens: false,
        strategy: "none",
      },
    },
  }];
  const harness = await createDialogHarness(state);
  try {
    const temperature = harness.document.querySelector<HTMLInputElement>("#temperature");
    assert.equal(temperature?.disabled, true);
    assert.equal(temperature?.value, "");
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#reasoningMode")?.value,
      "default",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#reasoningBudgetTokens")?.value,
      "",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.value,
      "8192",
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Unsaved changes");
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled, true);

    harness.click("#saveProfileButton");
    await harness.settle();
    const save = commandCalls(harness).at(-1);
    assert.equal((save?.body as { kind?: string }).kind, "save_profile");
    assert.deepEqual(
      (save?.body as { profile: SavedProfile }).profile.parameters,
      { maxOutputTokens: 8192, reasoning: { mode: "default" } },
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Profile command errors identify and focus the invalid field", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.input("#baseUrl", "invalid-url");
    harness.failNextCommand("Base URL is invalid.", "baseUrl");
    harness.click("#saveProfileButton");
    await harness.settle();

    const baseUrl = harness.document.querySelector<HTMLInputElement>("#baseUrl");
    assert.equal(baseUrl?.getAttribute("aria-invalid"), "true");
    assert.equal(
      baseUrl?.closest(".field")?.querySelector(".field-error")?.textContent,
      "Base URL is invalid.",
    );
    assert.equal(harness.document.activeElement, baseUrl);
    assert.equal(
      harness.document.querySelector<HTMLElement>("#inspectorPane")?.hidden,
      false,
    );

    harness.input("#profileName", "Another name");
    assert.equal(baseUrl?.getAttribute("aria-invalid"), "true");
    assert.equal(
      baseUrl?.closest(".field")?.querySelector(".field-error")?.textContent,
      "Base URL is invalid.",
    );
    harness.click("#newSessionButton");
    await harness.settle();
    assert.equal(baseUrl?.getAttribute("aria-invalid"), "true");
    assert.equal(
      baseUrl?.closest(".field")?.querySelector(".field-error")?.textContent,
      "Base URL is invalid.",
    );
    harness.input("#baseUrl", "https://valid.example/v1");
    assert.equal(baseUrl?.hasAttribute("aria-invalid"), false);
    assert.equal(baseUrl?.closest(".field")?.querySelector(".field-error"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Save exposes pending feedback until the Profile command completes", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Studio updated");
    harness.holdNextCommand();
    harness.click("#saveProfileButton");
    await Promise.resolve();

    const save = harness.document.querySelector<HTMLButtonElement>("#saveProfileButton");
    assert.equal(save?.textContent, "Saving…");
    assert.equal(save?.disabled, true);
    const close = harness.document.querySelector<HTMLButtonElement>("#closeButton");
    assert.equal(close?.disabled, false);
    harness.setConfirmResult(false);
    close?.click();
    assert.deepEqual(harness.hostMessages, []);
    assert.equal(
      harness.document.querySelector("#settingsPanel")?.getAttribute("aria-busy"),
      "true",
    );
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /saving/i);

    harness.releaseHeldCommand();
    await harness.settle();

    assert.equal(save?.textContent, "Save Changes");
    assert.equal(save?.disabled, true);
    assert.equal(close?.disabled, false);
    assert.equal(
      harness.document.querySelector("#settingsPanel")?.getAttribute("aria-busy"),
      "false",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Cmd or Ctrl Enter cannot send while a command is running", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextCommand();
    harness.click("#newSessionButton");
    await Promise.resolve();
    harness.input("#prompt", "Do not send during save");
    harness.document.querySelector("#prompt")?.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", {
        bubbles: true,
        key: "Enter",
        metaKey: true,
      }),
    );
    await harness.settle();

    assert.deepEqual(harness.calls.filter((call) => call.path === "/send"), []);
    harness.releaseHeldCommand();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a late send completion cannot unlock controls owned by an active command", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Studio updated");
    harness.holdNextCommand();
    harness.click("#saveProfileButton");
    await Promise.resolve();
    harness.emitServerEvent({ type: "done", state: cloneState(stateFixture()) });

    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#saveProfileButton")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#discardProfileButton")?.disabled,
      true,
    );
    harness.releaseHeldCommand();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("unknown model output limits allow values above the 8192 profile default", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#model", "custom-unknown-model");
    const outputTokens = harness.document.querySelector<HTMLInputElement>(
      "#maxOutputTokens",
    );
    assert.equal(outputTokens?.max, "1000000");
    assert.equal(
      harness.document.querySelector("label[for='maxOutputTokens']")?.textContent,
      "Requested max output tokens",
    );
    assert.match(
      harness.document.querySelector("#maxOutputTokensHint")?.textContent ?? "",
      /model output limit is unknown/i,
    );

    harness.input("#maxOutputTokens", "64000");
    harness.click("#saveProfileButton");
    await harness.settle();

    const save = commandCalls(harness).find(
      (call) => (call.body as { kind?: string }).kind === "save_profile",
    );
    const savedProfile = (save?.body as {
      profile?: SavedProfile;
    }).profile;
    assert.equal(savedProfile?.model, "custom-unknown-model");
    assert.equal(savedProfile?.parameters.maxOutputTokens, 64_000);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("discovered model output limits still constrain the Profile input", async () => {
  const state = stateFixture();
  state.availableModels = [{
    id: "discovered-24k",
    displayName: "Discovered 24K",
    capabilities: { ...capabilities(), maxOutputTokens: 24_000 },
  }];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#model", "discovered-24k");
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.max,
      "24000",
    );
    assert.equal(
      harness.document.querySelector("#maxOutputTokensHint")?.textContent,
      "Model output limit: 24000.",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("capability cleanup clears stale field errors from values it removes or clamps", async () => {
  const state = stateFixture();
  state.capabilities = {
    ...capabilities(),
    reasoning: {
      supported: true,
      canDisable: true,
      efforts: ["high"],
      budgetTokens: true,
      strategy: "effort",
    },
  };
  state.settings.profiles[0] = profileFixture({
    parameters: {
      maxOutputTokens: 8192,
      temperature: 0.7,
      reasoning: { mode: "enabled", effort: "high", budgetTokens: 4096 },
    },
  });
  const harness = await createDialogHarness(state);
  try {
    harness.input("#profileName", "Needs capability repair");
    harness.failNextCommand("Temperature is invalid.", "parameters.temperature");
    harness.click("#saveProfileButton");
    await harness.settle();
    const temperature = harness.document.querySelector<HTMLInputElement>("#temperature");
    assert.equal(temperature?.getAttribute("aria-invalid"), "true");

    harness.select("#overrideTemperature", "unsupported");

    assert.equal(temperature?.value, "");
    assert.equal(temperature?.hasAttribute("aria-invalid"), false);
    assert.equal(harness.document.querySelector("#temperatureError"), null);

    harness.failNextCommand("Output limit is invalid.", "parameters.maxOutputTokens");
    harness.click("#saveProfileButton");
    await harness.settle();
    const output = harness.document.querySelector<HTMLInputElement>("#maxOutputTokens");
    assert.equal(output?.getAttribute("aria-invalid"), "true");

    harness.input("#overrideMaxOutputTokens", "1024");

    assert.equal(output?.value, "1024");
    assert.equal(output?.hasAttribute("aria-invalid"), false);
    assert.equal(harness.document.querySelector("#maxOutputTokensError"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("dynamic capability hints describe their controls and announce changes", async () => {
  const harness = await createDialogHarness();
  try {
    const output = harness.document.querySelector("#maxOutputTokens");
    const outputHint = harness.document.querySelector("#maxOutputTokensHint");
    const reasoning = harness.document.querySelector("#reasoningMode");
    const reasoningHint = harness.document.querySelector("#reasoningHint");

    assert.equal(output?.getAttribute("aria-describedby"), "maxOutputTokensHint");
    assert.equal(reasoning?.getAttribute("aria-describedby"), "reasoningHint");
    for (const hint of [outputHint, reasoningHint]) {
      assert.equal(hint?.getAttribute("role"), "status");
      assert.equal(hint?.getAttribute("aria-live"), "polite");
      assert.equal(hint?.getAttribute("aria-atomic"), "true");
    }
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

for (const [field, value, label] of [
  ["#baseUrl", "https://another-provider.example/v1", "Base URL"],
  ["#apiKey", "another-provider-key", "API key"],
] as const) {
  test(`changing the ${label} invalidates model limits from the previous connection`, async () => {
    const state = stateFixture();
    state.availableModels = [{
      id: "model-a",
      displayName: "Model A",
      capabilities: { ...capabilities(), maxOutputTokens: 8192 },
    }];
    const harness = await createDialogHarness(state);
    try {
      const originalValue = harness.document.querySelector<HTMLInputElement>(field)?.value;
      assert.ok(originalValue);
      assert.equal(
        harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.max,
        "8192",
      );
      assert.equal(harness.document.querySelectorAll("#modelOptions option").length, 1);

      harness.input(field, value);

      assert.equal(
        harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.max,
        "1000000",
      );
      assert.match(
        harness.document.querySelector("#maxOutputTokensHint")?.textContent ?? "",
        /model output limit is unknown/i,
      );
      assert.equal(harness.document.querySelectorAll("#modelOptions option").length, 0);

      harness.input(field, originalValue);

      assert.equal(
        harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.max,
        "8192",
      );
      assert.equal(harness.document.querySelectorAll("#modelOptions option").length, 1);
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}

for (const [field, value, label] of [
  ["#baseUrl", "https://rotated-provider.example/v1", "Base URL"],
  ["#apiKey", "rotated-provider-key", "API key"],
] as const) {
  test(`changing the ${label} preserves reasoning values while draft capabilities are unknown`, async () => {
    const state = stateFixture();
    const reasoningProfile = profileFixture({
      parameters: {
        maxOutputTokens: 8192,
        reasoning: { mode: "enabled", effort: "high", budgetTokens: 4096 },
      },
    });
    state.settings.profiles[0] = reasoningProfile;
    state.modelStateSource = modelStateSourceFixture(reasoningProfile);
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
      harness.input(field, value);

      assert.equal(
        harness.document.querySelector<HTMLSelectElement>("#reasoningMode")?.value,
        "enabled",
      );
      assert.equal(
        harness.document.querySelector<HTMLSelectElement>("#reasoningEffort")?.value,
        "high",
      );
      assert.equal(
        harness.document.querySelector<HTMLInputElement>("#reasoningBudgetTokens")?.value,
        "4096",
      );

      harness.click("#saveProfileButton");
      await harness.settle();
      const saved = commandCalls(harness).at(-1)?.body as {
        kind?: string;
        profile?: SavedProfile;
      };
      assert.equal(saved.kind, "save_profile");
      assert.deepEqual(saved.profile?.parameters.reasoning, {
        mode: "enabled",
        effort: "high",
        budgetTokens: 4096,
      });
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}

test("Send posts only the prompt and active session ID", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Make the drums wider");
    harness.click("#sendButton");
    await harness.settle();

    assert.deepEqual(
      harness.calls.filter((call) => call.path === "/send"),
      [{
        path: "/send",
        body: {
          prompt: "Make the drums wider",
          sessionId: "session-1",
        },
      }],
    );
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Send rejects an empty composer without creating a request", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.input("#prompt", "   ");
    harness.click("#sendButton");
    await harness.settle();

    assert.equal(harness.calls.some((call) => call.path === "/send"), false);
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /Enter a request/);
    assert.equal(harness.document.activeElement?.id, "prompt");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Send restores the prompt only when the bridge says it was not persisted", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Retry this safe prompt");
    harness.failNextSend("Profile validation failed.", "not_persisted");
    harness.click("#sendButton");
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Retry this safe prompt",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Send remains busy until its HTTP fallback state refresh settles", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextState();
    harness.input("#prompt", "Keep this attempt active");
    harness.click("#sendButton");
    for (let index = 0; index < 20; index += 1) {
      if (harness.calls.some((call) => call.path === "/state")) break;
      await Promise.resolve();
    }
    assert.equal(
      harness.calls.some((call) => call.path === "/state"),
      true,
    );

    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      true,
    );

    harness.releaseHeldState();
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("HTTP send completion clears stale streaming and confirmation UI before terminal SSE", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Complete through the HTTP fallback");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({ type: "assistant_delta", sendId, delta: "Transient draft" });
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      id: "confirm-http-race",
      message: "Apply changes?",
      groups: [{ title: "Track", rows: ["Create clip"] }],
    });
    harness.holdNextConfirmation();
    harness.clickButton("Apply");
    await Promise.resolve();
    assert.ok(harness.document.querySelector(".timeline-item.streaming"));
    assert.ok(harness.document.querySelector(".confirm-card"));

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(harness.document.querySelector(".timeline-item.streaming"), null);
    assert.equal(harness.document.querySelector(".confirm-card"), null);

    harness.releaseHeldConfirmation();
    await harness.settle();
    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("stopping a send clears its unpersisted streaming draft", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Stop after a partial response");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({ type: "assistant_delta", sendId, delta: "Partial response" });
    assert.ok(harness.document.querySelector(".timeline-item.streaming"));

    harness.click("#sendButton");
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(harness.document.querySelector(".timeline-item.streaming"), null);

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a reconciled send failure clears its unpersisted streaming draft", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.failNextSend("The model request failed.", "persisted");
    harness.input("#prompt", "Fail after a partial response");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({ type: "assistant_delta", sendId, delta: "Partial response" });
    assert.ok(harness.document.querySelector(".timeline-item.streaming"));

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(harness.document.querySelector(".timeline-item.streaming"), null);
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /timeline/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an expanded timeline Error does not repeat its summary line in the body", async () => {
  const state = stateFixture();
  state.events = [{
    id: "event-error-once",
    createdAt: "2026-08-06T00:00:00.000Z",
    kind: "error",
    content: [
      "Live action plan failed after 9 completed actions.",
      "Failed action 10: Insert Delay.",
    ].join("\n"),
  }];
  const harness = await createDialogHarness(state);
  try {
    const itemText = harness.document.querySelector(".timeline-item.error")?.textContent ?? "";
    assert.equal(
      itemText.match(/Live action plan failed after 9 completed actions\./g)?.length,
      1,
    );
    assert.match(itemText, /Failed action 10: Insert Delay/);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("multiline user and assistant messages keep their first line", async () => {
  const state = stateFixture();
  state.events = [
    {
      id: "event-multiline-user",
      createdAt: "2026-08-06T00:00:00.000Z",
      kind: "user",
      content: "Build the drums\nThen add the bass",
    },
    {
      id: "event-multiline-assistant",
      createdAt: "2026-08-06T00:00:01.000Z",
      kind: "assistant",
      content: "Drums are ready\nBass is next",
    },
  ];
  const harness = await createDialogHarness(state);
  try {
    const items = [...harness.document.querySelectorAll(".timeline-item .timeline-content")]
      .map((item) => item.textContent);
    assert.deepEqual(items, [
      "Build the drums\nThen add the bass",
      "Drums are ready\nBass is next",
    ]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an expanded partial Apply Result does not repeat its summary line", async () => {
  const state = stateFixture();
  const partialError = new AgentPartialCompletionError(
    Array.from({ length: 9 }, (_, index) => `Completed action ${index + 1}.`),
    new Error("Failed to insert device"),
    9,
    {
      type: "insert_device",
      trackName: "FB Lead",
      deviceName: "Ping Pong Delay",
      index: 2,
    },
    "FB Lead",
  );
  state.events = [{
    id: "event-partial-apply-once",
    createdAt: "2026-08-06T00:00:00.000Z",
    kind: "apply_result",
    content: partialError.message,
  }];
  const harness = await createDialogHarness(state);
  try {
    const item = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-item.apply_result",
    );
    assert.equal(item?.querySelector("summary")?.textContent?.startsWith("Partial Apply —"), true);
    item?.setAttribute("open", "");
    const itemText = item?.textContent ?? "";
    assert.equal(
      itemText.match(/Live action plan partially completed after 9 action\(s\)\./g)?.length,
      1,
    );
    assert.match(itemText, /Failed action 10: Insert Live device "Ping Pong Delay"/);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a reconciled persisted failure keeps full detail in timeline instead of status", async () => {
  const state = stateFixture();
  const failureDetail = "HOST-FAILURE-DETAIL: failed action 10 on FB Lead.";
  state.events = [{
    id: "event-persisted-error",
    createdAt: "2026-08-06T00:00:00.000Z",
    kind: "error",
    content: failureDetail,
  }];
  const harness = await createDialogHarness(state);
  try {
    harness.failNextSend(failureDetail, "persisted");
    harness.input("#prompt", "Continue safely");
    harness.click("#sendButton");
    await harness.settle();

    const status = harness.document.querySelector("#status")?.textContent ?? "";
    const timeline = harness.document.querySelector("#timeline")?.textContent ?? "";
    assert.match(status, /timeline/i);
    assert.doesNotMatch(status, /HOST-FAILURE-DETAIL/);
    assert.match(timeline, /HOST-FAILURE-DETAIL/);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Send keeps its attempt busy when the HTTP fallback state is unavailable", async () => {
  const harness = await createDialogHarness();
  try {
    harness.failNextState("Bridge state is unavailable.");
    harness.input("#prompt", "Do not silently settle this send");
    harness.click("#sendButton");
    await harness.settle();

    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      true,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /outcome|state.*unavailable/i,
    );

    harness.click("#sendButton");
    await harness.settle();

    assert.deepEqual(harness.stopIds, [sendId]);
    assert.deepEqual(
      harness.calls
        .filter((call) => ["/send", "/stop", "/state"].includes(call.path))
        .map((call) => call.path),
      ["/send", "/state", "/stop", "/state"],
    );
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

for (const promptPersistence of ["persisted", undefined] as const) {
  test(`a ${promptPersistence ?? "unknown"} send failure stays busy until authoritative state recovers`, async () => {
    const harness = await createDialogHarness();
    try {
      harness.failNextSend("The model request failed.", promptPersistence);
      if (promptPersistence === "persisted") {
        harness.failNextState("Bridge state is unavailable.");
      } else {
        harness.rejectNextState("Bridge state is unavailable.");
      }
      harness.input("#prompt", "Do not duplicate this persisted prompt");
      harness.click("#sendButton");
      await harness.settle();

      const sendId = harness.sendIds[0];
      assert.ok(sendId);
      assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
      assert.equal(
        harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
        true,
      );
      assert.equal(
        harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
        "",
      );
      assert.match(
        harness.document.querySelector("#status")?.textContent ?? "",
        /authoritative state.*unavailable/i,
      );

      harness.click("#sendButton");
      await harness.settle();

      assert.deepEqual(harness.stopIds, [sendId]);
      assert.deepEqual(
        harness.calls
          .filter((call) => ["/send", "/stop", "/state"].includes(call.path))
          .map((call) => call.path),
        ["/send", "/state", "/stop", "/state"],
      );
      assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
      assert.equal(
        harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
        false,
      );
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}

test("an SSE send error restores once before the matching HTTP error arrives", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Restore exactly once");
    harness.holdNextSend();
    harness.failNextSend("Profile validation failed.", "not_persisted");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.emitServerEvent({
      type: "error",
      sendId,
      message: "Profile validation failed.",
      promptPersistence: "not_persisted",
    });
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Restore exactly once",
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Restore exactly once",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an SSE done settles its send before a late HTTP failure or command error", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Completed through SSE");
    harness.holdNextSend();
    harness.failNextSend("Late HTTP transport loss.");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.emitServerEvent({ type: "done", sendId, state: cloneState(stateFixture()) });
    harness.emitServerEvent({ type: "error", message: "Command failed separately." });
    await harness.settle();

    assert.equal(harness.document.querySelector("#status")?.textContent, "Command failed separately.");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.document.querySelector("#status")?.textContent, "Command failed separately.");
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /send result is unknown/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("late SSE from send A cannot settle send B or restore A over B", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Prompt A");
    harness.click("#sendButton");
    await harness.settle();
    const sendA = harness.sendIds[0];
    assert.ok(sendA);

    harness.input("#prompt", "Prompt B");
    harness.holdNextSend();
    harness.failNextSend("Prompt B was rejected before persistence.", "not_persisted");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendB = harness.sendIds[1];
    assert.ok(sendB);
    assert.notEqual(sendB, sendA);

    harness.emitServerEvent({
      type: "done",
      sendId: sendA,
      state: cloneState(stateFixture()),
    });
    harness.emitServerEvent({
      type: "error",
      sendId: sendA,
      message: "Late failure from Prompt A.",
      promptPersistence: "persisted",
    });
    await harness.settle();

    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      true,
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Prompt B",
    );
    assert.notEqual(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Prompt A",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

for (const promptPersistence of ["persisted", undefined] as const) {
  test(`Send does not restore a ${promptPersistence ?? "network-unknown"} prompt result`, async () => {
    const harness = await createDialogHarness();
    try {
      harness.input("#prompt", "Do not duplicate this prompt");
      harness.failNextSend("The model request failed.", promptPersistence);
      harness.click("#sendButton");
      await harness.settle();

      assert.equal(
        harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
        "",
      );
      assert.equal(
        harness.calls.some((call) => call.path === "/state"),
        true,
      );
      assert.match(
        harness.document.querySelector("#status")?.textContent ?? "",
        /timeline|session|before trying again/i,
      );
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}

test("session actions send only their command-specific fields", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#newSessionButton");
    await harness.settle();

    const leadRow = [...harness.document.querySelectorAll<HTMLButtonElement>(".session-row")]
      .find((row) => row.textContent?.includes("Lead session"));
    assert.ok(leadRow);
    leadRow.click();
    await harness.settle();

    const leadTitle = [...harness.document.querySelectorAll<HTMLElement>(".session-title")]
      .find((title) => title.textContent === "Lead session");
    assert.ok(leadTitle);
    leadTitle.dispatchEvent(new harness.window.MouseEvent("dblclick", { bubbles: true }));
    const rename = harness.document.querySelector<HTMLInputElement>(".session-rename-input");
    assert.ok(rename);
    rename.value = "Lead ideas";
    rename.dispatchEvent(new harness.window.Event("blur"));
    await harness.settle();

    harness.click("#deleteSession");
    await harness.settle();

    assert.deepEqual(commandCalls(harness), [
      { path: "/command", body: { kind: "new_session" } },
      {
        path: "/command",
        body: { kind: "select_session", sessionId: "session-2" },
      },
      {
        path: "/command",
        body: {
          kind: "rename_session",
          sessionId: "session-2",
          title: "Lead ideas",
        },
      },
      {
        path: "/command",
        body: { kind: "delete_session", sessionId: "session-2" },
      },
    ]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
