import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  MAX_SKILL_FILE_BYTES,
  SkillFormatError,
  parseSkillMarkdown,
  summarizeSkill,
} from "./format.js";

const canonicalSkill = [
  "---",
  "name: mixing-review",
  "description: Review a mix systematically before making Live edits.",
  "---",
  "# Mixing review",
  "",
  "Inspect routing and levels first. Explain evidence before proposing edits.",
  "",
].join("\n");

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

test("SKILL.md format parses the canonical file and returns a body-free summary", () => {
  const skill = parseSkillMarkdown(bytes(canonicalSkill));

  assert.deepEqual(skill, {
    id: "mixing-review",
    description: "Review a mix systematically before making Live edits.",
    body: [
      "# Mixing review",
      "",
      "Inspect routing and levels first. Explain evidence before proposing edits.",
      "",
    ].join("\n"),
  });
  assert.deepEqual(summarizeSkill(skill), {
    id: "mixing-review",
    description: "Review a mix systematically before making Live edits.",
  });
  assert.equal("body" in summarizeSkill(skill), false);
});

test("SKILL.md format normalizes CRLF while preserving Markdown body structure", () => {
  const skill = parseSkillMarkdown(bytes(
    canonicalSkill
      .replace("name: mixing-review", "name:\t mixing-review \t")
      .replace(
        "description: Review",
        "description:\t Review",
      )
      .replaceAll("edits.", "edits. \t")
      .replaceAll("\n", "\r\n"),
  ));

  assert.equal(skill.id, "mixing-review");
  assert.equal(
    skill.description,
    "Review a mix systematically before making Live edits.",
  );
  assert.equal(
    skill.body,
    "# Mixing review\n\nInspect routing and levels first. Explain evidence before proposing edits. \t\n",
  );
});

test("skill frontmatter delimiters must be exact whole lines around two fields", () => {
  const invalid = [
    canonicalSkill.replace(/^---$/m, " ---"),
    canonicalSkill.replace(/^---$/m, "----"),
    canonicalSkill.replace("\n---\n# Mixing", "\n--- trailing\n# Mixing"),
    canonicalSkill.replace("\n---\n# Mixing", "\n# Mixing"),
    canonicalSkill.replace(
      "description: Review",
      "extra: field\ndescription: Review",
    ),
  ];

  for (const value of invalid) {
    assert.throws(
      () => parseSkillMarkdown(bytes(value)),
      (error: unknown) => error instanceof SkillFormatError,
    );
  }
});

test("SKILL.md format allows Markdown horizontal rules in the body", () => {
  const skill = parseSkillMarkdown(bytes(canonicalSkill.replace(
    "# Mixing review",
    "# Mixing review\n\n---",
  )));
  assert.match(skill.body, /\n---\n/);
});

test("skill UTF-8 rejects empty, invalid, oversized, and byte-order-mark input", () => {
  assert.throws(() => parseSkillMarkdown(new Uint8Array()), SkillFormatError);
  assert.throws(
    () => parseSkillMarkdown(new Uint8Array([0xc3, 0x28])),
    SkillFormatError,
  );
  assert.throws(
    () => parseSkillMarkdown(new Uint8Array([0xc0, 0xaf])),
    SkillFormatError,
  );
  assert.throws(
    () => parseSkillMarkdown(new Uint8Array([0xed, 0xa0, 0x80])),
    SkillFormatError,
  );
  assert.throws(
    () => parseSkillMarkdown(new Uint8Array(MAX_SKILL_FILE_BYTES + 1)),
    SkillFormatError,
  );
  assert.throws(
    () => parseSkillMarkdown(bytes(canonicalSkill.replace("# Mixing", "\ufeff# Mixing"))),
    SkillFormatError,
  );
  assert.throws(
    () => parseSkillMarkdown(bytes(canonicalSkill.replace("# Mixing", "\u202e# Mixing"))),
    SkillFormatError,
  );
  assert.throws(
    () => parseSkillMarkdown(bytes(canonicalSkill.replace("# Mixing", "\u2066# Mixing"))),
    SkillFormatError,
  );
  assert.throws(
    () => parseSkillMarkdown(bytes(canonicalSkill.replace("# Mixing review", "# Mixing\rreview"))),
    SkillFormatError,
  );
});

test("skill frontmatter rejects duplicate, unknown, mis-cased, and missing keys", () => {
  const invalid = [
    canonicalSkill.replace(
      "description: Review",
      "name: duplicate\ndescription: Review",
    ),
    canonicalSkill.replace(
      "description: Review",
      "author: someone\ndescription: Review",
    ),
    canonicalSkill.replace("name: mixing-review", "Name: mixing-review"),
    canonicalSkill.replace(
      "description: Review a mix systematically before making Live edits.\n",
      "",
    ),
    canonicalSkill.replace("name: mixing-review\n", ""),
  ];

  for (const value of invalid) {
    assert.throws(() => parseSkillMarkdown(bytes(value)), SkillFormatError);
  }
});

test("skill frontmatter rejects unsafe IDs and out-of-range descriptions", () => {
  const invalidIds = [
    "Mixing-review",
    "mixing_review",
    "-mixing",
    "mixing-",
    "mixing--review",
    "mixing review",
    "a".repeat(65),
  ];
  for (const id of invalidIds) {
    assert.throws(
      () => parseSkillMarkdown(bytes(canonicalSkill.replace("mixing-review", id))),
      SkillFormatError,
    );
  }

  assert.throws(
    () => parseSkillMarkdown(bytes(canonicalSkill.replace(
      "Review a mix systematically before making Live edits.",
      "🎛".repeat(241),
    ))),
    SkillFormatError,
  );
  assert.doesNotThrow(() => parseSkillMarkdown(bytes(canonicalSkill.replace(
    "Review a mix systematically before making Live edits.",
    "🎛".repeat(240),
  ))));
});

test("skill frontmatter rejects YAML scalar syntax instead of interpreting it", () => {
  for (const value of [
    "| block",
    "> folded",
    "&anchor",
    "*alias",
    "!tag",
    "[list]",
    "{object}",
    "\"quoted\\nvalue\"",
    "'quoted value'",
    "# comment",
    "- list item",
    "? mapping key",
    ": mapping value",
    "visual\u0085newline",
    "visual\u2028newline",
    "visual\u2029newline",
  ]) {
    assert.throws(
      () => parseSkillMarkdown(bytes(canonicalSkill.replace(
        "Review a mix systematically before making Live edits.",
        value,
      ))),
      SkillFormatError,
    );
  }
});

test("SKILL.md format preserves multiple terminal body newlines", () => {
  const skill = parseSkillMarkdown(bytes(`${canonicalSkill}\n\n`));
  assert.equal(skill.body.endsWith("\n\n\n"), true);
});

test("SKILL.md format preserves Unicode line separators in the inert body", () => {
  const body = "# Guidance\n\nbody\u0085next\u2028next\u2029next\n";
  const skill = parseSkillMarkdown(bytes(canonicalSkill.replace(
    /# Mixing review[\s\S]*$/,
    body,
  )));
  assert.equal(skill.body, body);
});

test("SKILL.md format rejects empty bodies and forbidden C0 controls", () => {
  assert.throws(
    () => parseSkillMarkdown(bytes(canonicalSkill.replace(
      "# Mixing review\n\nInspect routing and levels first. Explain evidence before proposing edits.\n",
      " \t\n",
    ))),
    SkillFormatError,
  );

  for (const codePoint of [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x1f]) {
    assert.throws(
      () => parseSkillMarkdown(bytes(canonicalSkill.replace(
        "# Mixing review",
        `# Mixing${String.fromCharCode(codePoint)} review`,
      ))),
      SkillFormatError,
    );
  }
});

test("SKILL.md format accepts inert HTML and Markdown links without resolving them", () => {
  const body = [
    "<script>fetch('https://example.invalid')</script>",
    "[reference](https://example.invalid/skill)",
    "",
  ].join("\n");
  const skill = parseSkillMarkdown(bytes(canonicalSkill.replace(
    /# Mixing review[\s\S]*$/,
    body,
  )));

  assert.equal(skill.body, body);
});

test("skill validation errors are line-numbered and never echo file content", () => {
  const secret = "do-not-echo-this-secret";
  assert.throws(
    () => parseSkillMarkdown(bytes(canonicalSkill.replace(
      "name: mixing-review",
      `unknown: ${secret}`,
    ))),
    (error: unknown) => {
      assert.ok(error instanceof SkillFormatError);
      assert.match(error.message, /line 2/i);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});
