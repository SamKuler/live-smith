import * as fs from "node:fs";
import { buildSunoVerificationScript } from "../src/ui/native/suno-verification.js";

const clientFragments = [
  "host-adapter",
  "i18n",
  "profile-editor",
  "attachments",
  "composer-input",
  "skill-manager",
  "bridge-client",
  "session-timeline",
  "action-preview",
  "bootstrap",
] as const;

const source = clientFragments
  .map((name) => fs.readFileSync(
    new URL(`../src/ui/client/${name}.script.html`, import.meta.url),
    "utf8",
  ))
  .join("\n");

new Function(source);
for (const version of [1, 2] as const) for (const locale of ["en", "zh-CN", "system"]) {
  new Function(buildSunoVerificationScript(version, locale, ""));
}
