import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import test from "node:test";
import { TextEncoder } from "node:util";

import { createHostAbortController } from "../runtime/host.js";
import { AttachmentProcessingError } from "./contracts.js";
import { processingError } from "./ooxml-test-helpers.js";
import type { OoxmlPackage } from "./ooxml.js";
import { extractPptxText } from "./pptx.js";

const transitional = {
  presentation:
    "http://schemas.openxmlformats.org/presentationml/2006/main",
  drawing: "http://schemas.openxmlformats.org/drawingml/2006/main",
  officeRelationships:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  packageRelationships:
    "http://schemas.openxmlformats.org/package/2006/relationships",
} as const;
const strict = {
  presentation: "http://purl.oclc.org/ooxml/presentationml/main",
  drawing: "http://purl.oclc.org/ooxml/drawingml/main",
  officeRelationships:
    "http://purl.oclc.org/ooxml/officeDocument/relationships",
  packageRelationships: "http://purl.oclc.org/ooxml/package/relationships",
} as const;
const encoder = new TextEncoder();

interface NamespaceFamily {
  presentation: string;
  drawing: string;
  officeRelationships: string;
  packageRelationships: string;
}

function makePackage(
  parts: Readonly<Record<string, string | Uint8Array>>,
): OoxmlPackage {
  return {
    kind: "pptx",
    entries: new Map(Object.entries(parts).map(([name, value]) => [
      name,
      typeof value === "string" ? encoder.encode(value) : value,
    ])),
  };
}

function presentationXml(
  slideIds: readonly {
    relationshipId: string;
    hidden?: boolean;
    numericId?: string;
    show?: string;
  }[],
  family: NamespaceFamily = transitional,
): string {
  const ids = slideIds.map((slide, index) =>
    `<p:sldId id="${slide.numericId ?? 256 + index}" ` +
    `r:id="${slide.relationshipId}"` +
    `${slide.show !== undefined
      ? ` show="${slide.show}"`
      : slide.hidden ? ' show="0"' : ""}/>`
  ).join("");
  return `<p:presentation xmlns:p="${family.presentation}" ` +
    `xmlns:r="${family.officeRelationships}"><p:sldIdLst>${ids}` +
    `</p:sldIdLst></p:presentation>`;
}

function relationshipsXml(
  relationships: readonly {
    id: string;
    target?: string;
    type?: string;
    targetMode?: string;
  }[],
  family: NamespaceFamily = transitional,
): string {
  const values = relationships.map((relationship) =>
    `<Relationship Id="${relationship.id}" ` +
    `Type="${relationship.type ?? `${family.officeRelationships}/slide`}"` +
    `${relationship.target === undefined ? "" : ` Target="${relationship.target}"`}` +
    `${relationship.targetMode === undefined ? "" : ` TargetMode="${relationship.targetMode}"`}/>`
  ).join("");
  return `<Relationships xmlns="${family.packageRelationships}">${values}</Relationships>`;
}

function slideXml(
  body: string,
  options: {
    family?: NamespaceFamily;
    rootName?: string;
    hidden?: boolean;
    show?: string;
    presentationNamespace?: string;
    drawingNamespace?: string;
  } = {},
): string {
  const family = options.family ?? transitional;
  return `<${options.rootName ?? "p:sld"} ` +
    `xmlns:p="${options.presentationNamespace ?? family.presentation}" ` +
    `xmlns:a="${options.drawingNamespace ?? family.drawing}"` +
    `${options.show !== undefined
      ? ` show="${options.show}"`
      : options.hidden ? ' show="0"' : ""}>` +
    `<p:cSld><p:spTree>${body}</p:spTree></p:cSld>` +
    `</${options.rootName ?? "p:sld"}>`;
}

function textParagraph(text: string): string {
  return `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`;
}

function oneSlidePackage(
  body: string,
  options: {
    family?: NamespaceFamily;
    slideOptions?: Parameters<typeof slideXml>[1];
    relationship?: Parameters<typeof relationshipsXml>[0][number];
    extraParts?: Readonly<Record<string, string | Uint8Array>>;
  } = {},
): OoxmlPackage {
  const family = options.family ?? transitional;
  const relationship = options.relationship ?? {
    id: "rId1",
    target: "slides/content.xml",
  };
  return makePackage({
    "ppt/presentation.xml": presentationXml([
      { relationshipId: relationship.id },
    ], family),
    "ppt/_rels/presentation.xml.rels": relationshipsXml(
      [relationship],
      family,
    ),
    "ppt/slides/content.xml": slideXml(body, {
      family,
      ...options.slideOptions,
    }),
    ...options.extraParts,
  });
}

test("PPTX follows presentation relationship order, not slide filenames", async () => {
  const officePackage = makePackage({
    "ppt/presentation.xml": presentationXml([
      { relationshipId: "rSecond" },
      { relationshipId: "rFirst" },
    ]),
    "ppt/_rels/presentation.xml.rels": relationshipsXml([
      { id: "rFirst", target: "slides/slide99.xml" },
      { id: "rSecond", target: "slides/custom-name.xml" },
      {
        id: "external-link",
        target: "https://example.test/ignored",
        targetMode: "External",
        type: `${transitional.officeRelationships}/hyperlink`,
      },
      {
        id: "external-slide",
        target: "https://example.test/not-fetched",
        targetMode: "External",
      },
    ]),
    "ppt/slides/custom-name.xml": slideXml(textParagraph("Second relation")),
    "ppt/slides/slide99.xml": slideXml(textParagraph("First relation")),
    "ppt/slides/slide1.xml": slideXml(textParagraph("Filename decoy")),
  });

  assert.deepEqual(await extractPptxText({ officePackage }), {
    text: "Slide 1:\nSecond relation\n\nSlide 2:\nFirst relation",
    truncated: false,
  });
});

test("PPTX accepts the Strict namespace and slide relationship family", async () => {
  const officePackage = oneSlidePackage(textParagraph("Strict slide"), {
    family: {
      ...strict,
      packageRelationships: transitional.packageRelationships,
    },
  });

  assert.deepEqual(await extractPptxText({ officePackage }), {
    text: "Slide 1:\nStrict slide",
    truncated: false,
  });
});

test("PPTX rejects duplicate, external, unsafe, and missing used slide relationships", async (t) => {
  await t.test("duplicate relationship IDs", async () => {
    const officePackage = makePackage({
      "ppt/presentation.xml": presentationXml([{ relationshipId: "rId1" }]),
      "ppt/_rels/presentation.xml.rels": relationshipsXml([
        { id: "rId1", target: "slides/one.xml" },
        { id: "rId1", target: "slides/two.xml" },
      ]),
      "ppt/slides/one.xml": slideXml(textParagraph("one")),
      "ppt/slides/two.xml": slideXml(textParagraph("two")),
    });
    await assert.rejects(
      extractPptxText({ officePackage }),
      processingError("invalid_document"),
    );
  });

  await t.test("referenced external slide", async () => {
    const officePackage = oneSlidePackage(textParagraph("unused"), {
      relationship: {
        id: "rId1",
        target: "https://example.test/slide.xml",
        targetMode: "External",
      },
    });
    await assert.rejects(
      extractPptxText({ officePackage }),
      processingError("invalid_document"),
    );
  });

  for (const target of [
    "slides\\bad.xml",
    "/slides/bad.xml",
    "./slides/bad.xml",
    "slides/../bad.xml",
    "slides//bad.xml",
    "slides/bad.xml?query",
    "slides/bad.xml#fragment",
    "slides/bad:name.xml",
    "https://example.test/bad.xml",
  ]) {
    await t.test(`unsafe target ${target}`, async () => {
      const officePackage = oneSlidePackage(textParagraph("unused"), {
        relationship: { id: "rId1", target },
      });
      await assert.rejects(
        extractPptxText({ officePackage }),
        processingError("invalid_document"),
      );
    });
  }

  await t.test("missing Target attribute", async () => {
    const officePackage = oneSlidePackage(textParagraph("unused"), {
      relationship: { id: "rId1" },
    });
    await assert.rejects(
      extractPptxText({ officePackage }),
      processingError("invalid_document"),
    );
  });

  await t.test("missing target entry", async () => {
    const officePackage = makePackage({
      "ppt/presentation.xml": presentationXml([{ relationshipId: "rId1" }]),
      "ppt/_rels/presentation.xml.rels": relationshipsXml([
        { id: "rId1", target: "slides/missing.xml" },
      ]),
    });
    await assert.rejects(
      extractPptxText({ officePackage }),
      processingError("invalid_document"),
    );
  });
});

test("PPTX requires unique canonical numeric slide IDs and relationship IDs", async (t) => {
  for (const numericId of [
    "not-a-number",
    "0256",
    "255",
    "2147483648",
    "4294967296",
  ]) {
    await t.test(`invalid numeric slide ID ${numericId}`, async () => {
      const officePackage = makePackage({
        "ppt/presentation.xml": presentationXml([
          { relationshipId: "rId1", numericId },
        ]),
        "ppt/_rels/presentation.xml.rels": relationshipsXml([
          { id: "rId1", target: "slides/one.xml" },
        ]),
        "ppt/slides/one.xml": slideXml(textParagraph("one")),
      });
      await assert.rejects(
        extractPptxText({ officePackage }),
        processingError("invalid_document"),
      );
    });
  }

  await t.test("accepts the maximum ST_SlideId", async () => {
    const officePackage = makePackage({
      "ppt/presentation.xml": presentationXml([
        { relationshipId: "rId1", numericId: "2147483647" },
      ]),
      "ppt/_rels/presentation.xml.rels": relationshipsXml([
        { id: "rId1", target: "slides/one.xml" },
      ]),
      "ppt/slides/one.xml": slideXml(textParagraph("maximum")),
    });
    assert.equal(
      (await extractPptxText({ officePackage })).text,
      "Slide 1:\nmaximum",
    );
  });

  await t.test("duplicate numeric slide IDs", async () => {
    const officePackage = makePackage({
      "ppt/presentation.xml": presentationXml([
        { relationshipId: "rId1", numericId: "256" },
        { relationshipId: "rId2", numericId: "256" },
      ]),
      "ppt/_rels/presentation.xml.rels": relationshipsXml([
        { id: "rId1", target: "slides/one.xml" },
        { id: "rId2", target: "slides/two.xml" },
      ]),
      "ppt/slides/one.xml": slideXml(textParagraph("one")),
      "ppt/slides/two.xml": slideXml(textParagraph("two")),
    });
    await assert.rejects(
      extractPptxText({ officePackage }),
      processingError("invalid_document"),
    );
  });

  await t.test("duplicate slide relationship IDs", async () => {
    const officePackage = makePackage({
      "ppt/presentation.xml": presentationXml([
        { relationshipId: "rId1" },
        { relationshipId: "rId1" },
      ]),
      "ppt/_rels/presentation.xml.rels": relationshipsXml([
        { id: "rId1", target: "slides/one.xml" },
      ]),
      "ppt/slides/one.xml": slideXml(textParagraph("one")),
    });
    await assert.rejects(
      extractPptxText({ officePackage }),
      processingError("invalid_document"),
    );
  });
});

test("PPTX normalizes format failures to one fixed safe message", async () => {
  const expectedMessage =
    "The PPTX attachment is not a valid supported document.";
  const invalidPackages = [
    makePackage({
      "ppt/_rels/presentation.xml.rels": relationshipsXml([]),
    }),
    oneSlidePackage(textParagraph("unused"), {
      relationship: {
        id: "rId1",
        target: "slides/private-name.xml?secret=value",
      },
    }),
    makePackage({
      "ppt/presentation.xml": "<not-closed>",
      "ppt/_rels/presentation.xml.rels": relationshipsXml([]),
    }),
  ];

  for (const officePackage of invalidPackages) {
    await assert.rejects(extractPptxText({ officePackage }), (error: unknown) => {
      assert.ok(error instanceof AttachmentProcessingError);
      assert.equal(error.code, "invalid_document");
      assert.equal(error.message, expectedMessage);
      return true;
    });
  }
});

test("PPTX validates exact package parts, roots, namespaces, and used relationship types", async (t) => {
  const invalidPackages: readonly [string, OoxmlPackage][] = [
    [
      "package kind",
      { ...oneSlidePackage(textParagraph("text")), kind: "docx" },
    ],
    [
      "exact presentation part",
      makePackage({
        "other/presentation.xml": presentationXml([]),
        "ppt/_rels/presentation.xml.rels": relationshipsXml([]),
      }),
    ],
    [
      "presentation root",
      makePackage({
        "ppt/presentation.xml": `<p:document xmlns:p="${transitional.presentation}" ` +
          `xmlns:r="${transitional.officeRelationships}"/>`,
        "ppt/_rels/presentation.xml.rels": relationshipsXml([]),
      }),
    ],
    [
      "presentation namespace",
      makePackage({
        "ppt/presentation.xml": presentationXml([], {
          ...transitional,
          presentation: "https://evil.test/presentation",
        }),
        "ppt/_rels/presentation.xml.rels": relationshipsXml([]),
      }),
    ],
    [
      "presentation relationship namespace",
      makePackage({
        "ppt/presentation.xml": presentationXml([]),
        "ppt/_rels/presentation.xml.rels":
          `<Relationships xmlns="https://evil.test/relationships"/>`,
      }),
    ],
    [
      "redefined PresentationML prefix",
      makePackage({
        "ppt/presentation.xml":
          `<p:presentation xmlns:p="${transitional.presentation}" ` +
          `xmlns:r="${transitional.officeRelationships}">` +
          `<p:sldIdLst xmlns:p="https://evil.test/presentation"/>` +
          `</p:presentation>`,
        "ppt/_rels/presentation.xml.rels": relationshipsXml([]),
      }),
    ],
    [
      "used relationship type",
      oneSlidePackage(textParagraph("text"), {
        relationship: {
          id: "rId1",
          target: "slides/content.xml",
          type: `${transitional.officeRelationships}/notesSlide`,
        },
      }),
    ],
    [
      "Strict slide relationship type in a Transitional presentation",
      oneSlidePackage(textParagraph("text"), {
        relationship: {
          id: "rId1",
          target: "slides/content.xml",
          type: `${strict.officeRelationships}/slide`,
        },
      }),
    ],
    [
      "Transitional slide relationship type in a Strict presentation",
      oneSlidePackage(textParagraph("text"), {
        family: strict,
        relationship: {
          id: "rId1",
          target: "slides/content.xml",
          type: `${transitional.officeRelationships}/slide`,
        },
      }),
    ],
    [
      "slide root",
      oneSlidePackage(textParagraph("text"), {
        slideOptions: { rootName: "p:notes" },
      }),
    ],
    [
      "slide PresentationML namespace",
      oneSlidePackage(textParagraph("text"), {
        slideOptions: { presentationNamespace: "https://evil.test/presentation" },
      }),
    ],
    [
      "slide DrawingML namespace",
      oneSlidePackage(textParagraph("text"), {
        slideOptions: { drawingNamespace: "https://evil.test/drawing" },
      }),
    ],
    [
      "redefined DrawingML prefix",
      oneSlidePackage(
        `<p:sp xmlns:a="https://evil.test/drawing">` +
        `${textParagraph("text")}</p:sp>`,
      ),
    ],
  ];

  for (const [name, officePackage] of invalidPackages) {
    await t.test(name, async () => {
      await assert.rejects(
        extractPptxText({ officePackage }),
        processingError("invalid_document"),
      );
    });
  }
});

test("PPTX marks hidden slides and omits text in directly hidden shapes", async () => {
  const hiddenShape =
    `<p:sp><p:nvSpPr><p:cNvPr id="1" name="hidden" hidden="1"/>` +
    `</p:nvSpPr><p:txBody>${textParagraph("Hidden shape text")}</p:txBody></p:sp>`;
  const visibleShape =
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="visible"/>` +
    `</p:nvSpPr><p:txBody>${textParagraph("Visible text")}</p:txBody></p:sp>`;
  const officePackage = makePackage({
    "ppt/presentation.xml": presentationXml([
      { relationshipId: "rId1", hidden: true },
      { relationshipId: "rId2" },
      { relationshipId: "rId3" },
    ]),
    "ppt/_rels/presentation.xml.rels": relationshipsXml([
      { id: "rId1", target: "slides/one.xml" },
      { id: "rId2", target: "slides/two.xml" },
      { id: "rId3", target: "slides/three.xml" },
    ]),
    "ppt/slides/one.xml": slideXml(textParagraph("Hidden by slide ID")),
    "ppt/slides/two.xml": slideXml(textParagraph("Hidden by root"), {
      hidden: true,
    }),
    "ppt/slides/three.xml": slideXml(hiddenShape + visibleShape),
  });

  assert.deepEqual(await extractPptxText({ officePackage }), {
    text:
      "Slide 1:\n[hidden slide omitted]\n\n" +
      "Slide 2:\n[hidden slide omitted]\n\n" +
      "Slide 3:\nVisible text",
    truncated: false,
  });
});

test("PPTX applies strict XML booleans to slide and direct-shape visibility", async (t) => {
  const hiddenShape =
    `<p:sp><p:nvSpPr><p:cNvPr id="1" hidden="true"/></p:nvSpPr>` +
    `<p:txBody>${textParagraph("hidden true")}</p:txBody></p:sp>`;
  const visibleShape =
    `<p:sp><p:nvSpPr><p:cNvPr id="2" hidden="false"/></p:nvSpPr>` +
    `<p:txBody>${textParagraph("visible false")}</p:txBody></p:sp>`;
  const officePackage = makePackage({
    "ppt/presentation.xml": presentationXml([
      { relationshipId: "rId1", show: "false" },
      { relationshipId: "rId2", show: "true" },
      { relationshipId: "rId3" },
      { relationshipId: "rId4" },
      { relationshipId: "rId5" },
    ]),
    "ppt/_rels/presentation.xml.rels": relationshipsXml([
      { id: "rId1", target: "slides/one.xml" },
      { id: "rId2", target: "slides/two.xml" },
      { id: "rId3", target: "slides/three.xml" },
      { id: "rId4", target: "slides/four.xml" },
      { id: "rId5", target: "slides/five.xml" },
    ]),
    "ppt/slides/one.xml": slideXml(textParagraph("hidden false ID")),
    "ppt/slides/two.xml": slideXml(textParagraph("visible true ID")),
    "ppt/slides/three.xml": slideXml(textParagraph("hidden false root"), {
      show: "false",
    }),
    "ppt/slides/four.xml": slideXml(textParagraph("visible true root"), {
      show: "true",
    }),
    "ppt/slides/five.xml": slideXml(hiddenShape + visibleShape),
  });
  assert.deepEqual(await extractPptxText({ officePackage }), {
    text:
      "Slide 1:\n[hidden slide omitted]\n\n" +
      "Slide 2:\nvisible true ID\n\n" +
      "Slide 3:\n[hidden slide omitted]\n\n" +
      "Slide 4:\nvisible true root\n\n" +
      "Slide 5:\nvisible false",
    truncated: false,
  });

  const invalidPackages = [
    makePackage({
      "ppt/presentation.xml": presentationXml([
        { relationshipId: "rId1", show: "yes" },
      ]),
      "ppt/_rels/presentation.xml.rels": relationshipsXml([
        { id: "rId1", target: "slides/one.xml" },
      ]),
      "ppt/slides/one.xml": slideXml(textParagraph("must not leak")),
    }),
    makePackage({
      "ppt/presentation.xml": presentationXml([
        { relationshipId: "rId1", show: "false" },
      ]),
      "ppt/_rels/presentation.xml.rels": relationshipsXml([
        { id: "rId1", target: "slides/one.xml" },
      ]),
      "ppt/slides/one.xml": slideXml(textParagraph("must not leak"), {
        show: "yes",
      }),
    }),
    oneSlidePackage(
      `<p:sp><p:nvSpPr><p:cNvPr id="1" hidden="yes"/></p:nvSpPr>` +
      `<p:txBody>${textParagraph("must not leak")}</p:txBody></p:sp>`,
    ),
  ];
  for (const invalidPackage of invalidPackages) {
    await t.test("rejects an invalid XML boolean", async () => {
      await assert.rejects(
        extractPptxText({ officePackage: invalidPackage }),
        (error: unknown) => {
          assert.ok(error instanceof AttachmentProcessingError);
          assert.equal(error.code, "invalid_document");
          assert.equal(
            error.message,
            "The PPTX attachment is not a valid supported document.",
          );
          return true;
        },
      );
    });
  }
});

test("PPTX preserves DrawingML text, break, tab, and paragraph order", async () => {
  const body =
    `<a:p><a:r><a:t>First</a:t></a:r><a:tab/>` +
    `<a:r><a:t>Second</a:t><a:br/><a:t>Third</a:t></a:r></a:p>` +
    `<a:p><a:r><a:t>Next paragraph</a:t></a:r></a:p>`;

  assert.deepEqual(await extractPptxText({
    officePackage: oneSlidePackage(body),
  }), {
    text: "Slide 1:\nFirst\tSecond\nThird\nNext paragraph",
    truncated: false,
  });
});

test("PPTX reads only referenced slide XML, excluding notes, charts, SmartArt, and media", async () => {
  const officePackage = oneSlidePackage(textParagraph("Slide text"), {
    extraParts: {
      "ppt/notesSlides/notesSlide1.xml": slideXml(textParagraph("Notes secret")),
      "ppt/charts/chart1.xml": `<a:chart xmlns:a="${transitional.drawing}">` +
        `${textParagraph("Chart secret")}</a:chart>`,
      "ppt/diagrams/data1.xml": `<a:diagram xmlns:a="${transitional.drawing}">` +
        `${textParagraph("SmartArt secret")}</a:diagram>`,
      "ppt/media/audio1.wav": encoder.encode("Media secret"),
      "ppt/slides/_rels/content.xml.rels":
        `<Relationships xmlns="${transitional.packageRelationships}">` +
        `<Relationship Id="rNote" Type="${transitional.officeRelationships}/notesSlide" ` +
        `Target="../notesSlides/notesSlide1.xml"/>` +
        `<Relationship Id="rLink" Type="${transitional.officeRelationships}/hyperlink" ` +
        `Target="https://example.test/ignored" TargetMode="External"/>` +
        `</Relationships>`,
    },
  });

  assert.deepEqual(await extractPptxText({ officePackage }), {
    text: "Slide 1:\nSlide text",
    truncated: false,
  });
});

test("PPTX enforces slide and per-slide paragraph caps", async (t) => {
  await t.test("more than 256 slides", async () => {
    const slideIds = Array.from({ length: 257 }, (_, index) => ({
      relationshipId: `rId${index}`,
    }));
    const officePackage = makePackage({
      "ppt/presentation.xml": presentationXml(slideIds),
      "ppt/_rels/presentation.xml.rels": relationshipsXml([]),
    });
    await assert.rejects(
      extractPptxText({ officePackage }),
      processingError("archive_limit"),
    );
  });

  await t.test("more than 20,000 paragraphs on a slide", async () => {
    const paragraphs = "<a:p/>".repeat(20_001);
    await assert.rejects(
      extractPptxText({ officePackage: oneSlidePackage(paragraphs) }),
      processingError("archive_limit"),
    );
  });
});

test("PPTX shares the 100,000-code-point budget without splitting surrogates", async () => {
  const exactText = `🎵${"x".repeat(99_990)}`;
  const exact = await extractPptxText({
    officePackage: oneSlidePackage(textParagraph(exactText)),
  });
  assert.equal(Array.from(exact.text).length, 100_000);
  assert.equal(exact.text, `Slide 1:\n${exactText}`);
  assert.equal(exact.truncated, false);

  const oneOverText = `🎵${"x".repeat(99_991)}`;
  const oneOver = await extractPptxText({
    officePackage: oneSlidePackage(textParagraph(oneOverText)),
  });
  assert.equal(Array.from(oneOver.text).length, 100_000);
  assert.equal(oneOver.text.startsWith("Slide 1:\n🎵"), true);
  assert.equal(oneOver.text.endsWith("x"), true);
  assert.equal(oneOver.truncated, true);
});

test("PPTX honors pre-cancellation and event-driven cancellation during traversal", async (t) => {
  await t.test("pre-cancelled", async () => {
    const controller = createHostAbortController();
    const reason = new Error("cancel before PPTX extraction");
    controller.abort(reason);
    await assert.rejects(
      extractPptxText({
        officePackage: oneSlidePackage(textParagraph("text")),
        signal: controller.signal,
      }),
      (error: unknown) => error === reason,
    );
  });

  await t.test("cancelled between paragraphs", async () => {
    const controller = createHostAbortController();
    const reason = new Error("cancel during PPTX extraction");
    const paragraphs = textParagraph("text").repeat(100);
    const pending = extractPptxText({
      officePackage: oneSlidePackage(paragraphs),
      signal: controller.signal,
    });
    setImmediate(() => controller.abort(reason));
    await assert.rejects(pending, (error: unknown) => error === reason);
  });

  await t.test("cancelled while traversing a hidden slide with no paragraphs", async () => {
    const controller = createHostAbortController();
    const reason = new Error("cancel during hidden slide traversal");
    const officePackage = oneSlidePackage("<p:sp/>".repeat(10_000), {
      slideOptions: { hidden: true },
    });
    const pending = extractPptxText({
      officePackage,
      signal: controller.signal,
    });
    setImmediate(() => setImmediate(() => controller.abort(reason)));
    await assert.rejects(pending, (error: unknown) => error === reason);
  });
});
