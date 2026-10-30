import type { ArtifactRef } from "../../agent/artifact-contracts.js";
import type { SessionArtifact } from "../../app/session/session-artifacts.js";
import type { ParameterArtifactCommand, ParameterArtifactRead } from "../../app/parameters/contracts.js";
import { createLocaleBindings } from "./locale-bindings.js";
import { createParameterArtifactView } from "./parameter-artifacts.js";
import { isSessionArtifactDetail } from "./wire-contracts/artifacts.js";

interface Dependencies {
  getState(): { activeSessionId?: string };
  readArtifact(input: { sessionId: string; artifact: ArtifactRef }, signal?: AbortSignal): Promise<unknown>;
  readDeviceParameters(input: ParameterArtifactRead, signal?: AbortSignal): Promise<unknown>;
  parameterCommand(input: ParameterArtifactCommand): Promise<boolean>;
  openArtifact(artifact: SessionArtifact): void;
}

/** Explicitly presented versions share one Live preview per device. */
export function createParameterCandidates(deps: Dependencies, owner: string, presentationId: string, initialRefs: readonly ArtifactRef[]) {
  const bindings = createLocaleBindings();
  const t = (text: string) => window.LiveSmithI18n?.t(text) ?? text;
  const root = document.createElement("section"); root.className = "chat-parameter-candidates";
  const status = document.createElement("p"); status.className = "field-hint"; status.setAttribute("role", "status");
  const retry = document.createElement("button"); retry.type = "button"; retry.className = "secondary";
  bindings.text(retry, () => t("Retry preview")); retry.hidden = true; root.append(status, retry);
  const cards = new Map<string, { element: HTMLElement; view: ReturnType<typeof createParameterArtifactView> }>();
  let refs = [...initialRefs], signature = JSON.stringify(refs);
  let reading: AbortController | undefined, opening: AbortController | undefined;
  let busy = false, suspended = false, disposed = false, visible = false, loaded = false;
  const current = () => !disposed && !suspended && deps.getState().activeSessionId === owner;
  function syncBusy() { for (const card of cards.values()) card.view.setBusy(busy || Boolean(reading) || !loaded); }
  async function openArtifact(id: string) {
    opening?.abort(); const controller = new window.AbortController(); opening = controller;
    try {
      const result = await deps.readArtifact({ sessionId: owner, artifact: { kind: "device-parameters", id } }, controller.signal);
      if (!current() || opening !== controller) return;
      if (!isSessionArtifactDetail(result) || result.sessionId !== owner || result.artifact.ref.kind !== "device-parameters" || result.artifact.ref.id !== id) throw new Error("Unavailable artifact");
      deps.openArtifact(result.artifact);
    } catch {
      if (current() && opening === controller) { status.hidden = false; bindings.text(status, () => t("Saved version is unavailable.")); }
    } finally { if (opening === controller) opening = undefined; }
  }
  async function load() {
    if (!current() || !visible) return;
    reading?.abort(); const controller = new window.AbortController(); reading = controller;
    loaded = false; retry.hidden = true; status.hidden = false; bindings.text(status, () => t("Loading sound choices…")); syncBusy();
    const requested = [...refs];
    try {
      const artifacts = await Promise.all(requested.map(async (ref) => {
        const result = await deps.readArtifact({ sessionId: owner, artifact: ref }, controller.signal);
        if (!isSessionArtifactDetail(result) || result.sessionId !== owner || result.artifact.ref.kind !== "device-parameters" || result.artifact.ref.id !== ref.id || !result.artifact.deviceParameters) throw new Error("Unavailable artifact");
        return result.artifact;
      }));
      if (!current() || reading !== controller) return;
      const devices = new Map<string, SessionArtifact[]>();
      for (const artifact of artifacts) {
        const target = artifact.deviceParameters!.target;
        const key = JSON.stringify([target.runtimeId, target.songId, target.trackId, target.deviceId]);
        const group = devices.get(key) ?? []; if (!group.some((entry) => entry.ref.id === artifact.ref.id)) group.push(artifact); devices.set(key, group);
      }
      for (const [key, card] of cards) if (!devices.has(key)) { card.view.dispose(); card.element.remove(); cards.delete(key); }
      for (const [key, alternatives] of devices) {
        let card = cards.get(key);
        if (!card) {
          const element = document.createElement("article"); element.className = "timeline-item sound-comparison-card";
          const header = document.createElement("div"); header.className = "timeline-message-header";
          const heading = document.createElement("h3"); heading.className = "timeline-label"; bindings.text(heading, () => t("Sound comparison"));
          const device = document.createElement("span"); device.className = "timeline-label";
          const target = alternatives[0]!.deviceParameters!.target; device.textContent = device.title = `${target.trackName} · ${target.deviceName}`;
          header.append(heading, device);
          const content = document.createElement("div"); content.className = "timeline-content";
          const view = createParameterArtifactView({ sessionId: owner, presentationId, isCurrent: current, read: deps.readDeviceParameters,
            command: deps.parameterCommand, openArtifact }, alternatives[0], "chat");
          const open = document.createElement("button"); open.type = "button"; open.className = "secondary";
          bindings.text(open, () => t("Open artifact")); open.addEventListener("click", () => { const artifact = view.artifact(); if (current() && artifact) deps.openArtifact(artifact); });
          view.details!.append(open); content.append(view.element); element.append(header, content); root.append(element);
          card = { element, view }; cards.set(key, card);
        }
        card.view.setCandidates(alternatives); card.view.update();
      }
      loaded = true; status.hidden = true;
    } catch {
      if (current() && reading === controller) { bindings.text(status, () => t("Parameter preview is unavailable. Retry or open Artifacts.")); retry.hidden = false; }
    } finally { if (reading === controller) { reading = undefined; syncBusy(); } }
  }
  const observer = typeof window.IntersectionObserver === "function" ? new window.IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) { visible = true; observer!.disconnect(); void load(); }
  }, { rootMargin: "200px" }) : undefined;
  retry.addEventListener("click", () => { void load(); });
  if (observer) observer.observe(root); else { visible = true; void load(); }
  return { element: root,
    setReferences(value: readonly ArtifactRef[]) { const next = JSON.stringify(value); if (signature === next) return; refs = [...value]; signature = next; loaded = false; void load(); },
    setBusy(value: boolean) { busy = value; syncBusy(); },
    refreshLocale() { bindings.refresh(root); for (const card of cards.values()) card.view.update(); },
    invalidateParameters() { for (const card of cards.values()) card.view.invalidate(); },
    suspend() { suspended = true; reading?.abort(); reading = undefined; opening?.abort(); observer?.disconnect(); for (const card of cards.values()) card.view.suspend(); },
    resume() { suspended = false; if (!loaded) { if (visible) void load(); else observer?.observe(root); } else for (const card of cards.values()) card.view.update(); },
    dispose() { disposed = true; reading?.abort(); opening?.abort(); observer?.disconnect(); for (const card of cards.values()) card.view.dispose(); cards.clear(); },
  };
}
