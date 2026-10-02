import { createCreativeBriefEditor } from "./creative-brief-editor.js";
import { createAudioConnectionEditor } from "./audio-connection-editor.js";
import { createConnectionState } from "./connection-state.js";
import { createWireValidators } from "./wire-contracts.js";

const browser = window as typeof window & {
  LiveSmithFactories?: { createCreativeBriefEditor?: typeof createCreativeBriefEditor; createAudioConnectionEditor?: typeof createAudioConnectionEditor; createWireValidators?: typeof createWireValidators; createConnectionState?: typeof createConnectionState };
};
browser.LiveSmithFactories ??= {};
browser.LiveSmithFactories.createCreativeBriefEditor = createCreativeBriefEditor;
browser.LiveSmithFactories.createWireValidators = createWireValidators;
browser.LiveSmithFactories.createConnectionState = createConnectionState;
browser.LiveSmithFactories.createAudioConnectionEditor = createAudioConnectionEditor;
