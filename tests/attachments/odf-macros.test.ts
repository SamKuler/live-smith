import assert from "node:assert/strict";
import test from "node:test";

import { AttachmentProcessingError } from "../../src/attachments/contracts.js";
import { processAttachment } from "../../src/attachments/processor.js";
import { odfBytes } from "./support/rich-document-test-helpers.js";

function documentBytes(header: string, paragraph: string): Uint8Array {
  return odfBytes("text", "", {
    "content.xml": `<o:document-content xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ` +
      `xmlns:t="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ` +
      `xmlns:s="urn:oasis:names:tc:opendocument:xmlns:script:1.0">` +
      `${header}<o:body><o:text><t:p>${paragraph}</t:p></o:text></o:body></o:document-content>`,
  });
}

test("OpenDocument scripts and inline script fields are rejected by namespace identity", async () => {
  for (const [header, paragraph] of [
    ['<o:scripts><o:script s:language="JavaScript">function macro() { return 1; }</o:script></o:scripts>', "Visible text"],
    ["", 'Before<t:script s:language="JavaScript">function macro() { return 1; }</t:script>After'],
    ["", '<s:event-listener s:language="ooo:Basic" s:event-name="dom:click"/>Visible text'],
  ]) {
    await assert.rejects(processAttachment({
      bytes: documentBytes(header!, paragraph!), fileName: "content.odt", nativePdfAllowed: false,
    }), (error: unknown) => error instanceof AttachmentProcessingError && error.code === "macro_enabled");
  }
});

test("empty script containers and quoted code references remain ordinary visible document text", async () => {
  const result = await processAttachment({
    bytes: documentBytes("<o:scripts/>", "Reference: office:script and text:script are element names."),
    fileName: "reference.odt", nativePdfAllowed: false,
  });
  assert.equal(result.type, "text");
  if (result.type === "text") assert.equal(result.text, "Reference: office:script and text:script are element names.");
});
