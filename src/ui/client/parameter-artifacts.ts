import { isParameterArtifactPreview, type ParameterArtifactRead, type ParameterArtifactCommand, type ParameterArtifactPreview } from "../../app/parameters/contracts.js";
import { parameterApplicationIsOpen, sameParameterLayout, sameParameterNumber, sameParameterTarget, type DeviceParameterTarget } from "../../agent/device-parameter-contracts.js";
import type { SessionArtifact } from "../../app/session/session-artifacts.js";
import { createLocaleBindings, type LocalizedText } from "./locale-bindings.js";
import { createParameterTable } from "./parameter-table.js";
import { formatUiMessage, isUiMessage, type UiMessage } from "../../i18n/ui-message.js";

export interface ParameterArtifactDependencies {
  sessionId: string;
  presentationId?: string;
  isCurrent(): boolean;
  read(input: ParameterArtifactRead, signal?: AbortSignal): Promise<unknown>;
  command(input: ParameterArtifactCommand): Promise<boolean>;
  openArtifact(id: string): Promise<void>;
}
const destination = ({ runtimeId, songId, trackId, deviceId }: DeviceParameterTarget) => ({ runtimeId, songId, trackId, deviceId });
const deviceKey = (device: DeviceParameterTarget) => `${device.trackId}:${device.deviceId}`;

/** Owns one exact version or the explicit capture form; command receipts remain server-owned. */
export function createParameterArtifactView(deps: ParameterArtifactDependencies, initial?: SessionArtifact, presentation: "artifact" | "chat" = "artifact") {
  const bindings = createLocaleBindings();
  const t = (source: string, values?: Record<string, string>) => window.LiveSmithI18n?.t(source, values) ?? source;
  const message = (value: UiMessage) => window.LiveSmithI18n?.format(value) ?? formatUiMessage(value);
  const errorText = (error: unknown, fallback: string): string => {
    if (!(error instanceof Error)) return t(fallback);
    const display = (error as Error & { displayMessage?: unknown }).displayMessage;
    return isUiMessage(display) ? message(display) : error.message;
  };
  const deviceLabelText = (device: DeviceParameterTarget) => `${t(device.trackRole === "main" ? "Main" : device.trackRole === "return" ? "Return" : "Track")}${device.trackIndex === undefined ? "" : ` ${device.trackIndex + 1}`} · ${device.trackName} · ${device.devicePath}`;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: LocalizedText) => {
    const result = document.createElement(tag); if (text !== undefined) bindings.text(result, text); return result;
  };
  const root = node("section"); root.className = "parameter-artifact-view";
  const status = node("p"); status.className = "field-hint"; status.setAttribute("role", "status");
  const source = node("p"); source.className = "field-hint"; source.hidden = !initial;
  const deviceLabel = node("label"); deviceLabel.append(node("span", () => t(initial ? "Destination device" : "Device to capture")));
  const devices = node("select"); deviceLabel.append(devices);
  const label = node("label"); label.append(node("span", () => t("Snapshot name")));
  const name = node("input"); name.type = "text"; name.maxLength = 120; label.append(name); label.hidden = Boolean(initial);
  const comparisonLabel = node("label"); comparisonLabel.append(node("span", () => t("Compare with")));
  const comparison = node("select"); comparisonLabel.append(comparison); comparisonLabel.hidden = !initial;
  const actions = node("div"); actions.className = "artifact-actions";
  const choices = node("div"); choices.className = "parameter-candidate-choices"; choices.setAttribute("role", "group");
  bindings.attribute(choices, "aria-label", () => t("Sound choices"));
  const originalChoice = node("button", "Original"); originalChoice.type = "button"; originalChoice.dataset.parameterOriginal = "true";
  choices.append(originalChoice);
  const choiceButtons = new Map<string, HTMLButtonElement>();
  const button = (text: string, action: () => void) => { const element = node("button", () => t(text)); element.className = "secondary"; element.type = "button"; element.addEventListener("click", action); actions.append(element); return element; };
  const refresh = button(presentation === "chat" ? "Refresh device parameters" : "Refresh", () => { void load(); });
  const save = button(initial ? "Audition" : "Save parameter snapshot", () => { void runSave(); });
  bindings.attribute(refresh, "aria-label", () => t("Refresh device parameters"));
  bindings.attribute(refresh, "title", () => t("Refresh device parameters"));
  if (initial) bindings.attribute(save, "aria-label", () => t("Audition in Live"));
  actions.prepend(save);
  const listening = node("p", () => t("Play a Clip or your instrument in Live to hear each version.")); listening.className = "field-hint"; listening.hidden = !initial;
  const receipt = node("section"); receipt.className = "parameter-application";
  const receiptText = node("p"); receiptText.className = "field-hint";
  const receiptSource = node("p");
  const receiptActions = node("div"); receiptActions.className = "artifact-actions";
  const keep = node("button", () => t("Use this sound")); keep.type = "button"; keep.className = "secondary";
  const restore = node("button", () => t("Restore previous values")); restore.type = "button"; restore.className = "secondary";
  const openApplied = node("button", () => t("Open applied version")); openApplied.type = "button"; openApplied.className = "secondary";
  const openOriginal = node("button", () => t("Open original snapshot")); openOriginal.type = "button"; openOriginal.className = "secondary";
  const receiptHint = node("p"); receiptHint.className = "field-hint";
  const receiptDetails = node("details"); receiptDetails.append(node("summary", () => t("Application details")));
  const receiptTable = createParameterTable(); receiptDetails.append(receiptTable.element);
  const restorationDetails = node("details"); restorationDetails.append(node("summary", () => t("Values before restoration")));
  const restorationTable = createParameterTable(); restorationDetails.append(restorationTable.element); restorationDetails.hidden = true;
  receiptActions.append(keep, restore, openApplied, openOriginal); receipt.append(receiptSource, receiptText, receiptHint, receiptActions, receiptDetails, restorationDetails); receipt.hidden = true;
  const table = createParameterTable(); table.element.hidden = !initial;
  const details = presentation === "chat" ? node("details") : undefined;
  const observed = node("p"); observed.className = "parameter-observed field-hint"; observed.hidden = true;
  if (details) {
    details.className = "parameter-artifact-details";
    const tools = node("div"); tools.className = "artifact-actions"; tools.append(refresh, openApplied, openOriginal);
    details.append(node("summary", () => t("Sound details")), listening, source, deviceLabel, table.element, tools, receipt, receiptDetails, restorationDetails);
    root.append(choices, status, details);
  } else if (initial) {
    root.classList.add("parameter-workspace-view");
    const live = node("section"); live.className = "parameter-live-section";
    live.append(node("h3", () => t("Live device")), observed, actions, status);
    actions.append(keep, restore);
    const destination = node("details"); destination.className = "artifact-details parameter-destination";
    destination.append(node("summary", () => t("Destination device")), deviceLabel, source, listening);
    const heading = node("div"); heading.className = "parameter-preview-heading";
    heading.append(node("h3", () => t("Parameter preview")), comparisonLabel);
    receipt.classList.add("parameter-last-application");
    root.append(live, destination, heading, table.element, receipt);
  } else root.append(source, deviceLabel, label, comparisonLabel, actions, status, listening, receipt, table.element);
  let artifact = initial;
  let candidates = initial ? [initial] : [];
  let preview: ParameterArtifactPreview | undefined;
  let reading: AbortController | undefined;
  let selectedDevice: DeviceParameterTarget | undefined;
  let busy = false, pending = false, disposed = false, suspended = false, loaded = false;
  let nameEdited = false;
  const current = () => !disposed && !suspended && deps.isCurrent();
  function setCandidates(values: readonly SessionArtifact[]) {
    candidates = [...values];
    for (const [id, choice] of choiceButtons) if (!candidates.some((candidate) => candidate.ref.id === id)) { choice.remove(); choiceButtons.delete(id); }
    for (const candidate of candidates) {
      let choice = choiceButtons.get(candidate.ref.id);
      if (!choice) {
        choice = node("button"); choice.type = "button"; choice.dataset.parameterCandidate = candidate.ref.id;
        const id = candidate.ref.id;
        choice.addEventListener("click", () => {
          if (choice!.disabled || !preview?.current) return;
          const selected = candidates.find((value) => value.ref.id === id); if (!selected) return;
          artifact = selected; comparison.value = "live";
          void run({ kind: "apply_device_parameters", sessionId: deps.sessionId, artifactId: id, target: destination(preview.current.target),
            ...(deps.presentationId ? { presentationId: deps.presentationId } : {}) });
        });
        choiceButtons.set(candidate.ref.id, choice); choices.append(choice);
      }
      choice.textContent = choice.title = candidate.label;
    }
    syncBusy();
  }
  function candidateIsCurrent() {
    const application = preview?.application, live = preview?.current;
    return Boolean(application && live && ["applied", "kept"].includes(application.status) && sameParameterTarget(application.target, live.target) &&
      sameParameterLayout(application.entries.map((entry) => entry.parameter), live.parameters) && application.entries.every((entry) => {
        const actual = live.parameters[entry.parameter.index];
        const confirmed = entry.state === "applied" ? entry.after : entry.state === "pending" ? entry.parameter.value : undefined;
        // SDK writes can round their input; detect later edits against the exact readback.
        const requestTolerance = 1e-7 * Math.max(1, Math.abs(entry.requested));
        return confirmed !== undefined && actual?.handleId === entry.parameter.handleId && sameParameterNumber(actual.value, confirmed) &&
          Math.abs(confirmed - entry.requested) <= requestTolerance;
      }));
  }
  function originalIsCurrent() {
    const application = preview?.application, live = preview?.current;
    return Boolean(live && (!application || application.status === "restored" && sameParameterTarget(application.target, live.target) &&
      sameParameterLayout(application.entries.map((entry) => entry.parameter), live.parameters) && application.entries.every((entry) => {
        const actual = live.parameters[entry.parameter.index];
        return actual?.handleId === entry.parameter.handleId && sameParameterNumber(actual.value, entry.parameter.value);
      })));
  }
  function syncBusy() {
    const locked = busy || pending || !loaded;
    root.setAttribute("aria-busy", String(pending || Boolean(reading)));
    devices.disabled = comparison.disabled = name.disabled = locked;
    refresh.disabled = Boolean(reading) || pending;
    const application = preview?.application;
    const open = application && parameterApplicationIsOpen(application);
    const matchesCandidate = candidateIsCurrent();
    const active = matchesCandidate && application?.artifactId === artifact?.ref.id;
    save.disabled = locked || Boolean(reading) || !preview || (artifact ? !preview.current || Boolean(preview.switchError) || active || Boolean(open && (application.status !== "applied" || application.restorationBaseline)) : !selectedDevice || !name.value.trim());
    if (artifact) save.setAttribute("aria-pressed", String(Boolean(active)));
    root.dataset.auditionCurrent = String(Boolean(active));
    if (presentation === "artifact" && artifact) { keep.hidden = !application || !parameterApplicationIsOpen(application); restore.hidden = !application || application.status === "restored"; }
    keep.disabled = locked || Boolean(reading) || !application || !parameterApplicationIsOpen(application);
    restore.disabled = locked || Boolean(reading) || !application || application.status === "restored";
    openApplied.disabled = pending || Boolean(reading) || !preview?.application;
    openOriginal.disabled = pending || Boolean(reading) || !preview?.application?.baselineArtifactId;
    restore.disabled ||= Boolean(preview?.restoreError);
    if (preview?.application) restore.disabled ||= preview.application.entries.some((entry) => entry.state === "applying" || entry.state === "restoring" || entry.state === "conflict");
    originalChoice.setAttribute("aria-pressed", String(originalIsCurrent()));
    originalChoice.disabled = restore.disabled;
    for (const [id, choice] of choiceButtons) {
      const selected = matchesCandidate && application?.artifactId === id;
      choice.setAttribute("aria-pressed", String(selected));
      choice.disabled = locked || Boolean(reading) || !preview?.current || Boolean(preview.switchError) || selected || Boolean(open && (application.status !== "applied" || application.restorationBaseline));
    }
  }
  function render() {
    if (!preview) { observed.hidden = true; bindings.text(observed, ""); table.element.hidden = receipt.hidden = openApplied.hidden = openOriginal.hidden = receiptDetails.hidden = restorationDetails.hidden = true; syncBusy(); return; }
    const key = devices.value;
    devices.replaceChildren();
    const original = node("option", () => artifact
      ? !selectedDevice && preview?.current ? deviceLabelText(preview.current.target) : t("Saved device binding")
      : t("Choose a device")); original.value = ""; devices.append(original);
    for (const device of preview.devices) { const option = node("option", () => deviceLabelText(device)); option.value = deviceKey(device); devices.append(option); }
    devices.value = key;
    if (selectedDevice && !preview.devices.some((device) => deviceKey(device) === deviceKey(selectedDevice!) && device.runtimeId === selectedDevice!.runtimeId)) {
      selectedDevice = undefined; devices.value = "";
    }
    const compared = comparison.value || "live";
    comparison.replaceChildren(); const live = node("option", () => t("Current Live values")); live.value = "live"; comparison.append(live);
    for (const version of presentation === "chat" ? [] : artifact?.versions ?? []) if (version.id !== artifact!.ref.id) {
      const option = node("option", `v${version.number} · ${version.label}`); option.value = version.id; comparison.append(option);
    }
    comparison.value = [...comparison.options].some((option) => option.value === compared) ? compared : "live";
    const saved = preview.artifact;
    observed.hidden = !preview.current || !preview.application || !candidateIsCurrent() && !originalIsCurrent();
    bindings.text(observed, () => candidateIsCurrent() ? t("Observed Live values match v{version}.", { version: String(preview!.application!.artifactVersion) })
      : originalIsCurrent() && preview?.application ? t("Observed Live values match the original snapshot.") : "");
    table.element.hidden = !saved;
    if (saved) {
      bindings.text(source, () => presentation === "chat" ? `${saved.label} · ${deviceLabelText(saved.target)}` : deviceLabelText(saved.target));
      const before = comparison.value === "live" ? preview.current?.parameters : preview.comparison?.parameters;
      table.update(saved.parameters.map((parameter, index) => ({ index: parameter.index, name: parameter.name, after: parameter.value, min: parameter.min, max: parameter.max,
        ...(before?.[index] ? { before: before[index]!.value } : {}) })), { before: comparison.value === "live" ? "Current value" : "Compared version", after: "Saved value" });
    }
    const application = preview.application;
    receipt.hidden = !application;
    receiptDetails.hidden = !application;
    openApplied.hidden = !application || application.artifactId === artifact?.ref.id;
    openOriginal.hidden = !application?.baselineArtifactId;
    restorationDetails.hidden = !application?.restorationBaseline;
    receiptSource.setAttribute("aria-live", application?.artifactId === artifact?.ref.id ? "polite" : "off");
    if (application) {
      const selected = candidateIsCurrent();
      const keepDescription = () => t(selected ? "Use this sound" : "Finish audition");
      bindings.text(keep, () => presentation === "artifact" && selected ? t("Keep") : keepDescription());
      bindings.attribute(keep, "aria-label", keepDescription); bindings.attribute(keep, "title", keepDescription);
      bindings.text(receiptSource, () => t(application.baselineArtifactId
        ? application.status === "applied" ? presentation === "chat" ? "Auditioning: {name}" : "Auditioning: {name} · v{version}" : application.status === "kept" ? selected ? "Using: {name}" : "Audition ended: {name} · v{version}. Current device values kept."
          : application.status === "restored" ? "Restored before audition · {name}" : "Review audition: {name} · v{version}"
        : "Applied version: {name} · v{version}", { name: application.artifactLabel, version: String(application.artifactVersion) }));
      if (presentation === "artifact") bindings.text(receiptSource, () => t("Last application: {name} · v{version} · {status}", {
        name: application.artifactLabel, version: String(application.artifactVersion), status: t(application.status),
      }));
      const restoreDescription = () => t(application.baselineArtifactId ? "Restore before audition" : "Restore previous values");
      bindings.text(restore, () => presentation === "artifact" ? t("Restore") : restoreDescription());
      bindings.attribute(restore, "aria-label", restoreDescription); bindings.attribute(restore, "title", restoreDescription);
      bindings.text(receiptText, () => t("Parameter application: {status} · {device}", { status: t(application.status), device: `${application.target.trackName} · ${application.target.deviceName}` }));
      receiptText.hidden = presentation === "artifact" || presentation === "chat" && ["applied", "kept", "restored"].includes(application.status);
      keep.hidden = presentation === "chat" || !parameterApplicationIsOpen(application);
      restore.hidden = presentation === "chat" || application.status === "restored";
      receiptActions.hidden = keep.hidden && restore.hidden && (presentation === "chat" || openApplied.hidden && openOriginal.hidden);
      const unconfirmed = application.entries.some((entry) => entry.state === "applying" || entry.state === "restoring" || entry.state === "conflict");
      const differs = preview.current && sameParameterTarget(preview.current.target, application.target) && !selected;
      const keptHint = application.status === "kept" ? unconfirmed
        ? "Some parameter writes remain unconfirmed. Inspect Live and the application details."
        : differs ? "Current device values differ from the saved candidate. Review the parameter comparison." : undefined : undefined;
      receiptHint.hidden = !keptHint && (application.status === "restored" || !preview.restoreError);
      bindings.text(receiptHint, () => keptHint ? t(keptHint) : message(preview?.restoreError ?? ""));
      if (receiptDetails.open) receiptTable.update(application.entries.map((entry) => ({ index: entry.parameter.index, name: entry.parameter.name,
        before: entry.parameter.value, ...(entry.state === "restored" ? { after: entry.parameter.value } : entry.after === undefined ? {} : { after: entry.after }),
        min: entry.parameter.min, max: entry.parameter.max,
        state: entry.state === "applying" || entry.state === "restoring" ? "Write not confirmed" : entry.state === "pending" ? "Not written" : entry.state,
      })), { before: "Before application", after: "Last verified value" });
      restorationDetails.hidden = !application.restorationBaseline;
      if (restorationDetails.open && application.restorationBaseline) restorationTable.update(application.restorationBaseline.map((parameter) => ({
        index: parameter.index, name: parameter.name, after: parameter.value, min: parameter.min, max: parameter.max,
      })), { before: "Current value", after: "Values before restoration" });
    }
    syncBusy();
  }
  async function load() {
    if (!current()) return;
    reading?.abort(); const controller = new window.AbortController(); reading = controller; loaded = false; syncBusy();
    status.hidden = presentation === "chat";
    if (!status.hidden) bindings.text(status, () => t("Reading device parameters…"));
    const baseId = comparison.value && comparison.value !== "live" ? comparison.value : undefined;
    const selected = selectedDevice;
    try {
      const value = await deps.read({ sessionId: deps.sessionId, ...(artifact ? { artifactId: artifact.ref.id } : {}),
        ...(selected ? { target: destination(selected) } : {}), ...(baseId ? { baseArtifactId: baseId } : {}) }, controller.signal);
      if (!current() || reading !== controller) return;
      if (!isParameterArtifactPreview(value) || value.sessionId !== deps.sessionId || (artifact && value.artifact?.id !== artifact.ref.id) ||
          (baseId && value.comparison?.id !== baseId) || selected && value.current && deviceKey(value.current.target) !== deviceKey(selected)) throw new Error(t("Device parameter preview is unavailable."));
      preview = value; loaded = true;
      status.hidden = !value.bindingError && !value.switchError && value.devices.length > 0;
      bindings.text(status, () => value.bindingError || value.switchError ? message((value.bindingError ?? value.switchError)!) : value.devices.length ? "" : t("No devices are available in this Live Set."));
    } catch (error) {
      if (current() && reading === controller) { preview = undefined; status.hidden = false; bindings.text(status, () => errorText(error, "Device parameter preview is unavailable.")); }
    } finally { if (reading === controller) { reading = undefined; render(); } }
  }
  async function run(command: ParameterArtifactCommand) {
    if (!current() || busy || pending || reading || !loaded) return;
    pending = true; syncBusy();
    let resultMessage: LocalizedText | undefined;
    try {
      const completed = await deps.command(command);
      if (!current()) return;
      if (!completed) resultMessage = () => t("Parameter operation did not finish. Refresh and review the saved result before retrying.");
    } catch (error) {
      if (current()) resultMessage = () => errorText(error, "Device parameter operation failed.");
    } finally {
      pending = false; syncBusy();
      if (current()) { await load(); if (current() && preview && resultMessage) { status.hidden = false; bindings.text(status, resultMessage); } }
    }
  }
  async function runSave() {
    if (save.disabled) return;
    if (artifact) await run({ kind: "apply_device_parameters", sessionId: deps.sessionId, artifactId: artifact.ref.id, ...(selectedDevice ? { target: destination(selectedDevice) } : {}) });
    else if (selectedDevice) await run({ kind: "capture_device_parameters", sessionId: deps.sessionId, target: destination(selectedDevice), label: name.value.trim() });
  }
  devices.addEventListener("change", () => {
    selectedDevice = preview?.devices.find((entry) => deviceKey(entry) === devices.value);
    if (!nameEdited) name.value = selectedDevice?.deviceName.slice(0, 120) ?? "";
    if (artifact) void load(); else syncBusy();
  });
  comparison.addEventListener("change", () => { void load(); });
  receiptDetails.addEventListener("toggle", () => { if (receiptDetails.open) render(); });
  restorationDetails.addEventListener("toggle", () => { if (restorationDetails.open) render(); });
  name.addEventListener("input", () => { nameEdited = true; syncBusy(); });
  keep.addEventListener("click", () => { if (!keep.disabled && preview?.application) void run({ kind: "keep_device_parameters", sessionId: deps.sessionId, applicationId: preview.application.id }); });
  openApplied.addEventListener("click", () => { if (!openApplied.disabled && preview?.application) void deps.openArtifact(preview.application.artifactId); });
  openOriginal.addEventListener("click", () => { if (!openOriginal.disabled && preview?.application?.baselineArtifactId) void deps.openArtifact(preview.application.baselineArtifactId); });
  restore.addEventListener("click", () => { if (!restore.disabled && preview?.application) void run({ kind: "restore_device_parameters", sessionId: deps.sessionId, applicationId: preview.application.id }); });
  originalChoice.addEventListener("click", () => { if (!originalChoice.disabled && preview?.application) void run({ kind: "restore_device_parameters", sessionId: deps.sessionId, applicationId: preview.application.id,
    ...(deps.presentationId ? { presentationId: deps.presentationId } : {}) }); });
  if (presentation === "chat") setCandidates(candidates);
  return { element: root, details, setCandidates, artifact: () => artifact,
    update(value?: SessionArtifact) {
      const previousVersions = JSON.stringify(artifact?.versions);
      artifact = value ?? artifact;
      const localeChanged = bindings.refresh(root);
      if (localeChanged) { table.refreshLocale(); receiptTable.refreshLocale(); restorationTable.refreshLocale(); }
      if ((!loaded || suspended) && !reading && deps.isCurrent()) { suspended = false; void load(); }
      else if (localeChanged || previousVersions !== JSON.stringify(artifact?.versions)) render();
    },
    setBusy(value: boolean) { busy = value; syncBusy(); },
    invalidate() {
      loaded = false; reading?.abort(); reading = undefined; syncBusy();
      if (current() && !pending) void load();
    },
    suspend() { suspended = true; reading?.abort(); reading = undefined; },
    dispose() { disposed = true; reading?.abort(); },
  };
}
