import {
  AppBridge,
  type McpUiResourceCsp,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  parseJSONRPCMessage,
  type CallToolResult,
  type JSONRPCMessage,
  type ReadResourceResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type Transport,
} from "@modelcontextprotocol/client";
import { type PluginResultActions } from "./plugin-results.js";
import "./plugin-results.js";
import "./candidates.js";

interface PluginAppsDependencies {
  resultActions?: PluginResultActions;
  getState(): { activeSessionId?: string; plugins?: unknown[]; integrationConnections?: { revision: string } };
  createAppId(): string;
  openApp(input: { id: string; sessionId: string; toolName: string; signature: string }, signal: AbortSignal): Promise<{
    id: string; toolName: string; resourceUri: string; html: string; sandboxUrl: string; csp?: McpUiResourceCsp;
    toolInput?: Record<string, unknown>; toolResult?: CallToolResult;
  }>;
  callTool(input: { id: string; name: string; arguments?: Record<string, unknown> }, signal?: AbortSignal): Promise<CallToolResult>;
  readResource(input: { id: string; uri: string }, signal?: AbortSignal): Promise<ReadResourceResult>;
  listResources?(input: { id: string; cursor?: string }, templates: boolean, signal?: AbortSignal): Promise<ListResourcesResult | ListResourceTemplatesResult>;
  closeApp(id: string): Promise<void>;
}

interface PluginApps {
  open(tool: { name: string; description?: string; app: { signature: string; toolName?: string } }): Promise<void>;
  close(): Promise<void>;
  sync(): void;
  setBusy(busy: boolean): void;
}

declare global {
  interface Window {
    LiveSmithFactories?: Record<string, unknown> & { createPluginApps?: (deps: PluginAppsDependencies) => PluginApps };
    LiveSmithI18n?: { t(source: string, values?: Record<string, string>): string };
  }
}

class AppFrameTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onerror?: Transport["onerror"];
  onclose?: Transport["onclose"];
  private readonly receive = (event: MessageEvent): void => {
    if (event.source !== this.target || event.origin !== this.origin) return;
    try { this.onmessage?.(parseJSONRPCMessage(event.data)); }
    catch { this.onerror?.(new Error("MCP App sent an invalid protocol message.")); }
  };

  constructor(private readonly target: Window, private readonly origin: string) {}
  async start(): Promise<void> { window.addEventListener("message", this.receive); }
  async send(message: JSONRPCMessage): Promise<void> { this.target.postMessage(message, this.origin); }
  async close(): Promise<void> {
    window.removeEventListener("message", this.receive);
    this.onclose?.();
  }
}

interface OpenApp {
  owner: string;
  openController: AbortController;
  dialog: HTMLDialogElement;
  frame: HTMLIFrameElement;
  status: HTMLElement;
  previousFocus: Element | null;
  id: string;
  bridge?: AppBridge;
  timer?: number;
  initialized: boolean;
  closed: boolean;
}

function createPluginApps(deps: PluginAppsDependencies): PluginApps {
  let active: OpenApp | undefined;
  let busy = false;
  let sequence = 0;
  const t = (source: string): string => window.LiveSmithI18n?.t(source) ?? source;
  const owner = (): string => {
    const state = deps.getState();
    return JSON.stringify([state.activeSessionId, state.plugins, state.integrationConnections?.revision]);
  };
  const isCurrent = (app: OpenApp): boolean => active === app && !app.closed && owner() === app.owner;

  function assertRequest(app: OpenApp, signal: AbortSignal): void {
    if (!isCurrent(app) || !app.initialized || signal.aborted) throw new Error(t("MCP App is no longer active."));
  }

  async function dispose(app: OpenApp): Promise<void> {
    if (app.closed) return;
    app.closed = true;
    app.openController.abort();
    if (app.timer !== undefined) window.clearTimeout(app.timer);
    const closed = deps.closeApp(app.id);
    // Begin backend cancellation before waiting for the App's bounded teardown.
    const backend = closed.then(() => undefined, () => new Error(t("MCP App could not be closed.")));
    try {
      if (app.initialized && app.bridge) {
        await app.bridge.teardownResource({}, { timeout: 1000, maxTotalTimeout: 1000 }).catch(() => undefined);
      }
    } finally {
      await app.bridge?.close();
      app.dialog.remove();
      if (app.previousFocus instanceof HTMLElement && app.previousFocus.isConnected) app.previousFocus.focus();
    }
    const error = await backend;
    if (error) throw error;
  }

  async function close(): Promise<void> {
    sequence += 1;
    const app = active;
    active = undefined;
    if (app) await dispose(app);
  }

  function closeFromUi(): void {
    const app = active;
    void close().catch(() => {
      if (app) app.status.textContent = t("MCP App could not be closed.");
    });
  }

  async function failLoad(app: OpenApp): Promise<void> {
    if (!isCurrent(app)) return;
    app.openController.abort();
    app.status.textContent = t("MCP App could not load.");
    app.frame.remove();
    if (app.timer !== undefined) window.clearTimeout(app.timer);
    const id = app.id;
    const bridge = app.bridge;
    delete app.bridge;
    app.initialized = false;
    await Promise.allSettled([bridge?.close(), deps.closeApp(id)]);
  }

  return {
    async open(tool) {
      const previous = close();
      const attempt = sequence;
      await previous;
      if (attempt !== sequence) return;
      const sessionId = deps.getState().activeSessionId;
      if (!sessionId || busy) return;
      const dialog = document.createElement("dialog");
      dialog.className = "plugin-app-dialog";
      dialog.setAttribute("aria-modal", "true");
      const heading = document.createElement("h3");
      heading.id = "plugin-app-title";
      heading.textContent = tool.name;
      heading.setAttribute("translate", "no");
      dialog.setAttribute("aria-labelledby", heading.id);
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "secondary plugin-app-close";
      closeButton.textContent = t("Close App");
      closeButton.addEventListener("click", closeFromUi);
      const status = document.createElement("p");
      status.className = "plugin-app-status";
      status.setAttribute("role", "status");
      status.textContent = t("Loading MCP App…");
      const frame = document.createElement("iframe");
      frame.className = "plugin-app-frame";
      frame.title = tool.name;
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
      frame.referrerPolicy = "no-referrer";
      dialog.append(heading, closeButton);
      if (tool.description) {
        const description = document.createElement("p");
        description.className = "plugin-app-description";
        description.textContent = tool.description;
        description.setAttribute("translate", "no");
        dialog.append(description);
      }
      dialog.append(status, frame);
      const results = document.createElement("div");
      results.className = "plugin-app-results";
      results.hidden = true;
      dialog.append(results);
      const app: OpenApp = {
        id: deps.createAppId(), owner: owner(), openController: new window.AbortController(), dialog, frame, status, previousFocus: document.activeElement, initialized: false, closed: false,
      };
      active = app;
      const showResult = (result: CallToolResult) => {
        if (!deps.resultActions || !isCurrent(app)) return;
        results.replaceChildren(deps.resultActions.create(tool.name, result));
        results.hidden = false;
      };
      dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeFromUi(); });
      dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); closeFromUi(); } });
      document.body.append(dialog);
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      closeButton.focus();
      try {
        const resource = await deps.openApp({ id: app.id, sessionId, toolName: tool.app.toolName ?? tool.name, signature: tool.app.signature }, app.openController.signal);
        if (sequence !== attempt || !isCurrent(app)) {
          if (active === app) await close();
          return;
        }
        const sandbox = new window.URL(resource.sandboxUrl);
        if (sandbox.origin === window.location.origin || sandbox.protocol !== "http:" || sandbox.hostname !== "127.0.0.1" ||
            sandbox.username || sandbox.password || sandbox.search || sandbox.hash) {
          throw new Error("Invalid MCP App sandbox address.");
        }
        const bridge = new AppBridge(null, { name: "live-smith", version: "0.2.2" }, {
          serverTools: {}, serverResources: {}, sandbox: { ...(resource.csp ? { csp: resource.csp } : {}) },
        }, { hostContext: {
          theme: window.getComputedStyle(document.documentElement).colorScheme.includes("dark") ? "dark" : "light",
          locale: document.documentElement.lang || window.navigator.language,
          displayMode: "inline", availableDisplayModes: ["inline"], platform: "desktop",
        } });
        app.bridge = bridge;
        bridge.oncalltool = async (params, extra) => {
          const signal = extra.mcpReq.signal;
          assertRequest(app, signal);
          if (busy) throw new Error(t("Wait for the current operation to finish."));
          status.textContent = t("Running App tool…");
          try {
            const result = await deps.callTool({ id: app.id, name: params.name,
              ...(params.arguments === undefined ? {} : { arguments: params.arguments }) }, signal);
            assertRequest(app, signal);
            if (params.name === resource.toolName) showResult(result);
            status.textContent = result.isError ? t("App tool failed.") : t("App ready.");
            return result;
          } catch {
            if (isCurrent(app)) status.textContent = t("App tool result was not confirmed. Check Session history before retrying.");
            throw new Error(t("App tool result was not confirmed. Check Session history before retrying."));
          }
        };
        bridge.onreadresource = async (params, extra) => {
          const signal = extra.mcpReq.signal;
          assertRequest(app, signal);
          if (busy) throw new Error(t("Wait for the current operation to finish."));
          try {
            const result = await deps.readResource({ id: app.id, uri: params.uri }, signal);
            assertRequest(app, signal);
            return result;
          } catch { throw new Error(t("MCP App resource could not be read.")); }
        };
        if (deps.listResources) {
          const list = async (params: { cursor?: string | undefined } | undefined, signal: AbortSignal, templates: boolean) => {
            assertRequest(app, signal);
            if (busy) throw new Error(t("Wait for the current operation to finish."));
            const result = await deps.listResources!({ id: app.id, ...(params?.cursor === undefined ? {} : { cursor: params.cursor }) }, templates, signal);
            assertRequest(app, signal);
            return result;
          };
          bridge.onlistresources = (params, extra) => list(params, extra.mcpReq.signal, false) as Promise<ListResourcesResult>;
          bridge.onlistresourcetemplates = (params, extra) => list(params, extra.mcpReq.signal, true) as Promise<ListResourceTemplatesResult>;
        }
        let loaded = false;
        bridge.addEventListener("sandboxready", () => {
          if (!isCurrent(app) || loaded) return;
          loaded = true;
          void bridge.sendSandboxResourceReady({ html: resource.html, sandbox: "allow-scripts",
            ...(resource.csp ? { csp: resource.csp } : {}) }).catch(() => { status.textContent = t("MCP App could not load."); });
        });
        bridge.addEventListener("initialized", () => {
          if (!isCurrent(app) || app.initialized) return;
          app.initialized = true;
          if (app.timer !== undefined) window.clearTimeout(app.timer);
          status.textContent = t("App ready.");
          void (async () => {
            await bridge.sendToolInput({ arguments: resource.toolInput ?? {} });
            if (resource.toolResult && isCurrent(app)) {
              showResult(resource.toolResult);
              await bridge.sendToolResult(resource.toolResult);
            }
          })().catch(() => { status.textContent = t("MCP App could not load."); });
        });
        bridge.addEventListener("sizechange", ({ height }) => {
          if (isCurrent(app) && typeof height === "number" && Number.isFinite(height)) frame.height = String(Math.min(900, Math.max(180, height)));
        });
        bridge.addEventListener("requestteardown", () => { if (isCurrent(app)) closeFromUi(); });
        frame.src = sandbox.href;
        await bridge.connect(new AppFrameTransport(frame.contentWindow!, sandbox.origin));
        app.timer = window.setTimeout(() => {
          if (!isCurrent(app) || app.initialized) return;
          void failLoad(app);
        }, 15_000);
      } catch {
        await failLoad(app);
      }
    },
    close,
    sync() { if (active && owner() !== active.owner) closeFromUi(); },
    setBusy(value) {
      busy = value;
      if (active) {
        active.frame.inert = value;
        active.dialog.setAttribute("aria-busy", String(value));
      }
    },
  };
}

window.LiveSmithFactories = window.LiveSmithFactories || {};
window.LiveSmithFactories.createPluginApps = createPluginApps;
