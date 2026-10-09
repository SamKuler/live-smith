import type { ChatBridgeCommandInput } from "../../app/chat/chat-bridge-http.js";
import type { AudioProvider } from "../../audio-services/contracts.js";
import type { SunoAccountView } from "../../audio-services/suno/suno-session-contracts.js";
import type { SunoModelCatalogView } from "../chat-state.js";
import type { AudioConnectionDraft, AudioConnectionEditorValue, createConnectionState } from "./connection-state.js";
import {
  audioServiceCapabilities as configuredAudioCapabilities,
  usesImportedSession,
  WIRE_MAX_INTEGRATION_CONNECTIONS,
  type AudioDescriptor,
} from "./wire-contracts/contracts.js";
import { compareDecimalRevisions, sameJsonValue } from "./wire-contracts/primitives.js";

type EditorElements = {
  audioDraftStatus: HTMLElement;
  audioServiceApiKey: HTMLInputElement;
  audioServiceCallback: HTMLInputElement;
  audioServiceCallbackField: HTMLElement;
  audioServiceConflict: HTMLElement;
  audioServiceDisclosure: HTMLElement;
  audioServiceEditorSummary: HTMLElement;
  audioServiceEnabled: HTMLInputElement;
  audioServiceEnabledField: HTMLElement;
  audioServiceFields: HTMLDetailsElement;
  audioServiceKeyBadge: HTMLElement;
  audioServiceKeyField: HTMLElement;
  audioServiceKeyStatus: HTMLElement;
  audioServiceModel: HTMLInputElement;
  audioServiceModelField: HTMLDetailsElement;
  audioServiceModelHint: HTMLElement;
  audioServiceModelOptions: HTMLDataListElement;
  audioServiceModelSummary: HTMLElement;
  audioServiceName: HTMLInputElement;
  audioServiceOperations: HTMLElement;
  audioServiceProvider: HTMLSelectElement;
  clearAudioServiceButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  connectSunoButton: HTMLButtonElement;
  extensionsPanel: HTMLElement;
  inspectorPane: HTMLElement;
  loadSunoModelsButton: HTMLButtonElement;
  logoutSunoButton: HTMLButtonElement;
  openSunoPlatformButton: HTMLButtonElement;
  openSunoWebsiteButton: HTMLButtonElement;
  refreshSunoLoginButton: HTMLButtonElement;
  reloadAudioServiceButton: HTMLButtonElement;
  removeAudioServiceButton: HTMLButtonElement;
  saveAudioServiceButton: HTMLButtonElement;
  sunoAccountName: HTMLElement;
  sunoAuthStateBadge: HTMLElement;
  sunoCookieEditor: HTMLDetailsElement;
  sunoLoginControls: HTMLElement;
  sunoLoginStatus: HTMLElement;
  sunoModelPicker: HTMLSelectElement;
  sunoModelSelection: HTMLElement;
  sunoModelStatus: HTMLElement;
  sunoPlatformActions: HTMLElement;
  sunoSessionValue: HTMLInputElement;
};

type AudioEditorCommand = Extract<ChatBridgeCommandInput, {
  kind:
  "save_global_settings" | "open_suno_website" | "open_suno_platform" | "import_suno_session" |
  "refresh_suno_login" | "logout_suno" | "load_suno_models";
}>;
type Text = string | (() => string);
interface CommandOutcome { known: boolean; succeeded: boolean }
interface AudioEditorOptions {
  connectionState: ReturnType<typeof createConnectionState>;
  readBridgeState(): {
    commandKind: string | null;
    reconciliationBlocked: boolean;
    closePending: boolean;
    sunoAccounts: readonly SunoAccountView[];
    sunoModelCatalog: SunoModelCatalogView | undefined;
  };
  runCommand<K extends AudioEditorCommand["kind"]>(
    kind: K,
    extra?: Omit<Extract<AudioEditorCommand, { kind: K }>, "kind">,
    options?: { cancellable?: boolean; onOutcome?: (outcome: CommandOutcome) => void },
  ): Promise<boolean>;
  invalidateSunoCatalog(): void;
  confirmAction(options: { title: Text; message: Text; acceptLabel: Text; danger: boolean }): Promise<boolean>;
  showStatus(message: Text, isError?: boolean): void;
  i18n: {
    t(source: string, values?: Record<string, string | number>): string;
    message(source: string, values?: Record<string, string | number>): Text;
  };
  isWireAudioCallback(value: AudioConnectionEditorValue): boolean;
  createCorrelationId(prefix: string): string;
  audioOperationLabel(operation: string): string;
  onRender(): void;
}

/** Owns Connection form behavior, submission state, account controls and secret input lifetime. */
export function createAudioConnectionEditor(options: AudioEditorOptions) {
  const { connectionState, readBridgeState, runCommand, invalidateSunoCatalog, confirmAction,
    showStatus, i18n, isWireAudioCallback, createCorrelationId, audioOperationLabel, onRender } = options;
  const t = i18n.t;
  const audioServiceCapabilities = configuredAudioCapabilities as Readonly<Record<AudioProvider, AudioDescriptor>>;
  let sunoModelLoadingId: string | null = null;
  let sunoModelLoadErrorId: string | null = null;
  let sunoInputRevision = 0;
  let audioSettingsSubmitting = false;
  let audioSettingsBusy = false;
  const sunoLoginCommands = new Set<string | null>(["open_suno_website", "open_suno_platform", "import_suno_session", "refresh_suno_login", "logout_suno", "load_suno_models"]);
  function element<K extends keyof EditorElements>(id: K): EditorElements[K] {
    return document.getElementById(id) as EditorElements[K];
  }

  function bindAudioControls() {
    const cookieInput = element("sunoSessionValue");
    if (cookieInput.oninput) return;
    cookieInput.oninput = renderAudioTools;
    cookieInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      void importSunoCookie();
    });
    element("closeButton").addEventListener("click", clearSunoCookieInput, true);
    window.addEventListener("pagehide", clearSunoCookieInput);
    window.addEventListener("beforeunload", clearSunoCookieInput);
    const cookieVisibility = new MutationObserver((changes) => {
      if (changes.some(({ target, attributeName }) => attributeName === "hidden" ? (target as HTMLElement).hidden : !(target as HTMLDetailsElement).open)) {
        clearSunoCookieInput();
        renderAudioTools();
      }
    });
    for (const id of ["inspectorPane", "extensionsPanel"] as const) {
      cookieVisibility.observe(element(id), { attributes: true, attributeFilter: ["hidden"] });
    }
    cookieVisibility.observe(element("audioServiceFields"), { attributes: true, attributeFilter: ["open"] });
    cookieVisibility.observe(element("sunoCookieEditor"), { attributes: true, attributeFilter: ["open"] });
  }

  function savedAudioConnection(id = connectionState.selectedId) {
    return connectionState.savedAudio(id);
  }

  function audioConnectionFields(service: AudioConnectionEditorValue) {
    const { id, name, provider, enabled, modelId, callbackUrl } = service;
    return { id, name, provider, enabled, ...(modelId ? { modelId } : {}), ...(callbackUrl ? { callbackUrl } : {}) };
  }

  function discardUnchangedAudioDraft() {
    const draft = connectionState.drafts.get(connectionState.selectedId ?? "");
    // Submission clears the key input too; its outcome still owns the draft.
    if (audioSettingsSubmitting || !draft?.baseConnection || draft.conflict || draft.outcomeUnknown ||
      element("audioServiceApiKey").value ||
      !sameJsonValue(audioConnectionFields(draft.connection), audioConnectionFields(draft.baseConnection))) return false;
    return connectionState.drafts.delete(connectionState.selectedId ?? "");
  }

  function audioServiceModelHint(service: AudioConnectionEditorValue) {
    const capability = audioServiceCapabilities[service.provider];
    const model = service.modelId || capability.defaultModelId;
    const fixedDuration = model && capability.fixedMusicDurationSecondsByModel?.[model];
    if (fixedDuration !== undefined) {
      return t("{model} always generates {seconds} seconds.", { model: model!, seconds: fixedDuration });
    }
    if (model && capability.instrumentalOnlyModelIds?.includes(model)) {
      return t("{model} uses streaming generation, supports explicit duration, and generates instrumental audio only.", { model });
    }
    if (model && capability.promptGuidedDurationModelIds?.includes(model)) {
      return t("{model} uses prompt-guided duration; requested seconds are guidance rather than an exact cut.", { model });
    }
    if (capability.defaultModelId) {
      return t("Leave blank to use {model}. This integration uses prompt-based generation without custom mode or a duration setting.",
        { model: capability.defaultModelId });
    }
    return usesImportedSession(capability)
      ? t("Normally choose Music version above. Only enter an exact model ID for an explicit override; leave blank for the account default.")
      : t("Leave blank to use the integration default. Sound effects use a dedicated model.");
  }

  function handleAudioServiceSelection(id: string) {
    if (audioSettingsSubmitting || audioSettingsBusy && !sunoLoginCommands.has(readBridgeState().commandKind)) return;
    if (!savedAudioConnection(id) && !connectionState.drafts.has(id)) return;
    if (id !== connectionState.selectedId) {
      element("audioServiceApiKey").value = "";
      clearSunoCookieInput();
      discardUnchangedAudioDraft();
    }
    connectionState.selectedId = id;
    element("audioServiceFields").open = true;
    renderAudioTools();
  }

  function addAudioService() {
    if (audioSettingsBusy || audioSettingsSubmitting) return;
    const count = new Set([...connectionState.audioConnections().map((service) => service.id),
    ...connectionState.drafts.keys()]).size;
    if (count + connectionState.nonAudioCount >= WIRE_MAX_INTEGRATION_CONNECTIONS) return;
    const id = createCorrelationId("audio-service");
    const provider = (Object.keys(audioServiceCapabilities) as AudioProvider[]).find((provider) =>
      audioServiceCapabilities[provider].tools.length > 0 ||
      usesImportedSession(audioServiceCapabilities[provider]));
    if (!provider) return;
    clearSunoCookieInput();
    element("audioServiceApiKey").value = "";
    discardUnchangedAudioDraft();
    connectionState.drafts.set(id, {
      connection: { id, name: "", provider, enabled: false },
      baseConnection: null, expectedRevision: connectionState.revision || "0", conflict: false
    });
    connectionState.selectedId = id;
    element("audioServiceFields").open = true;
    renderAudioTools();
    element("audioServiceName").focus();
  }

  function reloadAudioService() {
    if (audioSettingsBusy || audioSettingsSubmitting) return;
    connectionState.drafts.delete(connectionState.selectedId ?? "");
    clearSunoCookieInput();
    element("audioServiceApiKey").value = "";
    if (!savedAudioConnection()) connectionState.selectedId = connectionState.audioConnections()[0]?.id || null;
    renderAudioTools();
  }

  function handleAudioSettingsInput() {
    if (audioSettingsBusy || audioSettingsSubmitting || !connectionState.selectedId) return;
    const saved = savedAudioConnection();
    const previous = connectionState.drafts.get(connectionState.selectedId ?? "");
    const provider = element("audioServiceProvider").value as AudioProvider;
    const providerChanged = provider !== (previous?.connection.provider || saved?.provider);
    if (providerChanged) {
      clearSunoCookieInput();
      element("audioServiceApiKey").value = "";
      element("audioServiceEnabled").checked = false;
      element("audioServiceModel").value = "";
      element("audioServiceCallback").value = "";
    }
    const modelId = element("audioServiceModel").value.trim();
    const callbackUrl = element("audioServiceCallback").value;
    const supported = audioServiceCapabilities[provider].tools;
    connectionState.drafts.set(connectionState.selectedId, {
      connection: {
        id: connectionState.selectedId, name: element("audioServiceName").value,
        provider, enabled: supported.length > 0 && element("audioServiceEnabled").checked,
        ...(audioServiceCapabilities[provider].modelConfigurable && modelId ? { modelId } : {}),
        ...(audioServiceCapabilities[provider]?.callbackUrl && callbackUrl ? { callbackUrl } : {})
      },
      baseConnection: previous ? previous.baseConnection : saved,
      expectedRevision: previous?.expectedRevision || connectionState.revision || "0",
      conflict: previous?.conflict || false,
      ...(previous?.outcomeUnknown ? { outcomeUnknown: true } : {}),
    });
    discardUnchangedAudioDraft();
    renderAudioTools();
  }

  async function saveAudioServiceSettings(clear = false) {
    if (audioSettingsBusy || audioSettingsSubmitting || !connectionState.selectedId) return false;
    const id = connectionState.selectedId;
    const saved = savedAudioConnection(id);
    const draft = connectionState.drafts.get(id);
    if (draft?.conflict || (!clear && !draft) || (clear && !saved)) return false;
    if (clear && usesImportedSession(audioServiceCapabilities[saved!.provider])) return false;
    if (clear && !(await confirmAudioConnectionChange("clear", saved!))) return false;
    // Clear acts on the saved connection, so a provider draft cannot redirect it.
    const connection = clear ? { ...audioConnectionFields(saved!), enabled: false }
      : { ...draft!.connection, name: draft!.connection.name.trim() };
    const key = element("audioServiceApiKey");
    const sessionImport = usesImportedSession(audioServiceCapabilities[connection.provider]);
    if (sessionImport) key.value = "";
    if (!connection.name || connectionState.audioConnections().some((service) =>
      service.id !== id && service.name.toLowerCase() === connection.name.toLowerCase())) {
      showStatus(t("Enter a unique connection name."), true);
      element("audioServiceName").focus();
      return false;
    }
    if (connection.enabled && !sessionImport && !key.value &&
      !(saved?.provider === connection.provider && saved.apiKeyConfigured)) {
      showStatus(t("Enter an API key before enabling this connection."), true);
      key.focus();
      return false;
    }
    if (!isWireAudioCallback(connection)) {
      showStatus(t("Enter an HTTP or HTTPS callback URL with valid encoding and no embedded credentials, fragment, or whitespace (maximum 2048 characters)."), true);
      element("audioServiceCallback").focus();
      return false;
    }
    if (connection.callbackUrl && key.value &&
      decodeURIComponent(connection.callbackUrl).toLowerCase().includes(key.value.toLowerCase())) {
      showStatus(t("The callback URL must not contain API credentials."), true);
      element("audioServiceCallback").focus();
      return false;
    }
    const submittedKey = key.value;
    const descriptor = audioServiceCapabilities[connection.provider];
    const patch = {
      action: "upsert" as const,
      expectedRevision: draft?.expectedRevision || connectionState.revision || "0",
      connection: {
        id: connection.id,
        name: connection.name,
        pluginId: descriptor.pluginId,
        enabled: connection.enabled,
        configuration: {
          ...(connection.modelId === undefined ? {} : { modelId: connection.modelId }),
          ...(connection.callbackUrl === undefined ? {} : { callbackUrl: connection.callbackUrl }),
        },
        ...(clear ? { secrets: { apiKey: "" } }
          : submittedKey ? { secrets: { apiKey: submittedKey } } : {}),
      },
    };
    // Only this command owns the secret; client state and connection drafts never receive it.
    key.value = "";
    audioSettingsSubmitting = true;
    renderAudioTools();
    let savedRevision: string | null = null;
    try {
      await runCommand("save_global_settings", { integrationConnections: patch }, {
        onOutcome: (outcome) => {
          if (draft && connectionState.drafts.get(id) === draft &&
            !outcome.known && (outcome.succeeded || readBridgeState().reconciliationBlocked)) draft.outcomeUnknown = true;
          const current = savedAudioConnection(id);
          if (outcome.known && outcome.succeeded && current &&
            compareDecimalRevisions(connectionState.revision!, patch.expectedRevision) > 0 &&
            sameJsonValue(audioConnectionFields(current), connection) &&
            current.apiKeyConfigured === (clear ? false : Boolean(patch.connection.secrets?.apiKey ||
              saved?.provider === connection.provider && saved.apiKeyConfigured))) {
            connectionState.drafts.delete(id);
            savedRevision = connectionState.revision!;
          }
        },
      });
      return savedRevision;
    } finally {
      audioSettingsSubmitting = false;
      renderAudioTools();
    }
  }

  async function removeAudioService() {
    if (audioSettingsBusy || audioSettingsSubmitting || !connectionState.selectedId) return false;
    const id = connectionState.selectedId;
    const draft = connectionState.drafts.get(id);
    if (draft?.conflict) return false;
    if (!savedAudioConnection(id)) {
      reloadAudioService();
      return true;
    }
    if (!(await confirmAudioConnectionChange("remove", savedAudioConnection(id)!))) return false;
    clearSunoCookieInput();
    element("audioServiceApiKey").value = "";
    audioSettingsSubmitting = true;
    renderAudioTools();
    try {
      const result = await runCommand("save_global_settings", {
        integrationConnections: {
          action: "remove", connectionId: id,
          expectedRevision: draft?.expectedRevision || connectionState.revision || "0",
        }
      }, {
        onOutcome: (outcome) => {
          if (draft && connectionState.drafts.get(id) === draft &&
            !outcome.known && (outcome.succeeded || readBridgeState().reconciliationBlocked)) draft.outcomeUnknown = true;
          if (outcome.known && outcome.succeeded && !savedAudioConnection(id)) {
            connectionState.drafts.delete(id);
            connectionState.selectedId = connectionState.audioConnections()[0]?.id || null;
          }
        }
      });
      return result;
    } finally {
      audioSettingsSubmitting = false;
      renderAudioTools();
    }
  }

  async function confirmAudioConnectionChange(action: "clear" | "remove", service: AudioConnectionEditorValue) {
    const revision = connectionState.revision;
    const accepted = await confirmAction({
      title: i18n.message(action === "clear" ? "Clear this connection's key?" : "Remove this connection?"),
      message: i18n.message(action === "clear"
        ? "Clear the saved key for “{name}” and disable this connection? Downloaded audio stays available."
        : "Remove “{name}”? Downloaded audio stays available, but remote jobs will lose this saved connection.", { name: service.name }),
      acceptLabel: i18n.message(action === "clear" ? "Clear key" : "Remove connection"), danger: true,
    });
    return accepted && !audioSettingsBusy && !audioSettingsSubmitting &&
      connectionState.selectedId === service.id && connectionState.revision === revision;
  }

  function sunoAccountPresentation(serviceId: string) {
    const account = readBridgeState().sunoAccounts.find((entry) => entry.serviceId === serviceId);
    const detail = (account?.status === "signed_in" || account?.status === "saved") && account.accountName
      ? t("Suno account: {accountName}", { accountName: account.accountName })
      : "";
    const presentations = {
      signed_in: { state: "signed-in", badge: t("Connected"), title: t("Connected to Suno.com") },
      saved: { state: "pending", badge: t("Waiting"), title: t("Cookie saved; refresh to verify") },
      expired: { state: "unavailable", badge: t("Needs setup"), title: t("Cookie expired; import a fresh Suno Cookie") },
      unavailable: { state: "unavailable", badge: t("Unavailable"), title: t("Suno verification unavailable; try again later") },
      signed_out: { state: "signed-out", badge: t("Signed out"), title: t("Not connected") },
    };
    const presentation = (account && presentations[account.status]) || { state: "unchecked", badge: t("Not checked"), title: t("No verified Suno connection") };
    return { account, state: presentation.state, badge: presentation.badge, title: presentation.title, detail };
  }

  function sunoAccountStatus(serviceId: string) {
    return sunoAccountPresentation(serviceId).title;
  }

  function audioConnectionPresentation(value: AudioConnectionEditorValue, configured: AudioConnectionEditorValue | null, draft: AudioConnectionDraft | undefined) {
    if (draft?.conflict) return { label: t("Needs attention"), status: "partial" };
    if (draft) return { label: t("Unsaved changes"), status: "partial" };
    if (!configured) return { label: t("Needs setup"), status: "partial" };
    if (!configured.enabled) return { label: t("Disabled"), status: "stopped" };
    if (usesImportedSession(audioServiceCapabilities[value.provider])) {
      const account = readBridgeState().sunoAccounts.find((entry) => entry.serviceId === value.id);
      return account?.status === "signed_in"
        ? { label: t("Ready"), status: "complete" }
        : { label: t("Needs attention"), status: "partial" };
    }
    return configured.apiKeyConfigured
      ? { label: t("Ready"), status: "complete" }
      : { label: t("Needs setup"), status: "partial" };
  }

  function clearSunoCookieInput() {
    element("sunoSessionValue").value = "";
    sunoInputRevision += 1;
  }

  function canMaintainSunoSession(serviceId: string | null) {
    const account = readBridgeState().sunoAccounts.find((entry) => entry.serviceId === serviceId);
    // Retry is not credential evidence; the backend rechecks local storage.
    return ["saved", "signed_in", "expired", "unavailable"].includes(account?.status ?? "");
  }

  async function importSunoCookie() {
    const input = element("sunoSessionValue");
    let sessionValue = input.value;
    input.value = "";
    const id = connectionState.selectedId;
    const draft = connectionState.drafts.get(id ?? "");
    const connection = draft?.connection || savedAudioConnection(id);
    const inputRevision = sunoInputRevision;
    const expectedRevision = draft?.expectedRevision;
    try {
      if (audioSettingsBusy || audioSettingsSubmitting || draft?.conflict || connection?.provider !== "suno" || id === null) return false;
      const trimmedSession = sessionValue.trim();
      const jwt = "[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+";
      const rawSession = new RegExp("^" + jwt + "$").test(trimmedSession);
      const cookieSession = new RegExp("(?:^|;\\s*)(?:__client|__session)=" + jwt + "(?:;|$)").test(
        trimmedSession.replace(/^Cookie\\s*:\\s*/i, ""));
      if (sessionValue.length > 16384 || /[\u0000-\u001f\u007f]/.test(sessionValue) || !(rawSession || cookieSession)) {
        showStatus(t("Paste a Suno __client or __session value, or a Cookie header containing one of them (maximum 16384 characters)."), true);
        input.focus();
        return false;
      }
      if (draft) {
        const savedRevision = await saveAudioServiceSettings();
        if (!savedRevision || savedRevision !== (BigInt(expectedRevision!) + 1n).toString() ||
          connectionState.revision !== savedRevision) return false;
      }
      if (inputRevision !== sunoInputRevision || connectionState.selectedId !== id || connectionState.drafts.has(id) ||
        audioSettingsBusy || audioSettingsSubmitting || readBridgeState().closePending ||
        !sameJsonValue(savedAudioConnection(id) ? audioConnectionFields(savedAudioConnection(id)!) : null,
          { ...audioConnectionFields(connection), name: connection.name.trim() })) return false;
      return await runCommand("import_suno_session", { serviceId: id, sessionValue });
    } finally {
      sessionValue = "";
      renderAudioTools();
    }
  }

  async function runSunoLoginCommand(kind: "open_suno_website" | "refresh_suno_login" | "logout_suno") {
    const id = connectionState.selectedId;
    const service = savedAudioConnection(id);
    if (kind === "open_suno_website") {
      if (audioSettingsBusy || audioSettingsSubmitting) return false;
      return runCommand(kind, undefined, {
        onOutcome: (outcome) => {
          if (outcome.known && outcome.succeeded) {
            showStatus(t("Suno opened in your default browser. Import its Cookie to connect Live Smith."));
          }
        }
      });
    }
    const canRun = () => !audioSettingsBusy && !audioSettingsSubmitting &&
      connectionState.selectedId === id && !connectionState.drafts.has(id ?? "") &&
      savedAudioConnection(id)?.provider === "suno" && canMaintainSunoSession(id);
    if (!canRun() || id === null || service === null) return false;
    if (kind === "logout_suno") {
      const revision = connectionState.revision;
      const accepted = await confirmAction({
        title: i18n.message("Clear local Suno Cookie?"),
        message: i18n.message("Remove only the Cookie saved locally for “{name}”? Your Suno browser login and browser windows stay open. Reconnect by importing a Suno Cookie again.", { name: service.name }),
        acceptLabel: i18n.message("Clear local Cookie"), danger: true,
      });
      if (!accepted || !canRun() || connectionState.revision !== revision) return false;
      clearSunoCookieInput();
    }
    // Capture the saved identity before awaiting; selection remains navigable.
    return runCommand(kind, { serviceId: id });
  }

  function setBusy(settingsBusy: boolean) {
    audioSettingsBusy = settingsBusy;
    renderAudioTools();
  }

  function selectedSunoCatalog(service: AudioConnectionEditorValue | null) {
    const value = readBridgeState().sunoModelCatalog;
    return service?.provider === "suno" && value && value.serviceId === service.id &&
      value.integrationConnectionsRevision === connectionState.revision &&
      readBridgeState().sunoAccounts.some(account => account.serviceId === service.id && account.accountId === value.accountId &&
        ["signed_in", "saved"].includes(account.status)) ? value : null;
  }

  async function loadSunoModels() {
    const service = savedAudioConnection();
    if (sunoModelLoadingId || audioSettingsBusy || audioSettingsSubmitting || connectionState.drafts.has(service?.id ?? "") ||
      service?.provider !== "suno" || !canMaintainSunoSession(service.id)) return false;
    const id = service.id;
    sunoModelLoadingId = id;
    sunoModelLoadErrorId = null;
    invalidateSunoCatalog();
    renderAudioTools();
    try {
      let loaded = false;
      await runCommand("load_suno_models", { serviceId: id }, {
        cancellable: true, onOutcome: (outcome) => {
          loaded = outcome.known && outcome.succeeded && Boolean(selectedSunoCatalog(service));
        }
      });
      if (!loaded) sunoModelLoadErrorId = id;
      else showStatus(i18n.message("Suno models loaded."));
      return loaded;
    } finally {
      sunoModelLoadingId = null;
      renderAudioTools();
    }
  }

  function renderSunoModels(service: AudioConnectionEditorValue, draft: AudioConnectionDraft | undefined) {
    const group = element("sunoModelSelection");
    const picker = element("sunoModelPicker");
    const button = element("loadSunoModelsButton");
    if (service?.provider !== "suno") return;
    const catalog = selectedSunoCatalog(service);
    const defaults = catalog?.models.filter(model => model.canUse === true && model.isDefault === true) || [];
    const selected = service.modelId || "";
    const options = [new Option(defaults.length === 1 ? t("Account default · {model}", { model: defaults[0]!.name || defaults[0]!.id })
      : t("Follow account default"), "")];
    for (const model of catalog?.models || []) {
      const suffix = model.canUse === false ? " · " + t("Unavailable") : model.canUse === undefined ? " · " + t("Availability unknown") : "";
      const option = new Option((model.name || model.id) + suffix, model.id);
      option.disabled = model.canUse !== true;
      options.push(option);
    }
    if (selected && !options.some(option => option.value === selected)) {
      const option = new Option(t("{model} · not in loaded catalog", { model: selected }), selected);
      option.disabled = true;
      options.push(option);
    }
    const key = JSON.stringify([options.map(option => [option.value, option.textContent, option.disabled]), selected]);
    if (picker.dataset.options !== key) { picker.replaceChildren(...options); picker.value = selected; picker.dataset.options = key; }
    const busy = audioSettingsBusy || audioSettingsSubmitting;
    picker.disabled = busy || Boolean(draft?.conflict);
    picker.onchange = () => {
      if (picker.disabled || connectionState.selectedId !== service.id || picker.selectedOptions[0]?.disabled) return;
      element("audioServiceModel").value = picker.value;
      handleAudioSettingsInput();
    };
    button.disabled = busy || Boolean(sunoModelLoadingId) || Boolean(draft) || !canMaintainSunoSession(service.id);
    button.textContent = t(sunoModelLoadingId === service.id ? "Loading versions…" : catalog ? "Refresh versions" : "Load versions");
    button.onclick = loadSunoModels;
    group.setAttribute("aria-busy", String(sunoModelLoadingId === service.id));
    const status = element("sunoModelStatus");
    status.classList.toggle("field-error", sunoModelLoadErrorId === service.id);
    status.textContent = t(sunoModelLoadingId === service.id ? "Loading account versions…"
      : sunoModelLoadErrorId === service.id ? "Could not load versions. Check the connection and try again."
        : !canMaintainSunoSession(service.id) ? "Connect this Suno account to load available versions."
          : draft && !catalog ? "Save connection changes before loading versions."
            : catalog ? catalog.models.length ? "Version applies after saving. Generation checks current account access."
              : "This account returned no versions. You can retry loading."
              : "Load this account's versions without generating music or spending credits.");
  }

  function getAudioConnections() {
    const choices = new Map(connectionState.audioConnections().map((connection) => [connection.id, connection]));
    for (const [id, value] of connectionState.drafts) choices.set(id, value.connection);
    return [...choices].map(([id, value]) => {
      const presentation = audioConnectionPresentation(value, savedAudioConnection(id), connectionState.drafts.get(id));
      return {
        id, name: value.name || t("New connection"),
        source: t(audioServiceCapabilities[value.provider].label), ...presentation,
        title: (value.name || t("New connection")) + " · " + t(audioServiceCapabilities[value.provider].label) +
          " · " + (usesImportedSession(audioServiceCapabilities[value.provider]) ? sunoAccountStatus(id) : presentation.label),
        selected: id === connectionState.selectedId,
        disabled: audioSettingsSubmitting || audioSettingsBusy && !sunoLoginCommands.has(readBridgeState().commandKind)
      };
    });
  }

  function clearAudioConnectionSecrets() {
    element("audioServiceApiKey").value = "";
    clearSunoCookieInput();
    discardUnchangedAudioDraft();
    renderAudioTools();
  }

  function renderAudioTools() {
    bindAudioControls();
    const saved = savedAudioConnection();
    const draft = connectionState.drafts.get(connectionState.selectedId ?? "");
    const service = draft?.connection || saved;
    const busy = audioSettingsBusy || audioSettingsSubmitting;
    const cookie = element("sunoSessionValue");
    const cookieOwner = service ? service.id + ":" + service.provider : "";
    if (cookie.dataset.connection !== cookieOwner) {
      clearSunoCookieInput();
      cookie.dataset.connection = cookieOwner;
    }
    element("sunoAccountName").textContent = "";
    element("sunoAccountName").hidden = true;
    const editor = element("audioServiceFields");
    editor.hidden = !service;
    if (!service) editor.open = false;
    const provider = element("audioServiceProvider");
    provider.replaceChildren();
    for (const [id, capability] of Object.entries(audioServiceCapabilities)) {
      const selectable = capability.tools.length > 0 || usesImportedSession(capability);
      const option = new Option(t(capability.label) + (selectable ? "" : " · " + t("Unavailable")), id);
      option.disabled = !selectable;
      provider.add(option);
    }
    if (service) {
      element("audioServiceEditorSummary").textContent = t("Connection settings") + " · " + (service.name || t("New connection"));
      const modelOptions = element("audioServiceModelField");
      const editorIdentity = service.id + ":" + service.provider;
      if (modelOptions.dataset.connection !== editorIdentity) {
        modelOptions.dataset.connection = editorIdentity;
        modelOptions.open = service.provider !== "suno" && Boolean(service.modelId);
      }
      const supported = audioServiceCapabilities[service.provider].tools;
      const sessionImport = usesImportedSession(audioServiceCapabilities[service.provider]);
      const cookieEditor = element("sunoCookieEditor");
      const cookieEditorOwner = editorIdentity + ":" + canMaintainSunoSession(service.id);
      if (cookieEditor.dataset.owner !== cookieEditorOwner) {
        cookieEditor.dataset.owner = cookieEditorOwner;
        cookieEditor.open = !canMaintainSunoSession(service.id);
      }
      const enabled = element("audioServiceEnabled");
      const key = element("audioServiceApiKey");
      element("audioServiceName").value = service.name;
      provider.value = service.provider;
      const modelInput = element("audioServiceModel");
      modelInput.value = service.modelId || "";
      const modelSuggestions = element("audioServiceModelOptions");
      const suggestedModels = audioServiceCapabilities[service.provider].modelIds || [];
      const suggestionKey = JSON.stringify(suggestedModels);
      if (modelSuggestions.dataset.models !== suggestionKey) {
        modelSuggestions.dataset.models = suggestionKey;
        modelSuggestions.replaceChildren(...suggestedModels.map((id) => new Option(id, id)));
      }
      if (suggestedModels.length) modelInput.setAttribute("list", modelSuggestions.id);
      else modelInput.removeAttribute("list");
      const callback = element("audioServiceCallback");
      callback.value = service.callbackUrl || "";
      callback.required = audioServiceCapabilities[service.provider].callbackUrl === true && service.enabled;
      enabled.checked = supported.length > 0 && service.enabled;
      for (const id of ["audioServiceName", "audioServiceProvider", "audioServiceModel", "audioServiceCallback", "audioServiceApiKey"] as const) {
        element(id).disabled = busy || Boolean(draft?.conflict);
      }
      element("audioServiceModelField").hidden = !audioServiceCapabilities[service.provider].modelConfigurable;
      element("audioServiceCallbackField").hidden = audioServiceCapabilities[service.provider].callbackUrl !== true;
      element("audioServiceEnabledField").hidden = !supported.length;
      const keyPanel = element("audioServiceKeyField");
      keyPanel.hidden = sessionImport;
      if (sessionImport) { key.value = ""; key.disabled = true; }
      const platformActions = element("sunoPlatformActions");
      platformActions.hidden = service.provider !== "suno-platform";
      const openPlatform = element("openSunoPlatformButton");
      openPlatform.disabled = busy || service.provider !== "suno-platform";
      openPlatform.onclick = () => runCommand("open_suno_platform", undefined, {
        onOutcome: (outcome) => {
          if (outcome.known && outcome.succeeded) showStatus(t("Suno Platform opened in your default browser. Create or manage an official API key there."));
        }
      });
      const sunoPanel = element("sunoLoginControls");
      sunoPanel.hidden = !sessionImport;
      element("sunoModelSelection").hidden = !sessionImport;
      const savedSuno = sessionImport && saved?.provider === "suno";
      const savedSunoPresentation = sunoAccountPresentation(service.id);
      const sunoPresentation = savedSuno ? savedSunoPresentation : {
        account: undefined,
        state: "signed-out",
        badge: t("Needs setup"),
        title: t("Connect will save this connection before importing its Suno Cookie."),
        detail: "",
      };
      sunoPanel.dataset.authState = sunoPresentation.state;
      element("sunoAuthStateBadge").textContent = sunoPresentation.badge;
      element("sunoLoginStatus").textContent = sunoPresentation.title;
      const account = savedSuno ? savedSunoPresentation.account : undefined;
      const accountName = element("sunoAccountName");
      accountName.textContent = sunoPresentation.detail;
      accountName.hidden = !accountName.textContent;
      cookie.disabled = busy || Boolean(draft?.conflict) || !sessionImport;
      const connect = element("connectSunoButton");
      connect.textContent = t(draft ? "Save and connect" : "Connect");
      connect.disabled = cookie.disabled || !cookie.value;
      connect.onclick = importSunoCookie;
      const openWebsite = element("openSunoWebsiteButton");
      openWebsite.disabled = busy || !sessionImport;
      openWebsite.onclick = () => runSunoLoginCommand("open_suno_website");
      const refresh = element("refreshSunoLoginButton");
      const refreshLabel = account?.status === "unavailable" ? "Retry verification" : "Refresh connection";
      refresh.dataset.i18n = refreshLabel;
      refresh.textContent = t(refreshLabel);
      const refreshPrimary = ["saved", "expired", "unavailable"].includes(account?.status ?? "");
      const openPrimary = !savedSuno || !account || account.status === "signed_out";
      openWebsite.classList.toggle("primary", openPrimary);
      openWebsite.classList.toggle("secondary", !openPrimary);
      refresh.classList.toggle("primary", refreshPrimary);
      refresh.classList.toggle("secondary", !refreshPrimary);
      for (const [id, kind] of [
        ["refreshSunoLoginButton", "refresh_suno_login"],
        ["logoutSunoButton", "logout_suno"],
      ] as const) {
        const button = element(id);
        const canMaintain = canMaintainSunoSession(service.id);
        button.hidden = !canMaintain;
        button.disabled = busy || Boolean(draft) || saved?.provider !== "suno" || !sessionImport || !canMaintain;
        button.onclick = () => runSunoLoginCommand(kind);
      }
      element("audioServiceModelHint").textContent = audioServiceModelHint(service);
      element("audioServiceModelSummary").textContent = t(sessionImport ? "Advanced model ID" : "Model override (optional)");
      renderSunoModels(service, draft);
      enabled.disabled = busy || Boolean(draft?.conflict) || !supported.length;
      element("audioServiceOperations").textContent = sessionImport
        ? t("Music · Custom lyrics and styles · Extend · Get Whole Song · Library · Retrieve & preview") : supported.length
          ? supported.map(audioOperationLabel).join(" · ")
          : t("Unavailable: no verified public API protocol is configured for this provider.");
      element("audioServiceOperations").hidden = false;
      const disclosureText = sessionImport
        ? t("Generation uses your Suno credits. Enable and save this connection to use it in chat; submissions are never retried automatically.") : service.provider === "sunoapi"
          ? t("SunoAPI.org is a third-party API service with its own key and billing. It is not Suno's official API or a Suno website subscription. Your prompt is sent to SunoAPI.org.")
          : service.provider === "suno-platform"
            ? t("Official Suno API connection. Create its key at platform.suno.com. Platform access and usage are separate from the Suno.com subscription Cookie connection.")
            : service.provider === "google-lyria"
              ? t("Google Lyria generation uses Gemini API billing. Batch songs are single-turn and watermarked; the experimental realtime model produces instrumental WAV audio through a bounded WebSocket stream.")
              : supported.includes("separate_stems")
                ? t("Selected audio is sent to this external service. Stem separation uses processing minutes for each requested stem.")
                : t("Generation sends your prompt to this external service and may incur separate API charges. A website subscription may not include API access.");
      const disclosure = element("audioServiceDisclosure");
      disclosure.setAttribute("aria-label", disclosureText);
      disclosure.dataset.tooltip = disclosureText;
      const keyConfigured = saved?.provider === service.provider && saved.apiKeyConfigured;
      keyPanel.dataset.authState = keyConfigured ? "signed-in" : "signed-out";
      element("audioServiceKeyBadge").textContent = t(keyConfigured ? "Ready" : "Needs setup");
      element("audioServiceKeyStatus").textContent =
        keyConfigured ? t("API key configured") : t("No API key configured");
      key.placeholder = keyConfigured ? t("Leave blank to keep the saved key") : "";
    }
    const conflict = Boolean(draft?.conflict);
    element("audioServiceConflict").hidden = !conflict;
    const draftStatus = element("audioDraftStatus");
    const nextDraftStatus = conflict ? t("Needs attention") : draft ? t("Unsaved changes") : "";
    if (draftStatus.textContent !== nextDraftStatus) draftStatus.textContent = nextDraftStatus;
    draftStatus.classList.toggle("dirty", Boolean(draft) && !conflict);
    draftStatus.classList.toggle("field-error", conflict);
    const reload = element("reloadAudioServiceButton");
    reload.hidden = false;
    reload.disabled = busy || !draft;
    reload.dataset.i18n = conflict ? "Reload connection" : "Discard";
    reload.textContent = t(reload.dataset.i18n);
    element("saveAudioServiceButton").disabled = busy || conflict || !draft;
    element("clearAudioServiceButton").disabled = busy || conflict || !saved?.apiKeyConfigured;
    element("clearAudioServiceButton").hidden = Boolean(
      service && usesImportedSession(audioServiceCapabilities[service.provider]),
    );
    element("removeAudioServiceButton").disabled = busy || conflict || !service;
    element("removeAudioServiceButton").hidden = !saved;
    onRender();
  }

  return {
    render: renderAudioTools,
    hasUnsavedChanges: () => Boolean(element("audioServiceApiKey").value) ||
      [...connectionState.drafts.values()].some((draft) => !draft.baseConnection ||
        !sameJsonValue(audioConnectionFields(draft.connection), audioConnectionFields(draft.baseConnection))),
    getAudioConnections,
    clearAudioConnectionSecrets,
    clearSunoCookieInput,
    setBusy,
    handleAudioSettingsInput,
    handleAudioServiceSelection,
    addAudioService,
    removeAudioService,
    reloadAudioService,
    saveAudioServiceSettings,
    get busy() { return audioSettingsBusy || audioSettingsSubmitting; },
    reconcileAdoption(change: { conflictedDraftIds: string[] }, previousSelection: string | null): void {
      if (previousSelection !== null && change.conflictedDraftIds.includes(previousSelection)) {
        element("audioServiceApiKey").value = "";
        element("sunoSessionValue").value = "";
      }
      if (previousSelection !== connectionState.selectedId) element("audioServiceApiKey").value = "";
    },
  };
}
