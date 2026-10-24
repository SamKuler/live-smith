import type { ExtensionContext } from "@ableton-extensions/sdk";
import type { LiveInteractionContext } from "../live/context.js";
import { createLiveSetGuard } from "../live/set-identity.js";
import { loadAgentSettings } from "../storage/settings.js";
import { createSystemBrowserOpener } from "../runtime/system-browser.js";
import { projectKeyForContext } from "./context/session-context.js";
import { createAgentRuntime, runAgentFlow, type AgentFlowDependencies, type AgentRuntime } from "./agent-flow.js";
import { interactionContextForScope, setInteractionContext } from "../live/context.js";
import { listSessions } from "../storage/sessions.js";
import type { Vst3BrokerDescriptor } from "../runtime/vst3-discovery.js";

type Api = ExtensionContext<"1.0.0">;
type WindowDependencies = AgentFlowDependencies & {
  openBrowser?: (url: string) => Promise<void>;
  publishVst3?: (broker: Vst3BrokerDescriptor) => Promise<{ clear(): Promise<void> }>;
};

/** One activation owns one browser runtime; invocation changes are serialized. */
export function createWindowHostController(context: Api, dependencies: WindowDependencies = {}) {
  const openBrowser = dependencies.openBrowser ?? createSystemBrowserOpener({ allowLoopbackHttp: true });
  let browser: { key: string; projectKey: string; runtime: AgentRuntime } | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let vst3Lease: { clear(): Promise<void> } | undefined;
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  };
  const closeBrowser = async () => {
    const previous = browser;
    browser = undefined;
    const lease = vst3Lease;
    vst3Lease = undefined;
    try { await lease?.clear(); } finally { await previous?.runtime.close(); }
  };
  const publishVst3 = async (runtime: AgentRuntime) => {
    if (!dependencies.publishVst3) return;
    if (!runtime.vst3Broker) throw new Error("The VST3 broker is unavailable.");
    vst3Lease = await dependencies.publishVst3(runtime.vst3Broker);
  };
  return {
    async start(): Promise<void> {
      if (!dependencies.publishVst3) return;
      await serialize(async () => {
        const assertLiveSetCurrent = createLiveSetGuard(context);
        const projectKey = projectKeyForContext(context);
        if (browser?.projectKey === projectKey) return;
        if (browser?.runtime.busy) throw new Error("Live Smith is still working in the previous Set.");
        if (browser) await closeBrowser();
        assertLiveSetCurrent();
        const interaction = setInteractionContext(context);
        const runtime = await createAgentRuntime(context, interaction, dependencies, "browser");
        try {
          await publishVst3(runtime);
          assertLiveSetCurrent();
          browser = { key: JSON.stringify([projectKey, interaction.scope.kind, interaction.scope.identity, null]), projectKey, runtime };
        } catch (error) {
          await vst3Lease?.clear();
          vst3Lease = undefined;
          await runtime.close();
          throw error;
        }
      });
    },
    async openSession(sessionId: string): Promise<void> {
      await serialize(async () => {
        const projectKey = projectKeyForContext(context);
        const session = (await listSessions(context.environment.storageDirectory, projectKey)).find(entry => entry.id === sessionId && !entry.archivedAt);
        if (!session) throw new Error("Open the Live Set containing this Session to review its operation.");
        if (browser && browser.projectKey !== projectKey) {
          if (browser.runtime.busy) throw new Error("Live Smith is still working in the previous Set.");
          await closeBrowser();
        }
        if (!browser) {
          const interaction = interactionContextForScope(context, session.scope) ?? {
            scope: session.scope, target: {}, summary: "External tools are bound to this Live Set. Observe explicit targets before editing.",
            presentation: { origin: "object" as const, objectKind: "other" as const, title: session.title || "Live Set", details: [] },
          };
          browser = { key: `external:${sessionId}`, projectKey,
            runtime: await createAgentRuntime(context, interaction, { ...dependencies, initialSessionId: sessionId }, "browser") };
          try { await publishVst3(browser.runtime); }
          catch (error) { await closeBrowser(); throw error; }
        } else await browser.runtime.reopen(sessionId);
        await openBrowser(browser.runtime.url);
      });
    },
    async open(interaction: LiveInteractionContext): Promise<void> {
      const assertLiveSetCurrent = createLiveSetGuard(context);
      const projectKey = projectKeyForContext(context);
      // A modal owns its own lifetime, independent of a browser's admitted work.
      const mode = (await loadAgentSettings(context.environment.storageDirectory)).interfaceMode;
      if (mode === "modal" && !dependencies.publishVst3) {
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
        if (browser && browser.projectKey !== projectKey) {
          if (browser.runtime.busy) throw new Error("Live Smith is still working in the previous Set.");
          await closeBrowser();
        }
        let adopted = false;
        if (browser && browser.key !== key) {
          if (browser.runtime.busy) throw new Error("Live Smith is still working in the browser. Return to that tab and finish or Stop the current operation before asking about another selection.");
          if (dependencies.publishVst3) {
            browser.runtime.adopt(interaction);
            browser.key = key;
            adopted = true;
          } else await closeBrowser();
        }
        assertLiveSetCurrent();
        const reused = browser !== undefined;
        if (!browser) browser = { key, projectKey, runtime: await createAgentRuntime(context, interaction, dependencies, "browser") };
        if (reused && !adopted) await browser.runtime.reopen();
        try {
          if (!reused) await publishVst3(browser.runtime);
          if (!browser.runtime.vst3ViewConnected) await openBrowser(browser.runtime.url);
        }
        catch {
          if (!reused) await closeBrowser();
          throw new Error("Live Smith could not open the system browser. Check your default browser and try Ask Live Smith again.");
        }
      });
    },
    close: () => serialize(closeBrowser),
  };
}
