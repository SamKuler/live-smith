import { artifactKey, type ArtifactRef } from "../../agent/artifact-contracts.js";

interface Input { sessionId: string; artifact: ArtifactRef }
interface Binding {
  read(): Input | undefined;
  button: HTMLButtonElement;
  prepared?: { key: string; token: string };
  pending?: { key: string; promise: Promise<string> };
  failedKey?: string;
}
interface NativeDragController {
  receive(message: { type: string; id: string; token?: string }): void;
  create(read: () => Input | undefined): HTMLButtonElement;
  refreshLocale(): void;
}
const browser = window as typeof window & {
  __LIVE_SMITH_BRIDGE__?: { nativeArtifactDrag?: boolean };
  webkit?: { messageHandlers?: { nativeDrag?: { postMessage(value: unknown): void } } };
  LiveSmithNativeDrag?: NativeDragController;
};
const nativeArtifactDragAvailable = browser.__LIVE_SMITH_BRIDGE__?.nativeArtifactDrag === true;
const keyFor = (input: Input) => `${input.sessionId}:${artifactKey(input.artifact)}`;

export function createNativeArtifactDragButton(read: () => Input | undefined): HTMLButtonElement | undefined {
  if (!nativeArtifactDragAvailable || !browser.webkit?.messageHandlers?.nativeDrag) return undefined;
  browser.LiveSmithNativeDrag ??= createController();
  return browser.LiveSmithNativeDrag.create(read);
}

function createController(): NativeDragController {
  const bindings = new WeakMap<HTMLButtonElement, Binding>();
  const pending = new Map<string, { resolve(token: string): void; reject(): void }>();
  const pageId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  let serial = 0;
  let active: { binding: Binding; key: string; x: number; y: number; moved: boolean; started: boolean; id: string } | undefined;
  const t = (text: string) => window.LiveSmithI18n?.t(text) ?? text;
  const post = (message: unknown) => browser.webkit!.messageHandlers!.nativeDrag!.postMessage(message);
  const usable = (binding: Binding) => binding.button.isConnected && !binding.button.matches(":disabled") ? binding.read() : undefined;
  function render(binding: Binding) {
    const input = binding.read();
    const key = input ? keyFor(input) : undefined;
    const preparing = binding.pending !== undefined && binding.pending.key === key;
    const failed = binding.failedKey !== undefined && binding.failedKey === key;
    binding.button.textContent = t(preparing ? "Preparing file…" : failed ? "Retry file preparation"
      : input?.artifact.kind === "midi" ? "Drag MIDI" : "Drag audio");
    binding.button.toggleAttribute("data-preparation-failed", failed);
    if (failed) {
      const hint = document.createElement("span");
      hint.className = "field-hint";
      hint.textContent = t("Use Export instead if needed.");
      binding.button.append(hint);
    }
    if (preparing || failed) binding.button.removeAttribute("title");
    else binding.button.title = t("Drag this file to a DAW track or a folder.");
    if (preparing) binding.button.setAttribute("aria-busy", "true");
    else binding.button.removeAttribute("aria-busy");
  }
  const finish = () => { active = undefined; };
  const start = () => {
    const drag = active;
    if (!drag || !drag.moved || drag.started) return;
    const input = usable(drag.binding);
    if (!input || keyFor(input) !== drag.key) { finish(); return; }
    const prepared = drag.binding.prepared;
    if (prepared?.key !== drag.key) return;
    drag.started = true;
    post({ type: "start", id: drag.id, token: prepared.token });
  };
  function prepare(binding: Binding): Promise<string> | undefined {
    const input = usable(binding);
    if (!input) return undefined;
    const key = keyFor(input);
    if (binding.prepared?.key === key) return Promise.resolve(binding.prepared.token);
    if (binding.pending?.key === key) return binding.pending.promise;
    const id = `${pageId}_${++serial}`;
    const promise = new Promise<string>((resolve, reject) => {
      const timeout = window.setTimeout(() => { pending.delete(id); reject(new Error("File preparation timed out")); }, 30_000);
      pending.set(id, { resolve(token) { window.clearTimeout(timeout); resolve(token); }, reject() { window.clearTimeout(timeout); reject(new Error("File preparation failed")); } });
      post({ type: "prepare", id, sessionId: input.sessionId, artifact: input.artifact });
    });
    binding.pending = { key, promise };
    delete binding.failedKey;
    render(binding);
    void promise.then(token => {
      if (binding.pending?.promise !== promise) return;
      binding.prepared = { key, token }; delete binding.pending;
      render(binding); start();
    }, () => {
      if (binding.pending?.promise !== promise) return;
      delete binding.pending;
      binding.failedKey = key;
      render(binding);
      if (active?.binding === binding) finish();
    });
    return promise;
  }
  document.addEventListener("pointermove", event => {
    if (!active) return;
    if (!(event.buttons & 1)) { finish(); return; }
    if (Math.hypot(event.clientX - active.x, event.clientY - active.y) >= 5) active.moved = true;
    start();
  }, true);
  document.addEventListener("pointerup", finish, true);
  document.addEventListener("pointercancel", finish, true);
  window.addEventListener("blur", finish);
  window.addEventListener("pagehide", () => {
    finish(); for (const waiter of pending.values()) waiter.reject(); pending.clear();
  });
  return {
    refreshLocale() {
      for (const button of document.querySelectorAll<HTMLButtonElement>(".artifact-native-drag")) {
        const binding = bindings.get(button);
        if (binding) render(binding);
      }
    },
    receive(message) {
      if (!message || typeof message.id !== "string") return;
      if (message.type === "prepared" && typeof message.token === "string") {
        pending.get(message.id)?.resolve(message.token); pending.delete(message.id);
      } else if (message.type === "prepare_failed") {
        pending.get(message.id)?.reject(); pending.delete(message.id);
      } else if (message.type === "ended" && active?.id === message.id) finish();
    },
    create(read) {
      const button = document.createElement("button"); button.type = "button"; button.className = "secondary artifact-native-drag";
      const binding: Binding = { read, button }; bindings.set(button, binding);
      render(binding);
      button.addEventListener("pointerenter", () => { void prepare(binding); });
      button.addEventListener("focus", () => { void prepare(binding); });
      button.addEventListener("click", () => { void prepare(binding); });
      button.addEventListener("dragstart", event => event.preventDefault());
      button.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        const input = usable(binding); if (!input) return;
        event.preventDefault(); button.focus({ preventScroll: true });
        active = { binding, key: keyFor(input), x: event.clientX, y: event.clientY, moved: false, started: false, id: `${pageId}_${++serial}` };
        void prepare(binding);
      });
      return button;
    },
  };
}
window.LiveSmithFactories ??= {};
window.LiveSmithFactories.createNativeArtifactDragButton = createNativeArtifactDragButton;
