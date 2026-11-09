import { createHostAbortController, throwIfAborted } from "../runtime/host.js";
import { uiMessage } from "../i18n/ui-message.js";
import { createNativeChatHost, NativeChatCancelledError } from "../runtime/native-chat-window.js";
import type { ExtensionContext } from "@ableton-extensions/sdk";
import type { LiveInteractionContext } from "../live/context.js";
import { createLiveSetGuard } from "../live/set-identity.js";
import { loadAgentSettings } from "../storage/settings.js";
import { createSystemBrowserOpener } from "../runtime/system-browser.js";
import { projectKeyForContext } from "./context/session-context.js";
import { createAgentRuntime, runAgentFlow, type AgentFlowDependencies, type AgentRuntime } from "./agent-flow.js";
import { interactionContextForScope } from "../live/context.js";
import { listSessions } from "../storage/sessions.js";

type Api = ExtensionContext<"1.0.0">;
type WindowDependencies = AgentFlowDependencies & { openBrowser?: (url: string) => Promise<void> };

/** One activation owns one browser runtime; invocation changes are serialized. */
export function createWindowHostController(context: Api, dependencies: WindowDependencies = {}) {
  const openBrowser = dependencies.openBrowser ?? createSystemBrowserOpener({ allowLoopbackHttp: true });
  const nativeHost = dependencies.nativeChatHost ?? createNativeChatHost({
    ...(context.environment?.tempDirectory === undefined ? {} : { temporaryDirectory: context.environment.tempDirectory }),
  });
  const nativeOperations = new Set<{ controller: AbortController; done: Promise<void> }>();
  let browser: { key: string; projectKey: string; runtime: AgentRuntime } | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  };
  const closeBrowser = async () => {
    const previous = browser;
    browser = undefined;
    await previous?.runtime.close();
  };
  return {
    async openSession(sessionId: string): Promise<void> {
      await serialize(async () => {
        const projectKey = projectKeyForContext(context);
        const session = (await listSessions(context.environment.storageDirectory, projectKey)).find(entry => entry.id === sessionId && !entry.archivedAt);
        if (!session) throw new Error("Open the Live Set containing this Session to review its operation.");
        if (browser && browser.projectKey !== projectKey) await closeBrowser();
        if (!browser) {
          const interaction = interactionContextForScope(context, session.scope) ?? {
            scope: session.scope, target: {}, summary: "External tools are bound to this Live Set. Observe explicit targets before editing.",
            presentation: { origin: "object" as const, objectKind: "other" as const, title: session.title || "Live Set", details: [] },
          };
          browser = { key: `external:${sessionId}`, projectKey,
            runtime: await createAgentRuntime(context, interaction, { ...dependencies, initialSessionId: sessionId }, "browser") };
        } else await browser.runtime.reopen(sessionId);
        await openBrowser(browser.runtime.url);
      });
    },
    async open(interaction: LiveInteractionContext): Promise<void> {
      const assertLiveSetCurrent = createLiveSetGuard(context);
      const projectKey = projectKeyForContext(context);
      // A modal owns its own lifetime, independent of a browser's admitted work.
      const mode = (await loadAgentSettings(context.environment.storageDirectory)).interfaceMode;
      if (mode === "native" && nativeHost.supported) {
        assertLiveSetCurrent();
        const controller = createHostAbortController();
        let finish!: () => void;
        const operation = { controller, done: new Promise<void>(resolve => { finish = resolve; }) };
        nativeOperations.add(operation);
        let runtime: AgentRuntime | undefined;
        try {
          runtime = await createAgentRuntime(context, interaction, { ...dependencies, nativeChatHost: nativeHost }, "native");
          let window;
          try { window = await nativeHost.open({ url: runtime.url, signal: controller.signal, prepareArtifact: runtime.prepareArtifactExport }); }
          catch (error) {
            if (error instanceof NativeChatCancelledError) return;
            throwIfAborted(controller.signal);
            await runtime.close();
            assertLiveSetCurrent();
            nativeOperations.delete(operation); finish();
            await runAgentFlow(context, interaction, { ...dependencies,
              initialStatus: uiMessage("The separate window could not open. This Live dialog keeps App Preferences available; you can retry Separate window or choose System browser.") });
            return;
          }
          await window.closed;
        } finally {
          try {
            await runtime?.close();
          } finally {
            nativeOperations.delete(operation);
            finish();
          }
        }
        return;
      }
      if (mode === "modal" || mode === "native") {
        await serialize(async () => {
          assertLiveSetCurrent();
          if (browser && !browser.runtime.busy) await closeBrowser();
        });
        assertLiveSetCurrent();
        await runAgentFlow(context, interaction, dependencies);
        return;
      }
      await serialize(async () => {
        assertLiveSetCurrent();
        const key = JSON.stringify([projectKey, interaction.scope.kind, interaction.scope.identity,
          interaction.selectionContext?.identity ?? null]);
        if (browser && browser.projectKey !== projectKey) await closeBrowser();
        if (browser && browser.key !== key) {
          if (browser.runtime.busy) throw new Error("Live Smith is still working in the browser. Return to that tab and finish or Stop the current operation before asking about another selection.");
          await closeBrowser();
        }
        assertLiveSetCurrent();
        const reused = browser !== undefined;
        if (!browser) browser = { key, projectKey, runtime: await createAgentRuntime(context, interaction, dependencies, "browser") };
        if (reused) await browser.runtime.reopen();
        try { await openBrowser(browser.runtime.url); }
        catch {
          if (!reused) await closeBrowser();
          throw new Error("Live Smith could not open the system browser. Check your default browser and try Ask Live Smith again.");
        }
      });
    },
    close: async () => {
      const pending = [...nativeOperations];
      for (const operation of pending) operation.controller.abort();
      await Promise.allSettled(pending.map(operation => operation.done));
      await serialize(closeBrowser);
    },
  };
}
