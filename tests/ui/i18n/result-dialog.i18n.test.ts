import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

import { uiMessage } from "../../../src/i18n/ui-message.js";
import { composeResultDocument } from "../../../src/ui/result-document.js";

const read = (path: string) => readFileSync(new URL("../../../src/ui/" + path, import.meta.url), "utf8");

test("an error dialog uses the saved UI language over the system and renders raw diagnostics as text", async () => {
  const scripts = { hostAdapter: read("client/host-adapter.script.html"), i18n: read("client/i18n.script.html") };
  const payload = '</script><script>document.body.dataset.injected="yes"</script>';
  for (const [message, expected] of [
    [uiMessage("Invalid SKILL.md at line {line}: {reason}.", { line: 1, reason: uiMessage("the opening delimiter is missing") }),
      "SKILL.md 第 1 行格式有误：缺少开头的分隔符。"],
    [payload, payload],
  ] as const) {
    const dom = new JSDOM(composeResultDocument(read("templates/result-dialog.html"), message, "zh-CN", scripts, ""), {
      runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window.navigator, "languages", { value: ["en-US"] });
      },
    });
    try {
      await new Promise<void>(resolve => dom.window.addEventListener("DOMContentLoaded", () => resolve(), { once: true }));
      const document = dom.window.document;
      assert.equal(document.documentElement.lang, "zh-CN");
      assert.equal(document.querySelector("h1")?.textContent, "Live Smith 错误");
      assert.equal(document.querySelector("#resultBody")?.textContent, expected);
      assert.equal(document.querySelector("button")?.textContent, "关闭");
      assert.equal(document.body.dataset.injected, undefined);
    } finally { dom.window.close(); }
  }
});
