import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { uiCatalogs, serializeUiI18nData } from "../../../src/ui/i18n/messages.js";
import { templateMessages } from "../../../src/ui/i18n/template-messages.js";
import { timelineMessages } from "../../../src/ui/i18n/timeline-messages.js";
import { profileMessages } from "../../../src/ui/i18n/profile-messages.js";
import { mainMessages } from "../../../src/ui/i18n/main-messages.js";
import { audioToolHelp, audioToolHelpMessages } from "../../../src/ui/i18n/audio-tool-help.js";
import { builtInAudioToolNames } from "../../../src/plugins/builtins/audio-toolsets.js";
import { audioMessages } from "../../../src/ui/i18n/audio-messages.js";
import { connectionsMessages } from "../../../src/ui/i18n/connections-messages.js";
import { liveToolHelp, toolMessages } from "../../../src/ui/i18n/tool-messages.js";
import { AUDIO_OUTPUT_LABELS } from "../../../src/audio-services/contracts.js";
import { actionMessages } from "../../../src/ui/i18n/action-messages.js";
import { sessionNativeTools } from "../../../src/app/tools/tool-runtime.js";
import { BUILT_IN_INTEGRATION_CONNECTION_DESCRIPTORS } from "../../../src/plugins/builtins/index.js";
import { UI_LANGUAGES, DEFAULT_UI_LOCALE } from "../../../src/i18n/languages.js";
const translatedLocales = UI_LANGUAGES.map(language => language.id).filter(id => id !== DEFAULT_UI_LOCALE);

test("message catalogs agree on shared messages and preserve interpolation fields", () => {
  const seen = new Map<string,string>();
  const fields = (text: string) => [...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]))].sort();
  for (const catalog of [templateMessages, timelineMessages, profileMessages, mainMessages, actionMessages, audioMessages, audioToolHelpMessages, connectionsMessages, toolMessages]) {
    for (const [source, translated] of Object.entries(catalog)) {
      assert.ok(translated.trim(), source);
      if (seen.has(source)) assert.equal(translated, seen.get(source), source);
      seen.set(source, translated);
      assert.deepEqual(fields(translated), fields(source), source);
    }
  }
  for (const [locale, catalog] of Object.entries(uiCatalogs)) {
    for (const [source, translated] of Object.entries(catalog)) {
      assert.ok(translated.trim(), `${locale}: ${source}`);
      assert.deepEqual(fields(translated), fields(source), `${locale}: ${source}`);
    }
  }
});

test("explicit client messages and static template markers all have translations", () => {
  const missing = new Set<string>();
  function requireTranslation(source: string, origin: string) {
    for (const locale of translatedLocales) {
      if (!Object.hasOwn(uiCatalogs[locale], source)) missing.add(`${locale} ${origin} — ${source}`);
    }
  }
  function visitMessage(expression: ts.Expression, origin: string) {
    if (ts.isStringLiteralLike(expression)) requireTranslation(expression.text, origin);
    else if (ts.isParenthesizedExpression(expression)) visitMessage(expression.expression, origin);
    else if (ts.isConditionalExpression(expression)) {
      visitMessage(expression.whenTrue, origin);
      visitMessage(expression.whenFalse, origin);
    }
  }
  const files = readdirSync(new URL('../../../src/ui/client/', import.meta.url), { recursive: true })
    .filter((name): name is string => typeof name === 'string' && (name.endsWith('.script.html') || name.endsWith('.ts'))).map(name => '../../../src/ui/client/' + name);
  files.push('../../../src/ui/action-diff.ts');
  files.push('../../../src/skills/format.ts', '../../../src/skills/plugin-package.ts', '../../../src/model/oauth/google.ts');
  files.push('../../../src/app/plugins/plugin-lifecycle.ts', '../../../src/app/model/dialog-model-state.ts');
  files.push('../../../src/app/audio/audio-generation.ts', '../../../src/app/audio/audio-processing.ts', '../../../src/app/audio/audio-job-runtime.ts', '../../../src/app/audio/suno/suno-human-verification.ts', '../../../src/app/agent-flow.ts');
  files.push('../../../src/live/device-parameters.ts', '../../../src/app/parameters/parameter-artifacts.ts', '../../../src/app/parameters/parameter-application.ts', '../../../src/storage/device-parameter-artifacts.ts');
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ['t','m','message','uiMessage','window.LiveSmithI18n.t','window.LiveSmithI18n.message','i18n.message'].includes(node.expression.getText(ast))) {
        const arg = node.arguments[0];
        if (arg) visitMessage(arg, file);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  for (const file of ['chat-dialog.html','result-dialog.html']) {
    const dom = new JSDOM(readFileSync(new URL('../../../src/ui/templates/'+file, import.meta.url), 'utf8'));
    try {
      for (const node of dom.window.document.querySelectorAll('*')) {
        for (const attr of node.attributes) if (attr.name === 'data-i18n' || attr.name.startsWith('data-i18n-')) {
          requireTranslation(attr.value, file);
        }
      }
    } finally { dom.window.close(); }
  }
  for (const label of Object.values(AUDIO_OUTPUT_LABELS)) {
    requireTranslation(label, "audio output");
  }
  for (const descriptor of Object.values(BUILT_IN_INTEGRATION_CONNECTION_DESCRIPTORS)) {
    requireTranslation(descriptor.label, descriptor.pluginId);
  }
  for (const name of new Set(Object.values(builtInAudioToolNames()))) {
    const help = audioToolHelp[name];
    assert.ok(help, name);
    requireTranslation(help[0], name);
  }
  for (const { function: { name } } of sessionNativeTools(true, true)) {
    const help = liveToolHelp[name];
    assert.ok(help, name);
    requireTranslation(help[0], name);
  }
  assert.deepEqual([...missing], []);
});

test("runtime formats bound messages repeatedly without treating values as translation keys", () => {
  const script = readFileSync(new URL('../../../src/ui/client/i18n.script.html', import.meta.url), 'utf8').replace('__UI_I18N__', serializeUiI18nData());
  const dom = new JSDOM(`<script>${script}</script>`, {runScripts:'dangerously'});
  try {
    const i18n = (dom.window as unknown as {LiveSmithI18n: {configure(value:string):void;t(source:string,values?:Record<string,string|number>):string;message(source:string,values?:Record<string,string|number>):()=>string}}).LiveSmithI18n;
    const title = i18n.message('Delete installed Skill {skillId}? This cannot be undone.', {skillId:'Delete <b>Agent</b>'});
    i18n.configure('zh-CN');
    assert.ok(title().includes('Delete <b>Agent</b>'));
    assert.notEqual(title(), 'Delete installed Skill Delete <b>Agent</b>? This cannot be undone.');
    i18n.configure('en');
    assert.equal(title(),'Delete installed Skill Delete <b>Agent</b>? This cannot be undone.');
    assert.equal(i18n.t('Unregistered technical error.'),'Unregistered technical error.');
  } finally {dom.window.close();}
});
