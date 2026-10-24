import { createWindowHostController } from "./app/window-hosts.js";
import {
  initialize,
  type ActivationContext,
  type ArrangementSelection,
  type ClipSlotSelection,
  type ExtensionContext,
  type Handle,
} from "@ableton-extensions/sdk";

import { showAgentError } from "./app/agent-flow.js";
import { LiveMutationQueue } from "./app/live-mutation-queue.js";
import {
  arrangementSelectionInteractionContext,
  clipSlotSelectionInteractionContext,
  objectInteractionContext,
} from "./live/context.js";
import { openOAuthAuthorizationUrl } from "./runtime/oauth-browser.js";
import { createMcpService } from "./app/mcp/service.js";
import { createVst3DiscoveryPublisher } from "./runtime/vst3-discovery.js";
import { error as logError } from "node:console";

type Api = ExtensionContext<"1.0.0">;

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");
  const liveMutationQueue = new LiveMutationQueue();
  const storageDirectory = context.environment.storageDirectory;
  const mcpService = storageDirectory ? createMcpService({ context, storageDirectory, liveMutationQueue,
    openSession: sessionId => windowHost.openSession(sessionId) }) : undefined;
  const publishVst3 = createVst3DiscoveryPublisher(storageDirectory);
  const windowHost = createWindowHostController(context, { liveMutationQueue, openOAuthAuthorizationUrl,
    ...(publishVst3 ? { publishVst3 } : {}),
    ...(mcpService ? { mcpService } : {}) });
  void windowHost.start().catch(() => logError("Live Smith VST3 bridge startup failed."));
  if (mcpService) void mcpService.start().catch(error => showAgentError(context, error));

  context.commands.registerCommand("live-smith.ask-object", (arg: unknown) => {
    void askAboutObject(context, arg as Handle, windowHost).catch((error) =>
      showAgentError(context, error),
    );
  });

  context.commands.registerCommand(
    "live-smith.ask-arrangement-selection",
    (arg: unknown) => {
      void askAboutArrangementSelection(
        context,
        arg as ArrangementSelection,
        windowHost,
      ).catch(
        (error) => showAgentError(context, error),
      );
    },
  );

  context.commands.registerCommand(
    "live-smith.ask-clip-slot-selection",
    (arg: unknown) => {
      void askAboutClipSlotSelection(
        context,
        arg as ClipSlotSelection,
        windowHost,
      ).catch(
        (error) => showAgentError(context, error),
      );
    },
  );

  for (const scope of [
    "AudioClip",
    "MidiClip",
    "AudioTrack",
    "MidiTrack",
    "ClipSlot",
    "Scene",
    "Simpler",
    "Sample",
    "DrumRack",
  ] as const) {
    void context.ui.registerContextMenuAction(
      scope,
      "Ask Live Smith",
      "live-smith.ask-object",
    );
  }

  void context.ui.registerContextMenuAction(
    "AudioTrack.ArrangementSelection",
    "Ask Live Smith about selection",
    "live-smith.ask-arrangement-selection",
  );
  void context.ui.registerContextMenuAction(
    "MidiTrack.ArrangementSelection",
    "Ask Live Smith about selection",
    "live-smith.ask-arrangement-selection",
  );
  void context.ui.registerContextMenuAction(
    "ClipSlotSelection",
    "Ask Live Smith about selected slots",
    "live-smith.ask-clip-slot-selection",
  );
}

async function askAboutObject(
  context: Api,
  handle: Handle,
  windowHost: ReturnType<typeof createWindowHostController>,
): Promise<void> {
  await windowHost.open(
    objectInteractionContext(context, handle),
  );
}

async function askAboutArrangementSelection(
  context: Api,
  selection: ArrangementSelection,
  windowHost: ReturnType<typeof createWindowHostController>,
): Promise<void> {
  await windowHost.open(
    arrangementSelectionInteractionContext(context, selection),
  );
}

async function askAboutClipSlotSelection(
  context: Api,
  selection: ClipSlotSelection,
  windowHost: ReturnType<typeof createWindowHostController>,
): Promise<void> {
  await windowHost.open(
    clipSlotSelectionInteractionContext(context, selection),
  );
}
