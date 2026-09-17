import { uiMessage, type UiMessageDescriptor, type UiMessageValues } from "../i18n/ui-message.js";
import type { audioMessages } from "../ui/i18n/audio-messages.js";
import { AUDIO_OUTPUT_LABELS, type AudioAsset } from "../audio-services/contracts.js";

export const audioMessage: (source: keyof typeof audioMessages, values?: UiMessageValues) => UiMessageDescriptor = uiMessage;
export const audioRoleMessage = (role: Exclude<AudioAsset["role"], "source">): UiMessageDescriptor => uiMessage(AUDIO_OUTPUT_LABELS[role]);
