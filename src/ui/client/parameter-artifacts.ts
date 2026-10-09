import { isParameterArtifactPreview, type ParameterArtifactRead, type ParameterArtifactCommand, type ParameterArtifactPreview } from "../../app/parameters/contracts.js";
import { parameterApplicationIsOpen, type DeviceParameterTarget } from "../../agent/device-parameter-contracts.js";
import type { SessionArtifact } from "../../app/session/session-artifacts.js";
import { createLocaleBindings, type LocalizedText } from "./locale-bindings.js";
import { createParameterTable } from "./parameter-table.js";
import { formatUiMessage, isUiMessage, type UiMessage } from "../../i18n/ui-message.js";

export interface ParameterArtifactDependencies {
  sessionId: string;
  isCurrent(): boolean;
  read(input: ParameterArtifactRead, signal?: AbortSignal): Promise<unknown>;
  command(input: ParameterArtifactCommand): Promise<boolean>;
  onCommandSettled(source: HTMLElement, kind: ParameterArtifactCommand["kind"]): void;
  openArtifact(id: string): Promise<void>;
}
const destination = ({ runtimeId, songId, trackId, deviceId }: DeviceParameterTarget) => ({ runtimeId, songId, trackId, deviceId });
const deviceKey = (device: DeviceParameterTarget) => `${device.trackId}:${device.deviceId}`;

/** Owns one exact version or the explicit capture form; command receipts remain server-owned. */
export function createParameterArtifactView(deps: ParameterArtifactDependencies, initial?: SessionArtifact) {
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
  const button = (text: string, action: () => void) => { const element = node("button", () => t(text)); element.className = "secondary"; element.type = "button"; element.addEventListener("click", action); actions.append(element); return element; };
  const refresh = button("Refresh device parameters", () => { void load(); });
  const save = button(initial ? "Apply to Live" : "Save parameter snapshot", () => { void runSave(); });
  const receipt = node("section"); receipt.className = "parameter-application";
  const receiptText = node("p"); receiptText.className = "field-hint";
  const receiptSource = node("p");
  const receiptActions = node("div"); receiptActions.className = "artifact-actions";
  const keep = node("button", () => t("Keep current values")); keep.type = "button"; keep.className = "secondary";
  const restore = node("button", () => t("Restore previous values")); restore.type = "button"; restore.className = "secondary";
  const openApplied = node("button", () => t("Open applied version")); openApplied.type = "button"; openApplied.className = "secondary";
  const receiptHint = node("p"); receiptHint.className = "field-hint";
  const receiptDetails = node("details"); receiptDetails.append(node("summary", () => t("Application details")));
  const receiptTable = createParameterTable(); receiptDetails.append(receiptTable.element);
  const restorationDetails = node("details"); restorationDetails.append(node("summary", () => t("Values before restoration")));
  const restorationTable = createParameterTable(); restorationDetails.append(restorationTable.element); restorationDetails.hidden = true;
  receiptActions.append(keep, restore, openApplied); receipt.append(receiptSource, receiptText, receiptHint, receiptActions, receiptDetails, restorationDetails); receipt.hidden = true;
  const table = createParameterTable(); table.element.hidden = !initial;
  root.append(source, deviceLabel, label, comparisonLabel, actions, status, receipt, table.element);
  let artifact = initial;
  let preview: ParameterArtifactPreview | undefined;
  let reading: AbortController | undefined;
  let selectedDevice: DeviceParameterTarget | undefined;
  let busy = false, pending = false, disposed = false, suspended = false, loaded = false;
  let nameEdited = false;
  const current = () => !disposed && !suspended && deps.isCurrent();
  function syncBusy() {
    const locked = busy || pending;
    devices.disabled = comparison.disabled = name.disabled = locked;
    refresh.disabled = Boolean(reading) || pending;
    save.disabled = locked || Boolean(reading) || !preview || (artifact ? !preview.current || Boolean(preview.application && parameterApplicationIsOpen(preview.application)) : !selectedDevice || !name.value.trim());
    keep.disabled = restore.disabled = locked || Boolean(reading) || !preview?.application || !parameterApplicationIsOpen(preview.application);
    openApplied.disabled = pending || Boolean(reading) || !preview?.application;
    restore.disabled ||= Boolean(preview?.restoreError);
    if (preview?.application) restore.disabled ||= preview.application.entries.some((entry) => entry.state === "applying" || entry.state === "restoring" || entry.state === "conflict");
  }
  function render() {
    if (!preview) { table.element.hidden = receipt.hidden = true; syncBusy(); return; }
    const key = devices.value;
    devices.replaceChildren();
    const original = node("option", () => t(artifact ? "Original device binding" : "Choose a device")); original.value = ""; devices.append(original);
    for (const device of preview.devices) { const option = node("option", () => deviceLabelText(device)); option.value = deviceKey(device); devices.append(option); }
    devices.value = key;
    if (selectedDevice && !preview.devices.some((device) => deviceKey(device) === deviceKey(selectedDevice!) && device.runtimeId === selectedDevice!.runtimeId)) {
      selectedDevice = undefined; devices.value = "";
    }
    const compared = comparison.value || "live";
    comparison.replaceChildren(); const live = node("option", () => t("Current Live values")); live.value = "live"; comparison.append(live);
    for (const version of artifact?.versions ?? []) if (version.id !== artifact!.ref.id) {
      const option = node("option", `v${version.number} · ${version.label}`); option.value = version.id; comparison.append(option);
    }
    comparison.value = [...comparison.options].some((option) => option.value === compared) ? compared : "live";
    const saved = preview.artifact;
    table.element.hidden = !saved || Boolean(reading);
    if (saved) {
      bindings.text(source, () => deviceLabelText(saved.target));
      const before = comparison.value === "live" ? preview.current?.parameters : preview.comparison?.parameters;
      table.update(saved.parameters.map((parameter, index) => ({ index: parameter.index, name: parameter.name, after: parameter.value, min: parameter.min, max: parameter.max,
        ...(before?.[index] ? { before: before[index]!.value } : {}) })), { before: comparison.value === "live" ? "Current value" : "Compared version", after: "Saved value" });
    }
    const application = preview.application;
    receipt.hidden = !application || Boolean(reading);
    if (application) {
      bindings.text(receiptSource, () => t("Applied version: {name} · v{version}", { name: application.artifactLabel, version: String(application.artifactVersion) }));
      openApplied.hidden = application.artifactId === artifact?.ref.id;
      bindings.text(receiptText, () => t("Parameter application: {status} · {device}", { status: t(application.status), device: `${application.target.trackName} · ${application.target.deviceName}` }));
      keep.hidden = restore.hidden = !parameterApplicationIsOpen(application);
      receiptActions.hidden = keep.hidden && openApplied.hidden;
      receiptHint.hidden = !parameterApplicationIsOpen(application) || !preview.restoreError;
      bindings.text(receiptHint, () => message(preview?.restoreError ?? ""));
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
    reading?.abort(); const controller = new window.AbortController(); reading = controller; syncBusy();
    table.element.hidden = receipt.hidden = true;
    status.hidden = false; bindings.text(status, () => t("Reading device parameters…"));
    const baseId = comparison.value && comparison.value !== "live" ? comparison.value : undefined;
    const selected = selectedDevice;
    try {
      const value = await deps.read({ sessionId: deps.sessionId, ...(artifact ? { artifactId: artifact.ref.id } : {}),
        ...(selected ? { target: destination(selected) } : {}), ...(baseId ? { baseArtifactId: baseId } : {}) }, controller.signal);
      if (!current() || reading !== controller) return;
      if (!isParameterArtifactPreview(value) || value.sessionId !== deps.sessionId || (artifact && value.artifact?.id !== artifact.ref.id) ||
          (baseId && value.comparison?.id !== baseId) || selected && value.current && deviceKey(value.current.target) !== deviceKey(selected)) throw new Error(t("Device parameter preview is unavailable."));
      preview = value; loaded = true;
      status.hidden = !value.bindingError && value.devices.length > 0;
      bindings.text(status, () => value.bindingError ? message(value.bindingError) : value.devices.length ? "" : t("No devices are available in this Live Set."));
    } catch (error) {
      if (current() && reading === controller) { preview = undefined; status.hidden = false; bindings.text(status, () => errorText(error, "Device parameter preview is unavailable.")); }
    } finally { if (reading === controller) { reading = undefined; render(); } }
  }
  async function run(command: ParameterArtifactCommand) {
    if (!current() || busy || pending || reading) return;
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
      deps.onCommandSettled(root, command.kind);
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
  restore.addEventListener("click", () => { if (!restore.disabled && preview?.application) void run({ kind: "restore_device_parameters", sessionId: deps.sessionId, applicationId: preview.application.id }); });
  return { element: root,
    update(value?: SessionArtifact) {
      const previousVersions = JSON.stringify(artifact?.versions);
      artifact = value ?? artifact;
      const localeChanged = bindings.refresh(root);
      if (localeChanged) { table.refreshLocale(); receiptTable.refreshLocale(); restorationTable.refreshLocale(); }
      if ((!loaded || suspended) && !reading && deps.isCurrent()) { suspended = false; void load(); }
      else if (localeChanged || previousVersions !== JSON.stringify(artifact?.versions)) render();
    },
    setBusy(value: boolean) { busy = value; syncBusy(); },
    invalidate(source: HTMLElement) {
      if (source === root) return;
      loaded = false; preview = undefined; reading?.abort(); reading = undefined; syncBusy();
      if (current() && !pending) void load();
    },
    suspend() { suspended = true; reading?.abort(); reading = undefined; },
    dispose() { disposed = true; reading?.abort(); },
  };
}
