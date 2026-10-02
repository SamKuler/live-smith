import { createCreativeBriefEditor } from "./creative-brief-editor.js";
import { createMidiContinuation } from "./midi-continuation.js";
import { createAudioConnectionEditor } from "./audio-connection-editor.js";
import { createConnectionState } from "./connection-state.js";
import { createWireValidators } from "./wire-contracts.js";

const browser = window as typeof window & {
  LiveSmithFactories?: { createMidiContinuation?: typeof createMidiContinuation; createCreativeBriefEditor?: typeof createCreativeBriefEditor; createAudioConnectionEditor?: typeof createAudioConnectionEditor; createWireValidators?: typeof createWireValidators; createConnectionState?: typeof createConnectionState };
};
browser.LiveSmithFactories ??= {};
browser.LiveSmithFactories.createCreativeBriefEditor = createCreativeBriefEditor;
browser.LiveSmithFactories.createMidiContinuation = createMidiContinuation;
browser.LiveSmithFactories.createWireValidators = createWireValidators;
browser.LiveSmithFactories.createConnectionState = createConnectionState;
browser.LiveSmithFactories.createAudioConnectionEditor = createAudioConnectionEditor;
