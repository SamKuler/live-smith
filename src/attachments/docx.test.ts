import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import test from "node:test";

import { strToU8 } from "fflate/browser";

import {
  AttachmentProcessingError,
  MAX_OOXML_XML_PART_BYTES,
} from "./contracts.js";
import { extractDocxText } from "./docx.js";
import type { OoxmlKind, OoxmlPackage } from "./ooxml.js";

const transitionalNamespace =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const strictNamespace =
  "http://purl.oclc.org/ooxml/wordprocessingml/main";
const invalidDocxMessage =
  "The DOCX attachment is not a valid supported document.";

function documentXml(
  body: string,
  namespace = transitionalNamespace,
): string {
  return `<w:document xmlns:w="${namespace}"><w:body>${body}</w:body></w:document>`;
}

function officePackage(
  mainXml: string | undefined,
  options: {
    kind?: OoxmlKind;
    additions?: Readonly<Record<string, string>>;
  } = {},
): OoxmlPackage {
  const entries = new Map<string, Uint8Array>();
  if (mainXml !== undefined) {
    entries.set("word/document.xml", strToU8(mainXml));
  }
  for (const [name, value] of Object.entries(options.additions ?? {})) {
    entries.set(name, strToU8(value));
  }
  return {
    kind: options.kind ?? "docx",
    entries,
  };
}

function invalidDocx(error: unknown): boolean {
  assert.ok(error instanceof AttachmentProcessingError);
  assert.equal(error.code, "invalid_document");
  assert.equal(error.message, invalidDocxMessage);
  return true;
}

test("DOCX extracts Unicode paragraphs, tabs, and breaks in body order", async () => {
  const result = await extractDocxText({
    officePackage: officePackage(documentXml(
      `<w:p><w:r><w:t>First 🎵</w:t><w:tab/><w:t>第二</w:t>` +
        `<w:br/><w:t>line</w:t></w:r></w:p>` +
        `<w:p><w:hyperlink><w:r><w:t>Last</w:t></w:r></w:hyperlink></w:p>`,
    )),
  });

  assert.deepEqual(result, {
    text: "First 🎵\t第二\nline\nLast",
    truncated: false,
  });

  const strict = await extractDocxText({
    officePackage: officePackage(documentXml(
      `<w:p><w:r><w:t>Strict</w:t></w:r></w:p>`,
      strictNamespace,
    )),
  });
  assert.deepEqual(strict, { text: "Strict", truncated: false });
});

test("DOCX accepts inserted and moved-to text but excludes deleted and moved-from text", async () => {
  const result = await extractDocxText({
    officePackage: officePackage(documentXml(
      `<w:p>` +
        `<w:r><w:t>keep </w:t></w:r>` +
        `<w:del><w:r><w:delText>deleted</w:delText><w:t>also deleted</w:t></w:r></w:del>` +
        `<w:moveFrom><w:r><w:t>moved away</w:t></w:r></w:moveFrom>` +
        `<w:ins><w:r><w:t>inserted </w:t></w:r></w:ins>` +
        `<w:moveTo><w:r><w:t>moved here</w:t></w:r></w:moveTo>` +
        `<w:r><w:delText>orphan deleted text</w:delText></w:r>` +
        `</w:p>`,
    )),
  });

  assert.deepEqual(result, {
    text: "keep inserted moved here",
    truncated: false,
  });
});

test("DOCX parses direct vanish On/Off values in Transitional and Strict documents", async () => {
  for (const namespace of [transitionalNamespace, strictNamespace]) {
    const result = await extractDocxText({
      officePackage: officePackage(documentXml(
        `<w:p>` +
          `<w:r><w:rPr><w:vanish/></w:rPr><w:t>missing hidden</w:t></w:r>` +
          `<w:r><w:rPr><w:vanish w:val="true"/></w:rPr><w:t>true hidden</w:t></w:r>` +
          `<w:r><w:rPr><w:vanish w:val="1"/></w:rPr><w:t>one hidden</w:t></w:r>` +
          `<w:r><w:rPr><w:vanish w:val="on"/></w:rPr><w:t>on hidden</w:t></w:r>` +
          `<w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t>false </w:t></w:r>` +
          `<w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>zero </w:t></w:r>` +
          `<w:r><w:rPr><w:vanish w:val="off"/></w:rPr><w:t>off </w:t></w:r>` +
          `<w:r><w:rPr><w:rPrChange><w:rPr><w:vanish/></w:rPr>` +
          `</w:rPrChange></w:rPr><w:t>indirect visible</w:t></w:r>` +
          `</w:p>`,
        namespace,
      )),
    });

    assert.deepEqual(result, {
      text: "false zero off indirect visible",
      truncated: false,
    });

    await assert.rejects(
      extractDocxText({
        officePackage: officePackage(documentXml(
          `<w:p><w:r><w:rPr><w:vanish w:val="yes"/></w:rPr>` +
            `<w:t>must not leak</w:t></w:r></w:p>`,
          namespace,
        )),
      }),
      invalidDocx,
    );
  }
});

test("DOCX rejects nested elements inside text nodes instead of leaking deleted text", async () => {
  const rawMarker = "DELETED_RAW_CONTENT";
  await assert.rejects(
    extractDocxText({
      officePackage: officePackage(documentXml(
        `<w:p><w:r><w:t>safe<w:del><w:delText>${rawMarker}</w:delText>` +
          `</w:del></w:t></w:r></w:p>`,
      )),
    }),
    (error: unknown) => {
      assert.equal(invalidDocx(error), true);
      assert.ok(error instanceof AttachmentProcessingError);
      assert.doesNotMatch(error.message, new RegExp(rawMarker));
      return true;
    },
  );
});

test("DOCX excludes field instructions while retaining visible field results", async () => {
  const result = await extractDocxText({
    officePackage: officePackage(documentXml(
      `<w:p>` +
        `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
        `<w:r><w:instrText>HYPERLINK "https://secret.invalid"</w:instrText></w:r>` +
        `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
        `<w:r><w:t>Visible label</w:t></w:r>` +
        `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
        `</w:p>` +
        `<w:p><w:fldSimple w:instr="DATE"><w:r><w:t>August 10</w:t></w:r>` +
        `</w:fldSimple></w:p>`,
    )),
  });

  assert.deepEqual(result, {
    text: "Visible label\nAugust 10",
    truncated: false,
  });
});

test("DOCX renders tables as stable TSV with fixed non-Markdown markers", async () => {
  const result = await extractDocxText({
    officePackage: officePackage(documentXml(
      `<w:p><w:r><w:t>Before</w:t></w:r></w:p>` +
        `<w:tbl>` +
        `<w:tr>` +
        `<w:tc>` +
        `<w:p><w:r><w:t>alpha</w:t><w:tab/><w:t>  beta</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>gamma</w:t><w:br/><w:t>delta</w:t></w:r></w:p>` +
        `</w:tc>` +
        `<w:tc><w:p><w:r><w:t>| raw \\ value</w:t></w:r></w:p></w:tc>` +
        `</w:tr>` +
        `<w:tr><w:tc><w:p><w:r><w:t>left</w:t></w:r></w:p></w:tc>` +
        `<w:tc><w:p/></w:tc></w:tr>` +
        `</w:tbl>` +
        `<w:p><w:r><w:t>After</w:t></w:r></w:p>`,
    )),
  });

  assert.deepEqual(result, {
    text:
      "Before\n[Table]\nalpha beta gamma delta\t| raw \\ value\nleft\t\n[/Table]\nAfter",
    truncated: false,
  });
});

test("DOCX reads only the exact main document part", async () => {
  const result = await extractDocxText({
    officePackage: officePackage(
      documentXml(
        `<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Main only</w:t></w:r>` +
          `<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>`,
      ),
      {
        additions: {
          "word/header1.xml": "<w:hdr><w:p><w:r><w:t>header secret</w:t></w:r></w:p></w:hdr>",
          "word/footer1.xml": "<w:ftr><w:p><w:r><w:t>footer secret</w:t></w:r></w:p></w:ftr>",
          "word/comments.xml": "<w:comments><w:comment>comment secret</w:comment></w:comments>",
          "word/footnotes.xml": "<w:footnotes><w:footnote>note secret</w:footnote></w:footnotes>",
          "word/document.xml.backup": documentXml(
            `<w:p><w:r><w:t>backup secret</w:t></w:r></w:p>`,
          ),
        },
      },
    ),
  });

  assert.deepEqual(result, { text: "Main only", truncated: false });
});

test("DOCX rejects wrong kinds, missing main parts, roots, and namespaces with one safe error", async () => {
  const invalidPackages = [
    officePackage(documentXml(""), { kind: "xlsx" }),
    officePackage(undefined),
    officePackage(`<w:notDocument xmlns:w="${transitionalNamespace}"/>`),
    officePackage(`<document xmlns="${transitionalNamespace}"><w:body/></document>`),
    officePackage(documentXml("", "https://invalid.example/wordprocessingml")),
    officePackage(
      `<w:document xmlns:w="${transitionalNamespace}"><w:body>` +
        `<w:p xmlns:w="https://invalid.example/rebound"><w:r><w:t>bad</w:t></w:r></w:p>` +
        `</w:body></w:document>`,
    ),
    officePackage(`<w:document xmlns:w="${transitionalNamespace}"><w:body>`),
  ];

  for (const invalidPackage of invalidPackages) {
    await assert.rejects(
      extractDocxText({ officePackage: invalidPackage }),
      invalidDocx,
    );
  }
});

test("DOCX preserves safe archive-limit errors from bounded XML parsing", async () => {
  const rawMarker = "PRIVATE_RAW_DOCUMENT_CONTENT";
  const oversizedXml = `${rawMarker}${"x".repeat(MAX_OOXML_XML_PART_BYTES + 1)}`;

  await assert.rejects(
    extractDocxText({ officePackage: officePackage(oversizedXml) }),
    (error: unknown) => {
      assert.ok(error instanceof AttachmentProcessingError);
      assert.equal(error.code, "archive_limit");
      assert.doesNotMatch(error.message, /word\/document\.xml/);
      assert.doesNotMatch(error.message, new RegExp(rawMarker));
      return true;
    },
  );
});

test("DOCX enforces the 100k Unicode code-point text limit", async () => {
  const exactText = `${"A".repeat(99_999)}🎵`;
  const exact = await extractDocxText({
    officePackage: officePackage(documentXml(
      `<w:p><w:r><w:t>${exactText}</w:t></w:r></w:p>`,
    )),
  });
  assert.equal([...exact.text].length, 100_000);
  assert.equal(exact.text, exactText);
  assert.equal(exact.truncated, false);

  const over = await extractDocxText({
    officePackage: officePackage(documentXml(
      `<w:p><w:r><w:t>${exactText}B</w:t></w:r></w:p>`,
    )),
  });
  assert.equal([...over.text].length, 100_000);
  assert.equal(over.text, exactText);
  assert.equal(over.text.endsWith("🎵"), true);
  assert.equal(over.truncated, true);
});

test("DOCX honors cancellation before parsing and during traversal", async () => {
  const preCancelled = new AbortController();
  const preCancelledReason = new Error("cancel before parsing");
  preCancelled.abort(preCancelledReason);
  await assert.rejects(
    extractDocxText({
      officePackage: officePackage(documentXml("")),
      signal: preCancelled.signal,
    }),
    (error: unknown) => error === preCancelledReason,
  );

  const duringTraversal = new AbortController();
  const duringTraversalReason = new Error("cancel during traversal");
  const paragraphs = `<w:p><w:r><w:t>text</w:t></w:r></w:p>`.repeat(5_000);
  const abortHandle = setImmediate(() => {
    duringTraversal.abort(duringTraversalReason);
  });
  try {
    await assert.rejects(
      extractDocxText({
        officePackage: officePackage(documentXml(paragraphs)),
        signal: duringTraversal.signal,
      }),
      (error: unknown) => error === duringTraversalReason,
    );
  } finally {
    clearImmediate(abortHandle);
  }
});
