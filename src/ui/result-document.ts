import type { UiLanguage } from "../i18n/languages.js";
import type { UiMessage } from "../i18n/ui-message.js";
import { serializeUiI18nData } from "./i18n/messages.js";

export function composeResultDocument(
  template: string,
  body: UiMessage,
  uiLanguage: UiLanguage,
  scripts: { hostAdapter: string; i18n: string },
  styles: string,
): string {
  const values: Record<string, string> = {
    "__RESULT_DATA__": JSON.stringify({ body, settings: { uiLanguage } }).replaceAll("<", "\\u003c"),
    "__HOST_ADAPTER_SCRIPT__": scripts.hostAdapter,
    "__I18N_SCRIPT__": scripts.i18n.replace("__UI_I18N__", () => serializeUiI18nData()),
    "/*__RESULT_STYLES__*/": styles,
  };
  return template.replace(/__RESULT_DATA__|__HOST_ADAPTER_SCRIPT__|__I18N_SCRIPT__|\/\*__RESULT_STYLES__\*\//gu, token => values[token]!);
}
