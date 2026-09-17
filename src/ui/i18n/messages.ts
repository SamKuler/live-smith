import { templateMessages } from "./template-messages.js";
import { timelineMessages } from "./timeline-messages.js";
import { profileMessages } from "./profile-messages.js";
import { mainMessages } from "./main-messages.js";
import { actionMessages } from "./action-messages.js";
import { audioMessages } from "./audio-messages.js";
import { DEFAULT_UI_LOCALE, UI_LANGUAGES, type UiLocale } from "../../i18n/languages.js";

const zhCNMessages: Readonly<Record<string, string>> = Object.freeze({
  ...templateMessages,
  ...timelineMessages,
  ...profileMessages,
  ...mainMessages,
  ...actionMessages,
  ...audioMessages,
});

export const uiCatalogs: Readonly<Record<UiLocale, Readonly<Record<string, string>>>> = {
  en: {},
  "zh-CN": zhCNMessages,
};

export function serializeUiI18nData(): string {
  return JSON.stringify({ defaultLocale: DEFAULT_UI_LOCALE, languages: UI_LANGUAGES, catalogs: uiCatalogs })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
