import { createInlineHelp } from "./inline-help.js";
import { createArtifactSummary } from "./artifact-summary.js";
import { createActionPreview } from "./action-preview.js";
import { sessionInspectorTabs, sessionShortcutIds } from "../../model/session-tabs.js";
import { createCreativeBriefEditor } from "./creative-brief-editor.js";
import { createMidiContinuation } from "./midi-continuation.js";
import { createAudioConnectionEditor } from "./audio-connection-editor.js";
import { createConnectionState } from "./connection-state.js";
import { createWireValidators } from "./wire-contracts.js";
import { createSessionSearch } from "./session-search.js";
import { sessionActivityAt } from "../../app/session/session-activity.js";
import { createActionDetails } from "./action-details.js";

const browser = window as typeof window & {
  LiveSmithFactories?: { createInlineHelp?: typeof createInlineHelp; createArtifactSummary?: typeof createArtifactSummary; createActionDetails?: typeof createActionDetails; sessionActivityAt?: typeof sessionActivityAt; createSessionSearch?: typeof createSessionSearch; createActionPreview?: typeof createActionPreview; sessionInspectorTabs?: typeof sessionInspectorTabs; sessionShortcutIds?: typeof sessionShortcutIds; createMidiContinuation?: typeof createMidiContinuation; createCreativeBriefEditor?: typeof createCreativeBriefEditor; createAudioConnectionEditor?: typeof createAudioConnectionEditor; createWireValidators?: typeof createWireValidators; createConnectionState?: typeof createConnectionState };
};
browser.LiveSmithFactories ??= {};
browser.LiveSmithFactories.createInlineHelp = createInlineHelp;
browser.LiveSmithFactories.createArtifactSummary = createArtifactSummary;
browser.LiveSmithFactories.createSessionSearch = createSessionSearch;
browser.LiveSmithFactories.sessionActivityAt = sessionActivityAt;
browser.LiveSmithFactories.createActionDetails = createActionDetails;
browser.LiveSmithFactories.createActionPreview = createActionPreview;
browser.LiveSmithFactories.createCreativeBriefEditor = createCreativeBriefEditor;
browser.LiveSmithFactories.createMidiContinuation = createMidiContinuation;
browser.LiveSmithFactories.createWireValidators = createWireValidators;
browser.LiveSmithFactories.createConnectionState = createConnectionState;
browser.LiveSmithFactories.createAudioConnectionEditor = createAudioConnectionEditor;

browser.LiveSmithFactories.sessionInspectorTabs = sessionInspectorTabs;
browser.LiveSmithFactories.sessionShortcutIds = sessionShortcutIds;
