import { isSessionTabs } from "../../model/session-tabs.js";
import * as primitives from "./wire-contracts/primitives.js";
import * as models from "./wire-contracts/models.js";
import * as session from "./wire-contracts/session.js";
import { createPluginValidators } from "./wire-contracts/plugins.js";
import { createStateValidators } from "./wire-contracts/state.js";
import { isUiLanguage } from "../../i18n/languages.js";
import { isEditScopes as isWireEditScopes } from "../../agent/edit-scopes.js";

export function createWireValidators(dependencies: Parameters<typeof createPluginValidators>[0]) {
  const plugins = createPluginValidators(dependencies);
  return { ...primitives, ...models, ...session, ...plugins, ...createStateValidators(plugins), isUiLanguage, isSessionTabs, isWireEditScopes };
}
