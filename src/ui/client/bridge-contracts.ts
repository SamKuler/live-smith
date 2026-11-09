import { hashFileContent } from "./file-hash.js";
import { createSessionHistory } from "./session-history.js";
import { createStorageManagement } from "./storage-management.js";
import { installDisclosureMotion } from "./disclosure-motion.js";
import { setPaneOpen } from "./pane-motion.js";
import { isImeKeyboardEvent } from "./ime-keyboard.js";
import { createInlineHelp } from "./inline-help.js";
import { createArtifactSummary } from "./artifact-summary.js";
import { createActionPreview } from "./action-preview.js";
import { sessionInspectorTabs, sessionShortcutIds } from "../../model/session-tabs.js";
import { createCreativeBriefEditor } from "./creative-brief-editor.js";
import { createAudioConnectionEditor } from "./audio-connection-editor.js";
import { createConnectionState } from "./connection-state.js";
import { createWireValidators } from "./wire-contracts.js";
import { createSessionSearch } from "./session-search.js";
import { createSessionAttachments } from "./session-attachments.js";
import { sessionActivityAt } from "../../app/session/session-activity.js";
import { createActionDetails } from "./action-details.js";

const browser = window as typeof window & {
  LiveSmithFactories?: { hashFileContent?: typeof hashFileContent; createSessionHistory?: typeof createSessionHistory; isImeKeyboardEvent?: typeof isImeKeyboardEvent; setPaneOpen?: typeof setPaneOpen; installDisclosureMotion?: typeof installDisclosureMotion; createInlineHelp?: typeof createInlineHelp; createArtifactSummary?: typeof createArtifactSummary; createActionDetails?: typeof createActionDetails; sessionActivityAt?: typeof sessionActivityAt; createSessionSearch?: typeof createSessionSearch; createSessionAttachments?: typeof createSessionAttachments; createActionPreview?: typeof createActionPreview; sessionInspectorTabs?: typeof sessionInspectorTabs; sessionShortcutIds?: typeof sessionShortcutIds; createCreativeBriefEditor?: typeof createCreativeBriefEditor; createAudioConnectionEditor?: typeof createAudioConnectionEditor; createWireValidators?: typeof createWireValidators; createConnectionState?: typeof createConnectionState };
};
browser.LiveSmithFactories ??= {};
browser.LiveSmithFactories.setPaneOpen = setPaneOpen;
browser.LiveSmithFactories.isImeKeyboardEvent = isImeKeyboardEvent;
browser.LiveSmithFactories.installDisclosureMotion = installDisclosureMotion;
browser.LiveSmithFactories.createInlineHelp = createInlineHelp;
browser.LiveSmithFactories.createArtifactSummary = createArtifactSummary;
browser.LiveSmithFactories.createSessionSearch = createSessionSearch;
browser.LiveSmithFactories.createSessionAttachments = createSessionAttachments;
browser.LiveSmithFactories.sessionActivityAt = sessionActivityAt;
browser.LiveSmithFactories.createActionDetails = createActionDetails;
browser.LiveSmithFactories.createActionPreview = createActionPreview;
browser.LiveSmithFactories.createCreativeBriefEditor = createCreativeBriefEditor;
browser.LiveSmithFactories.createWireValidators = createWireValidators;
browser.LiveSmithFactories.createConnectionState = createConnectionState;
browser.LiveSmithFactories.createAudioConnectionEditor = createAudioConnectionEditor;

browser.LiveSmithFactories.sessionInspectorTabs = sessionInspectorTabs;
browser.LiveSmithFactories.sessionShortcutIds = sessionShortcutIds;

browser.LiveSmithFactories.createSessionHistory = createSessionHistory;

browser.LiveSmithFactories.hashFileContent = hashFileContent;
browser.LiveSmithFactories.createStorageManagement = createStorageManagement;
