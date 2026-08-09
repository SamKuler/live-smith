import assert from "node:assert/strict";
import test from "node:test";

import { XMLParser } from "fast-xml-parser";
import { strToU8 } from "fflate/browser";

import { AttachmentProcessingError } from "./contracts.js";
import { processingError, utf16Xml } from "./ooxml-test-helpers.js";
import {
  collectTextNodes,
  MAX_OOXML_ENTRY_UNCOMPRESSED_BYTES,
  parseXmlPreservingOrder,
} from "./ooxml.js";

test("OOXML XML helpers preserve order without expanding entities", () => {
  const nodes = parseXmlPreservingOrder(
    "<root><a>first</a><a>第二</a><value>001 &amp; &#x41; &lt;</value></root>",
  );
  assert.deepEqual(collectTextNodes(nodes), ["first", "第二", "001 & A <"]);
  assert.throws(
    () => parseXmlPreservingOrder("<!DOCTYPE root [<!ENTITY x 'expanded'>]><root>&x;</root>"),
    processingError("invalid_document"),
  );
  assert.throws(
    () => parseXmlPreservingOrder("<?target value?><root/>") ,
    processingError("invalid_document"),
  );
  for (const numericEntity of ["&#0;", "&#1;", "&#xB;", "&#xFFFE;", "&#xFFFF;"]) {
    assert.throws(
      () => parseXmlPreservingOrder(`<root>${numericEntity}</root>`),
      processingError("invalid_document"),
    );
  }
  assert.deepEqual(
    collectTextNodes(parseXmlPreservingOrder("<root>&#9;&#10;&#13;&#x10000;</root>")),
    ["\t\n\r\u{10000}"],
  );
  for (const invalidXml of [
    "<root>&bogus;</root>",
    "<root>&AMP;</root>",
    "<root>\u0001</root>",
    "<root>\uFFFE</root>",
  ]) {
    assert.throws(
      () => parseXmlPreservingOrder(invalidXml),
      processingError("invalid_document"),
    );
  }
  assert.deepEqual(
    collectTextNodes(parseXmlPreservingOrder(
      "<root><![CDATA[&amp; &bogus; &#0;]]></root>",
    )),
    ["&amp; &bogus; &#0;"],
  );
  assert.deepEqual(
    collectTextNodes(parseXmlPreservingOrder(
      "<root><![CDATA[<!DOCTYPE x><?evil?>]]><!-- <!ENTITY e 'x'> <?evil?> --></root>",
    )),
    ["<!DOCTYPE x><?evil?>"],
  );
  assert.deepEqual(
    collectTextNodes(parseXmlPreservingOrder(
      "<?xml version='1.0' encoding='UTF-8' standalone='yes'?><root>ok</root>",
    )),
    ["ok"],
  );
  for (const invalidDeclaration of [
    "<root><?xml version=\"1.0\"?></root>",
    "<?xml version=\"1.1\"?><root/>",
    "<?XML version=\"1.0\"?><root/>",
    "<?xml encoding=\"UTF-8\" version=\"1.0\"?><root/>",
    "<?xml version=\"1.0\" version=\"1.0\"?><root/>",
    "<?xml version=\"1.0\" standalone=\"maybe\"?><root/>",
    "<?xml version=\"1.0\" standalone=\"yes\" encoding=\"UTF-8\"?><root/>",
  ]) {
    assert.throws(
      () => parseXmlPreservingOrder(invalidDeclaration),
      processingError("invalid_document"),
    );
  }
  assert.throws(
    () => parseXmlPreservingOrder(`<root>&#${"9".repeat(10_000)};</root>`),
    (error: unknown) => {
      assert.ok(error instanceof AttachmentProcessingError);
      assert.equal(error.code, "invalid_document");
      assert.ok(error.message.length < 100);
      return true;
    },
  );
  assert.throws(
    () => parseXmlPreservingOrder(`<root>${"<x>".repeat(257)}value${"</x>".repeat(257)}</root>`),
    (error: unknown) => error instanceof AttachmentProcessingError,
  );
});

test("OOXML XML decoding accepts strict UTF BOMs and rejects malformed or mismatched encodings", () => {
  const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><root>ok</root>`,
  )]);
  assert.deepEqual(collectTextNodes(parseXmlPreservingOrder(utf8)), ["ok"]);
  assert.deepEqual(
    collectTextNodes(parseXmlPreservingOrder(utf16Xml(
      `<?xml version="1.0" encoding="UTF-16"?><root>左</root>`,
      "le",
    ))),
    ["左"],
  );
  assert.deepEqual(
    collectTextNodes(parseXmlPreservingOrder(utf16Xml(
      `<?xml version="1.0" encoding="UTF-16BE"?><root>右</root>`,
      "be",
    ))),
    ["右"],
  );
  assert.deepEqual(
    collectTextNodes(parseXmlPreservingOrder(utf16Xml("<root>无声明</root>", "le"))),
    ["无声明"],
  );
  assert.throws(
    () => parseXmlPreservingOrder(new Uint8Array([0x3c, 0x72, 0x80, 0x2f, 0x3e])),
    processingError("invalid_document"),
  );
  assert.throws(
    () => parseXmlPreservingOrder(strToU8(
      `<?xml version="1.0" encoding="UTF-16"?><root/>`,
    )),
    processingError("invalid_document"),
  );
});

test("OOXML XML node budget rejects an AST allocation bomb before parsing", () => {
  const bomb = `<root>${"<x/>".repeat(100_001)}</root>`;
  const parserPrototype = XMLParser.prototype as unknown as {
    parse: (...args: unknown[]) => unknown;
  };
  const originalParse = parserPrototype.parse;
  let parseCalls = 0;
  parserPrototype.parse = function (...args: unknown[]) {
    parseCalls += 1;
    return originalParse.apply(this, args);
  };
  try {
    assert.throws(
      () => parseXmlPreservingOrder(bomb),
      processingError("archive_limit"),
    );
    assert.equal(parseCalls, 0);
    assert.throws(
      () => parseXmlPreservingOrder(
        `${"<x>".repeat(257)}value${"</x>".repeat(257)}`,
      ),
      processingError("archive_limit"),
    );
    assert.equal(parseCalls, 0);
  } finally {
    parserPrototype.parse = originalParse;
  }
});

test("OOXML XML node budget accepts ordinary elements below the AST limit", () => {
  const siblingCount = 25_001;
  const nodes = parseXmlPreservingOrder(
    `<root>${"<x>v</x>".repeat(siblingCount)}</root>`,
  );
  assert.equal(collectTextNodes(nodes).length, siblingCount);
});

test("OOXML XML public parsing rejects an oversized single text or attribute value", () => {
  const oversized = "A".repeat(MAX_OOXML_ENTRY_UNCOMPRESSED_BYTES + 1);
  assert.throws(
    () => parseXmlPreservingOrder(`<root>${oversized}</root>`),
    processingError("archive_limit"),
  );
  assert.throws(
    () => parseXmlPreservingOrder(`<root value="${oversized}"/>`),
    processingError("archive_limit"),
  );
});
