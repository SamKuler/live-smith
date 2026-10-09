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
import { audioMessages } from "../../../src/ui/i18n/audio-messages.js";
import { connectionsMessages } from "../../../src/ui/i18n/connections-messages.js";
import { AUDIO_OUTPUT_LABELS } from "../../../src/audio-services/contracts.js";
import { actionMessages } from "../../../src/ui/i18n/action-messages.js";
import { UI_LANGUAGES, DEFAULT_UI_LOCALE } from "../../../src/i18n/languages.js";
const translatedLocales = UI_LANGUAGES.map(language => language.id).filter(id => id !== DEFAULT_UI_LOCALE);

test("message catalogs agree on shared messages and preserve interpolation fields", () => {
  const seen = new Map<string,string>();
  const fields = (text: string) => [...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]))].sort();
  for (const catalog of [templateMessages, timelineMessages, profileMessages, mainMessages, actionMessages, audioMessages, connectionsMessages]) {
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
  const files = readdirSync(new URL('../../../src/ui/client/', import.meta.url), { recursive: true })
    .filter((name): name is string => typeof name === 'string' && (name.endsWith('.script.html') || name.endsWith('.ts'))).map(name => '../../../src/ui/client/' + name);
  files.push('../../../src/ui/action-diff.ts');
  files.push('../../../src/app/audio/audio-generation.ts', '../../../src/app/audio/audio-processing.ts', '../../../src/app/audio/audio-job-runtime.ts', '../../../src/app/audio/suno/suno-human-verification.ts', '../../../src/app/agent-flow.ts');
  files.push('../../../src/live/device-parameters.ts', '../../../src/app/parameters/parameter-artifacts.ts', '../../../src/app/parameters/parameter-application.ts', '../../../src/storage/device-parameter-artifacts.ts');
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ['t','m','message','uiMessage','window.LiveSmithI18n.t','window.LiveSmithI18n.message','i18n.message'].includes(node.expression.getText(ast))) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) for (const locale of translatedLocales) assert.ok(Object.hasOwn(uiCatalogs[locale], arg.text), `${file}: ${arg.text}`);
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
          for (const locale of translatedLocales) assert.ok(Object.hasOwn(uiCatalogs[locale],attr.value), `${file}: ${attr.value}`);
        }
      }
    } finally { dom.window.close(); }
  }
  for (const label of Object.values(AUDIO_OUTPUT_LABELS)) {
    for (const locale of translatedLocales) assert.ok(Object.hasOwn(uiCatalogs[locale], label), label);
  }
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
