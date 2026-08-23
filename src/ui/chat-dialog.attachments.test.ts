import assert from "node:assert/strict";
import test from "node:test";

import { chatDialogStateForWire } from "./chat-state.js";

import {
  audioCapableState,
  audioFile,
  commandCalls,
  createDialogHarness,
  documentFile,
  imageCapableState,
  imageFile,
  jsonCalls,
  modelStateSourceFixture,
  pendingAudio,
  pendingDocument,
  pendingImage,
  profileFixture,
  stateFixture,
  waitForCondition,
} from "./chat-dialog.test-harness.js";

test("pasted plain text remains native and does not start an attachment upload", async () => {
  const harness = await createDialogHarness();
  try {
    assert.equal(harness.dispatchPaste(), false);
    await harness.settle();
    assert.deepEqual(
      harness.calls.filter((call) => call.path === "/attachments"),
      [],
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("the attachment menu explains the supported drop and paste path without image capability", async () => {
  const state = stateFixture();
  state.runtimeProfile!.inputCapabilityEvidence.image = "unsupported";
  const harness = await createDialogHarness(state);
  try {
    const menuButton = harness.document.querySelector<HTMLButtonElement>(
      "#attachmentMenuButton",
    );
    assert.equal(menuButton?.disabled, false);
    assert.match(menuButton?.title ?? "", /does not support image input/i);
    harness.click("#attachmentMenuButton");
    const menuText = harness.document.querySelector("#attachmentMenu")?.textContent ?? "";
    assert.match(menuText, /drop or paste files/i);
    assert.match(menuText, /images, PDF, Office documents, WAV, and MP3/i);
    assert.match(menuText, /file browsing is not available in this Ableton window/i);
    assert.match(menuText, /active model does not support image input/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("the attachment menu keeps selected Live audio as an explicit secondary action", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#attachmentMenuButton");
    const sourceButton = harness.document.querySelector<HTMLButtonElement>(
      "#attachSelectedAudioButton",
    );
    assert.match(sourceButton?.textContent ?? "", /Attach selected Live audio/);
    assert.match(sourceButton?.getAttribute("aria-label") ?? "", /selected Live audio/i);
    assert.match(
      harness.document.querySelector("#audioSourceAttachmentNote")?.textContent ?? "",
      /complete source file.*embedded metadata.*not Live.*warped or processed/i,
    );
    sourceButton?.focus();
    sourceButton?.click();
    assert.equal(
      harness.document.activeElement,
      harness.document.querySelector("#attachmentMenuButton"),
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#attachmentMenu")?.hidden,
      true,
    );
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "attach_selected_audio_source",
        sessionId: "session-1",
      },
    });
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("WAV and MP3 upload without image capability and show authoritative duration", async () => {
  const state = stateFixture();
  state.runtimeProfile!.inputCapabilityEvidence.image = "unsupported";
  const harness = await createDialogHarness(state);
  try {
    harness.dispatchDrop([
      audioFile(harness.window, "source.wav", "audio/wav"),
      audioFile(harness.window, "reference.mp3", "audio/mpeg"),
    ]);
    await harness.settle();
    await harness.settleAttachmentOperation();
    assert.deepEqual(
      harness.calls
        .filter((call) => call.path === "/attachments")
        .map((call) => new URL(call.url).searchParams.get("fileName")),
      ["source.wav", "reference.mp3"],
    );
    const chips = [...harness.document.querySelectorAll(
      "#pendingAttachments [data-attachment-id]",
    )].map((chip) => chip.textContent);
    assert.deepEqual(chips, [
      "source.wav · WAV · 1:23.3 · 24 B×",
      "reference.mp3 · MP3 · 1:23.3 · 24 B×",
    ]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("mixed text and audio paste preserves native text behavior while uploading the file", async () => {
  const harness = await createDialogHarness();
  try {
    assert.equal(
      harness.dispatchPaste(
        [audioFile(harness.window, "idea.wav", "audio/wav")],
        "Keep this text",
      ),
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      false,
    );
    await harness.settle();
    await harness.settleAttachmentOperation();
    assert.equal(
      harness.calls.filter((call) => call.path === "/attachments").length,
      1,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("selected source audio uses the strict Session command and reconciles a pending chip", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#attachSelectedAudioButton");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "attach_selected_audio_source",
        sessionId: "session-1",
      },
    });
    assert.match(
      harness.document.querySelector("#pendingAttachments")?.textContent ?? "",
      /Selected audio\.wav · WAV · 1\.5 s · 94 KiB/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("selected source audio exposes busy feedback until its command settles", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextCommand();
    harness.click("#attachSelectedAudioButton");
    await harness.settle();
    const sourceButton = harness.document.querySelector<HTMLButtonElement>(
      "#attachSelectedAudioButton",
    );
    assert.equal(sourceButton?.disabled, true);
    assert.equal(
      sourceButton?.getAttribute("aria-label"),
      "Attaching selected Live audio…",
    );
    assert.match(sourceButton?.textContent ?? "", /Attach selected Live audio/);
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      true,
    );
    harness.releaseHeldCommand();
    await harness.settle();
    assert.equal(sourceButton?.disabled, false);
    assert.equal(sourceButton?.getAttribute("aria-label"), "Attach selected Live audio source");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("audio-bearing Send requires verified OpenAI Chat audio input but not tools", async () => {
  const unsupportedState = stateFixture();
  unsupportedState.pendingAttachments = [pendingAudio("audio-1", "idea.wav")];
  unsupportedState.runtimeProfile!.inputCapabilityEvidence.audio = "unsupported";
  const unsupportedHarness = await createDialogHarness(unsupportedState);
  try {
    unsupportedHarness.input("#prompt", "Describe this sound");
    unsupportedHarness.click("#sendButton");
    await unsupportedHarness.settle();
    assert.equal(unsupportedHarness.calls.some((call) => call.path === "/send"), false);
    assert.match(
      unsupportedHarness.document.querySelector("#status")?.textContent ?? "",
      /does not support audio input/i,
    );
  } finally {
    unsupportedHarness.close();
  }

  const capableState = audioCapableState();
  capableState.pendingAttachments = [pendingAudio("audio-1", "idea.wav")];
  capableState.runtimeProfile!.capabilities.tools = false;
  const capableHarness = await createDialogHarness(capableState);
  try {
    capableHarness.input("#prompt", "Describe this sound");
    capableHarness.click("#sendButton");
    await capableHarness.settle();
    assert.equal(capableHarness.calls.some((call) => call.path === "/send"), true);
  } finally {
    capableHarness.close();
  }

  const wrongModeState = audioCapableState();
  wrongModeState.pendingAttachments = [pendingAudio("audio-1", "idea.wav")];
  wrongModeState.runtimeProfile!.profile.apiMode = "responses";
  const wrongModeHarness = await createDialogHarness(wrongModeState);
  try {
    wrongModeHarness.input("#prompt", "Describe this sound");
    wrongModeHarness.click("#sendButton");
    await wrongModeHarness.settle();
    assert.equal(wrongModeHarness.calls.some((call) => call.path === "/send"), false);
    assert.match(
      wrongModeHarness.document.querySelector("#status")?.textContent ?? "",
      /OpenAI Chat Completions.*verified audio input/i,
    );
  } finally {
    wrongModeHarness.close();
  }
});

test("audio count and per-kind pending limits are enforced before upload", async () => {
  const audioState = stateFixture();
  audioState.pendingAttachments = [
    pendingAudio("audio-1", "one.wav", "audio/wav", 1),
    pendingAudio("audio-2", "two.mp3", "audio/mpeg", 1),
  ];
  const audioHarness = await createDialogHarness(audioState);
  try {
    audioHarness.dispatchDrop([audioFile(audioHarness.window, "three.wav", "audio/wav")]);
    await audioHarness.settle();
    assert.equal(audioHarness.calls.some((call) => call.path === "/attachments"), false);
    assert.match(audioHarness.document.querySelector("#status")?.textContent ?? "", /at most 2 pending audio files/i);
  } finally {
    audioHarness.close();
  }

  const documentState = stateFixture();
  documentState.pendingAttachments = [pendingDocument(
    "document-1",
    "large.pdf",
    "application/pdf",
    15 * 1024 * 1024,
  )];
  const documentHarness = await createDialogHarness(documentState);
  try {
    documentHarness.dispatchDrop([
      documentFile(documentHarness.window, "another.pdf", "application/pdf", 5 * 1024 * 1024 + 1),
    ]);
    await documentHarness.settle();
    assert.equal(documentHarness.calls.some((call) => call.path === "/attachments"), false);
    assert.match(documentHarness.document.querySelector("#status")?.textContent ?? "", /pending documents would exceed 20 MiB/i);
  } finally {
    documentHarness.close();
  }
});

test("audio local preflight accepts 20 MiB and 30 MiB mixed totals exactly", async () => {
  const perFileHarness = await createDialogHarness();
  try {
    perFileHarness.dispatchDrop([
      audioFile(
        perFileHarness.window,
        "exact.wav",
        "audio/wav",
        20 * 1024 * 1024,
      ),
      audioFile(
        perFileHarness.window,
        "over.mp3",
        "audio/mpeg",
        20 * 1024 * 1024 + 1,
      ),
    ]);
    await perFileHarness.settleAttachmentOperation();
    assert.deepEqual(
      perFileHarness.calls
        .filter((call) => call.path === "/attachments")
        .map((call) => new URL(call.url).searchParams.get("fileName")),
      ["exact.wav"],
    );
    assert.match(
      perFileHarness.document.querySelector("#status")?.textContent ?? "",
      /over\.mp3.*larger than 20 MiB/i,
    );
  } finally {
    perFileHarness.close();
  }

  const exactState = imageCapableState();
  exactState.pendingAttachments = [
    pendingImage("image-1", "reference.png", "image/png", 5 * 1024 * 1024),
    pendingDocument(
      "document-1",
      "score.pdf",
      "application/pdf",
      20 * 1024 * 1024,
    ),
  ];
  const exactHarness = await createDialogHarness(exactState);
  try {
    exactHarness.dispatchDrop([
      audioFile(exactHarness.window, "exact-total.wav", "audio/wav", 5 * 1024 * 1024),
      audioFile(exactHarness.window, "over-total.wav", "audio/wav", 1),
    ]);
    await exactHarness.settleAttachmentOperation();
    assert.deepEqual(
      exactHarness.calls
        .filter((call) => call.path === "/attachments")
        .map((call) => new URL(call.url).searchParams.get("fileName")),
      ["exact-total.wav"],
    );
    assert.match(
      exactHarness.document.querySelector("#status")?.textContent ?? "",
      /over-total\.wav.*exceed 30 MiB/i,
    );
  } finally {
    exactHarness.close();
  }
});

test("document drop paths accept MIME hints or extensions without image capability", async () => {
  const state = stateFixture();
  state.runtimeProfile!.inputCapabilityEvidence.image = "unsupported";
  const harness = await createDialogHarness(state);
  try {
    const docxWithoutMime = documentFile(
      harness.window,
      "arrangement.docx",
      "",
    );
    const pdf = documentFile(
      harness.window,
      "score.pdf",
      "application/pdf",
    );
    const image = imageFile(harness.window, "blocked.png", "image/png");
    assert.equal(harness.dispatchDrop([image, docxWithoutMime, pdf]), true);
    await harness.settleAttachmentOperation();
    assert.deepEqual(
      harness.calls
        .filter((call) => call.path === "/attachments")
        .map((call) => new URL(call.url).searchParams.get("fileName")),
      ["arrangement.docx", "score.pdf"],
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /blocked\.png.*does not support image input/i,
    );

    harness.dropAttachmentFiles([
      documentFile(
        harness.window,
        "data.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
      documentFile(harness.window, "deck.pptx", ""),
    ]);
    await harness.settleAttachmentOperation();
    assert.equal(
      harness.document.querySelectorAll(
        "#pendingAttachments [data-attachment-id]",
      ).length,
      4,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("known supported extensions determine local kind before conflicting MIME hints", async () => {
  const state = stateFixture();
  state.runtimeProfile!.inputCapabilityEvidence.image = "unsupported";
  const harness = await createDialogHarness(state);
  try {
    assert.equal(harness.dispatchDrop([
      documentFile(harness.window, "score.docx", "image/png"),
      documentFile(harness.window, "cover.png", "application/pdf"),
    ]), true);
    await harness.settleAttachmentOperation();

    assert.deepEqual(
      harness.calls
        .filter((call) => call.path === "/attachments")
        .map((call) => new URL(call.url).searchParams.get("fileName")),
      ["score.docx"],
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /cover\.png.*does not support image input/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("PDF Send uses the active saved runtime mode and verified PDF evidence", async () => {
  const state = stateFixture();
  state.pendingAttachments = [pendingDocument(
    "attachment-pdf",
    "score.pdf",
    "application/pdf",
  )];
  state.runtimeProfile!.capabilities.inputs.pdf = true;
  state.runtimeProfile!.inputCapabilityEvidence.pdf = "supported";
  state.settings.profiles[1] = profileFixture({
    id: "profile-2",
    name: "PDF review",
    connection: {
      kind: "direct-api",
      apiFamily: "anthropic",
      apiMode: "messages",
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
    },
    model: "pdf-capable-model",
  });
  const harness = await createDialogHarness(state);
  try {
    harness.input("#prompt", "Review the PDF");
    harness.click("#sendButton");
    await harness.settle();
    assert.equal(
      harness.calls.some((call) => call.path === "/send"),
      false,
    );
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "PDF attachments require verified PDF input support with OpenAI Responses or Anthropic Messages. Remove the attached PDFs or activate a compatible saved Profile.",
    );

    harness.select("#profileSelector", "profile-2");
    await harness.settle();
    harness.click("#sendButton");
    await harness.settle();
    assert.equal(
      harness.calls.filter((call) => call.path === "/send").length,
      1,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("OOXML Send is independent of model image and PDF capabilities", async () => {
  const state = stateFixture();
  state.runtimeProfile!.inputCapabilityEvidence.image = "unsupported";
  state.runtimeProfile!.inputCapabilityEvidence.pdf = "unsupported";
  state.pendingAttachments = [pendingDocument(
    "attachment-docx",
    "notes.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  )];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#prompt", "Summarize the document");
    harness.click("#sendButton");
    await harness.settle();
    assert.equal(
      harness.calls.filter((call) => call.path === "/send").length,
      1,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("document local preflight accepts exactly 20 MiB and rejects one byte over", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
    harness.dropAttachmentFiles([
      documentFile(harness.window, "exact.pdf", "application/pdf", 20 * 1024 * 1024),
      documentFile(
        harness.window,
        "over.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        20 * 1024 * 1024 + 1,
      ),
    ]);
    await harness.settleAttachmentOperation();
    assert.deepEqual(
      harness.calls
        .filter((call) => call.path === "/attachments")
        .map((call) => new URL(call.url).searchParams.get("fileName")),
      ["exact.pdf"],
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /over\.docx.*larger than 20 MiB/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("document rejection messages are fixed while valid files in the batch remain", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
    harness.failAttachmentNamed(
      "encrypted.docx",
      "Encrypted Office documents are not supported.",
      400,
    );
    harness.dropAttachmentFiles([
      documentFile(harness.window, "macro.docm", "", 24),
      documentFile(harness.window, "legacy.doc", "", 24),
      documentFile(harness.window, "unknown.zip", "application/zip", 24),
      documentFile(harness.window, "encrypted.docx", "", 24),
      documentFile(harness.window, "kept.pdf", "application/pdf", 24),
    ]);
    await harness.settleAttachmentOperation();

    assert.deepEqual(
      harness.calls
        .filter((call) => call.path === "/attachments")
        .map((call) => new URL(call.url).searchParams.get("fileName")),
      ["encrypted.docx", "kept.pdf"],
    );
    const status = harness.document.querySelector("#status")?.textContent ?? "";
    assert.match(status, /macro\.docm: macro-enabled Office documents are not supported/i);
    assert.match(status, /legacy\.doc: legacy Office files are not supported/i);
    assert.match(status, /unknown\.zip: only PNG, JPEG, WebP, PDF, DOCX, XLSX, PPTX, WAV, and MP3/i);
    assert.match(status, /encrypted\.docx: Encrypted Office documents are not supported\./);
    assert.match(
      harness.document.querySelector("#pendingAttachments")?.textContent ?? "",
      /kept\.pdf/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a rejected-only document drop is intercepted and reports every fixed classification", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
    assert.equal(harness.dispatchDrop([
      documentFile(harness.window, "macro.docm", ""),
      documentFile(harness.window, "legacy.doc", ""),
      documentFile(harness.window, "unknown.zip", "application/zip"),
    ]), true);
    await harness.settle();

    assert.equal(
      harness.calls.some((call) => call.path === "/attachments"),
      false,
    );
    const status = harness.document.querySelector("#status")?.textContent ?? "";
    assert.match(status, /macro\.docm: macro-enabled Office documents are not supported/i);
    assert.match(status, /legacy\.doc: legacy Office files are not supported/i);
    assert.match(status, /unknown\.zip: only PNG, JPEG, WebP, PDF, DOCX, XLSX, PPTX, WAV, and MP3/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an unsupported image drop is intercepted and reports its fixed capability reason", async () => {
  const state = stateFixture();
  state.runtimeProfile!.inputCapabilityEvidence.image = "unsupported";
  const harness = await createDialogHarness(state);
  try {
    const image = imageFile(harness.window, "unsupported.png", "image/png");
    assert.equal(harness.dispatchDragOver([image]), true);
    assert.equal(harness.dispatchDrop([image]), true);
    await harness.settle();

    assert.equal(
      harness.calls.some((call) => call.path === "/attachments"),
      false,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /unsupported\.png.*active model does not support image input/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a rejected image paste reports its reason without intercepting accompanying text", async () => {
  const state = stateFixture();
  state.runtimeProfile!.inputCapabilityEvidence.image = "unsupported";
  const harness = await createDialogHarness(state);
  try {
    const image = imageFile(harness.window, "pasted.png", "image/png");
    assert.equal(harness.dispatchPaste([image], "Pasted text"), false);
    await harness.settle();

    assert.equal(
      harness.calls.some((call) => call.path === "/attachments"),
      false,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /pasted\.png.*active model does not support image input/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("paste attaches supported documents alongside images in a mixed batch", async () => {
  const harness = await createDialogHarness(imageCapableState());
  try {
    const png = imageFile(harness.window, "reference.png", "image/png");
    const pdf = new harness.window.File([new Uint8Array(24)], "notes.pdf", {
      type: "application/pdf",
    });

    assert.equal(harness.dispatchPaste([pdf, png]), true);
    await harness.settleAttachmentOperation();
    assert.deepEqual(
      harness.calls
        .filter((call) => call.path === "/attachments")
        .map((call) => new URL(call.url).searchParams.get("fileName")),
      ["notes.pdf", "reference.png"],
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a pasted image uploads once and renders a removable attachment chip", async () => {
  const harness = await createDialogHarness(imageCapableState());
  try {
    const file = imageFile(harness.window, "reference.png", "image/png");
    assert.equal(harness.dispatchPaste([file]), true);
    await harness.settleAttachmentOperation();

    const uploads = harness.calls.filter((call) => call.path === "/attachments");
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]?.body, file);
    assert.match(uploads[0]?.url ?? "", /sessionId=session-1/);
    const chip = harness.document.querySelector<HTMLElement>(
      '[data-attachment-id="attachment-1"]',
    );
    assert.match(chip?.textContent ?? "", /reference\.png/);
    assert.match(chip?.textContent ?? "", /24 B/);

    chip?.querySelector<HTMLButtonElement>("button")?.click();
    await harness.settleAttachmentOperation();
    assert.equal(
      harness.calls.some((call) => call.path === "/attachments/attachment-1"),
      true,
    );
    assert.equal(
      harness.document.querySelector('[data-attachment-id="attachment-1"]'),
      null,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("dropped JPEG, PDF, and WebP files upload serially", async () => {
  const harness = await createDialogHarness(imageCapableState());
  try {
    const pdf = new harness.window.File([new Uint8Array(24)], "notes.pdf", {
      type: "application/pdf",
    });
    const files = [
      imageFile(harness.window, "photo.jpg", "image/jpeg"),
      pdf,
      imageFile(harness.window, "spectrum.webp", "image/webp"),
    ];
    assert.equal(harness.dispatchDragOver(files), true);
    assert.equal(harness.document.querySelector(".composer")?.classList.contains(
      "drop-target",
    ), true);
    assert.equal(harness.dispatchDrop(files), true);
    await harness.settleAttachmentOperation();
    assert.equal(
      harness.calls.filter((call) => call.path === "/attachments").length,
      3,
    );
    assert.equal(
      harness.document.querySelectorAll("#pendingAttachments [data-attachment-id]").length,
      3,
    );

    assert.equal(harness.dispatchDrop([pdf]), true);
    await harness.settleAttachmentOperation();
    assert.equal(
      harness.calls.filter((call) => call.path === "/attachments").length,
      4,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("dropped attachment files use the same serialized upload path", async () => {
  const harness = await createDialogHarness(imageCapableState());
  try {
    const file = imageFile(harness.window, "picked.png", "image/png");
    harness.dropAttachmentFiles([file]);
    await harness.settleAttachmentOperation();
    const upload = harness.calls.find((call) => call.path === "/attachments");
    assert.equal(upload?.body, file);
    assert.match(
      harness.document.querySelector("#pendingAttachments")?.textContent ?? "",
      /picked\.png/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("one failed image upload does not skip later files and names the retry target", async () => {
  const harness = await createDialogHarness(imageCapableState());
  try {
    harness.failAttachmentNamed("broken.png", "Image validation failed.");
    harness.dropAttachmentFiles([
      imageFile(harness.window, "broken.png", "image/png"),
      imageFile(harness.window, "kept.png", "image/png"),
    ]);
    await harness.settleAttachmentOperation();

    assert.deepEqual(
      harness.calls
        .filter((call) => call.path === "/attachments")
        .map((call) => new URL(call.url).searchParams.get("fileName")),
      ["broken.png", "kept.png"],
    );
    assert.match(
      harness.document.querySelector("#pendingAttachments")?.textContent ?? "",
      /kept\.png/,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /broken\.png.*re-select.*retry/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an attachment conflict is retryable rather than a policy rejection", async () => {
  const harness = await createDialogHarness(imageCapableState());
  try {
    harness.failAttachmentNamed(
      "busy.png",
      "Attachment state changed concurrently.",
      409,
    );
    harness.dropAttachmentFiles([
      imageFile(harness.window, "busy.png", "image/png"),
    ]);
    await harness.settleAttachmentOperation();

    const status = harness.document.querySelector("#status")?.textContent ?? "";
    assert.match(status, /retryable.*busy\.png.*re-select.*retry/i);
    assert.doesNotMatch(status, /resolve the stated requirement/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("attachment count and total limits reject locally before network traffic", async () => {
  const state = imageCapableState();
  state.pendingAttachments = [
    pendingImage("attachment-1", "one.png", "image/png", 5 * 1024 * 1024),
    pendingImage("attachment-2", "two.png", "image/png", 5 * 1024 * 1024),
    pendingImage("attachment-3", "three.png", "image/png", 5 * 1024 * 1024),
  ];
  const harness = await createDialogHarness(state);
  try {
    harness.dispatchDrop([
      imageFile(harness.window, "over-total.png", "image/png", 2 * 1024 * 1024),
    ]);
    await harness.settle();
    assert.equal(
      harness.calls.some((call) => call.path === "/attachments"),
      false,
    );
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /16 MiB/i);

    state.pendingAttachments.push(
      pendingImage("attachment-4", "four.png", "image/png", 1),
    );
    const countHarness = await createDialogHarness(state);
    try {
      countHarness.dispatchDrop([
        imageFile(countHarness.window, "over-count.png", "image/png"),
      ]);
      await countHarness.settle();
      assert.equal(
        countHarness.calls.some((call) => call.path === "/attachments"),
        false,
      );
      assert.match(
        countHarness.document.querySelector("#status")?.textContent ?? "",
        /at most 4 pending files/i,
      );
      assert.deepEqual(countHarness.errors, []);
    } finally {
      countHarness.close();
    }
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("attachment limits accept exact 5 MiB, 4-image, and 16 MiB boundaries", async () => {
  const perFileHarness = await createDialogHarness(imageCapableState());
  try {
    perFileHarness.dispatchDrop([
      imageFile(
        perFileHarness.window,
        "exact-five.png",
        "image/png",
        5 * 1024 * 1024,
      ),
      imageFile(
        perFileHarness.window,
        "over-five.png",
        "image/png",
        5 * 1024 * 1024 + 1,
      ),
    ]);
    await perFileHarness.settleAttachmentOperation();
    assert.deepEqual(
      perFileHarness.calls
        .filter((call) => call.path === "/attachments")
        .map((call) => new URL(call.url).searchParams.get("fileName")),
      ["exact-five.png"],
    );
    assert.match(
      perFileHarness.document.querySelector("#status")?.textContent ?? "",
      /over-five\.png.*larger than 5 MiB/i,
    );
    assert.doesNotMatch(
      perFileHarness.document.querySelector("#status")?.textContent ?? "",
      /re-select|retry/i,
    );
  } finally {
    perFileHarness.close();
  }

  const countState = imageCapableState();
  countState.pendingAttachments = [
    pendingImage("attachment-1", "one.png", "image/png", 1),
    pendingImage("attachment-2", "two.png", "image/png", 1),
    pendingImage("attachment-3", "three.png", "image/png", 1),
  ];
  const countHarness = await createDialogHarness(countState);
  try {
    countHarness.dispatchDrop([
      imageFile(countHarness.window, "four.png", "image/png", 1),
      imageFile(countHarness.window, "five.png", "image/png", 1),
    ]);
    await countHarness.settleAttachmentOperation();
    assert.deepEqual(
      countHarness.calls
        .filter((call) => call.path === "/attachments")
        .map((call) => new URL(call.url).searchParams.get("fileName")),
      ["four.png"],
    );
    assert.equal(
      countHarness.document.querySelectorAll(
        "#pendingAttachments [data-attachment-id]",
      ).length,
      4,
    );
  } finally {
    countHarness.close();
  }

  const totalState = imageCapableState();
  totalState.pendingAttachments = [
    pendingImage("attachment-1", "existing.png", "image/png", 5 * 1024 * 1024),
  ];
  const totalHarness = await createDialogHarness(totalState);
  try {
    totalHarness.dispatchDrop([
      imageFile(totalHarness.window, "five-a.png", "image/png", 5 * 1024 * 1024),
      imageFile(totalHarness.window, "five-b.png", "image/png", 5 * 1024 * 1024),
      imageFile(totalHarness.window, "exact-sixteen.png", "image/png", 1024 * 1024),
    ]);
    await totalHarness.settleAttachmentOperation();
    assert.equal(
      totalHarness.calls.filter((call) => call.path === "/attachments").length,
      3,
    );
    assert.equal(
      totalHarness.document.querySelectorAll(
        "#pendingAttachments [data-attachment-id]",
      ).length,
      4,
    );
  } finally {
    totalHarness.close();
  }

  const overTotalState = imageCapableState();
  overTotalState.pendingAttachments = [
    pendingImage("attachment-1", "existing.png", "image/png", 5 * 1024 * 1024),
  ];
  const overTotalHarness = await createDialogHarness(overTotalState);
  try {
    overTotalHarness.dispatchDrop([
      imageFile(overTotalHarness.window, "five-a.png", "image/png", 5 * 1024 * 1024),
      imageFile(overTotalHarness.window, "five-b.png", "image/png", 5 * 1024 * 1024),
      imageFile(
        overTotalHarness.window,
        "over-sixteen.png",
        "image/png",
        1024 * 1024 + 1,
      ),
    ]);
    await overTotalHarness.settleAttachmentOperation();
    assert.equal(
      overTotalHarness.calls.filter((call) => call.path === "/attachments").length,
      2,
    );
    assert.match(
      overTotalHarness.document.querySelector("#status")?.textContent ?? "",
      /over-sixteen\.png.*exceed 16 MiB/i,
    );
  } finally {
    overTotalHarness.close();
  }
});

test("Send and Session controls stay disabled while an attachment upload is in flight", async () => {
  const harness = await createDialogHarness(imageCapableState());
  try {
    harness.holdNextAttachment();
    harness.dispatchPaste([
      imageFile(harness.window, "slow.png", "image/png"),
    ]);
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#newSessionButton")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector("#pendingAttachments")?.getAttribute("aria-busy"),
      "true",
    );
    assert.equal(
      harness.document.querySelector(".composer")?.hasAttribute("aria-busy"),
      false,
    );
    harness.releaseHeldAttachment();
    await harness.settleAttachmentOperation();
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("attachment chips reconcile after an unknown upload response before controls unlock", async () => {
  const harness = await createDialogHarness(imageCapableState());
  try {
    harness.rejectNextAttachmentAfterCommit("connection lost");
    harness.dispatchPaste([
      imageFile(harness.window, "uncertain.png", "image/png"),
    ]);
    await harness.settleAttachmentOperation();
    assert.equal(
      harness.calls.some((call) => call.path === "/state"),
      true,
    );
    assert.match(
      harness.document.querySelector("#pendingAttachments")?.textContent ?? "",
      /uncertain\.png/,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /confirmed attached.*do not upload/i,
    );
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /re-select|retry/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a committed attachment upload with truncated JSON reconciles as an unknown result", async () => {
  const harness = await createDialogHarness(imageCapableState());
  try {
    harness.truncateNextAttachmentResponseAfterCommit();
    harness.dispatchPaste([
      imageFile(harness.window, "truncated-response.png", "image/png"),
    ]);
    await harness.settleAttachmentOperation();

    assert.deepEqual(
      harness.calls.map((call) => call.path),
      ["/attachments", "/state"],
    );
    assert.match(
      harness.document.querySelector("#pendingAttachments")?.textContent ?? "",
      /truncated-response\.png/,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /confirmed attached.*do not upload/i,
    );
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /re-select|retry/i,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

for (const [condition, options] of [
  ["Web Crypto is unavailable", { webCryptoAvailable: false }],
  ["Web Crypto digest fails", { webCryptoDigestFails: true }],
] as const) {
  test(`a network-interrupted committed upload stays uncertain when ${condition}`, async () => {
    const harness = await createDialogHarness(
      imageCapableState(),
      { baseUrl: "http://bridge.test", token: "test-token" },
      options,
    );
    try {
      harness.rejectNextAttachmentAfterCommit("connection lost");
      harness.dispatchPaste([
        imageFile(harness.window, "network-unknown.png", "image/png"),
      ]);
      await harness.settleAttachmentOperation();

      assert.match(
        harness.document.querySelector("#pendingAttachments")?.textContent ?? "",
        /network-unknown\.png/,
      );
      const status = harness.document.querySelector("#status")?.textContent ?? "";
      assert.match(status, /unconfirmed.*verify/i);
      assert.doesNotMatch(
        status,
        /confirmed attached|re-select|retry/i,
      );
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}

test("a typed unknown attachment outcome applies its authoritative state", async () => {
  const harness = await createDialogHarness(imageCapableState());
  try {
    harness.failNextAttachmentUnknown("upload commit could not be confirmed");
    harness.dispatchPaste([
      imageFile(harness.window, "typed-unknown.png", "image/png"),
    ]);
    await harness.settleAttachmentOperation();
    assert.match(
      harness.document.querySelector("#pendingAttachments")?.textContent ?? "",
      /typed-unknown\.png/,
    );
    assert.equal(
      harness.calls.some((call) => call.path === "/state"),
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /confirmed attached.*do not upload/i,
    );
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /re-select|retry/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("unknown attachment confirmation ignores normalized names and claimed MIME", async () => {
  const harness = await createDialogHarness(imageCapableState());
  try {
    const leafName = `${"x".repeat(120)}.jpg`;
    const browserName = `private\\${"x".repeat(120)}\u0007.jpg`;
    harness.failNextAttachmentUnknown(
      "upload commit could not be confirmed",
      { fileName: leafName, mediaType: "image/png" },
    );
    harness.dispatchPaste([
      imageFile(harness.window, browserName, "image/jpeg"),
    ]);
    await harness.settleAttachmentOperation();

    assert.match(
      harness.document.querySelector("#pendingAttachments")?.textContent ?? "",
      new RegExp(`${"x".repeat(40)}.*\\.jpg`),
    );
    const status = harness.document.querySelector("#status")?.textContent ?? "";
    assert.match(status, /confirmed attached.*do not upload/i);
    assert.doesNotMatch(status, /unconfirmed|re-select|retry/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("same-name same-size unknown upload is not confirmed when content hashes differ", async () => {
  const harness = await createDialogHarness(imageCapableState());
  try {
    harness.failNextAttachmentUnknown(
      "upload commit could not be confirmed",
      { sha256: "b".repeat(64) },
    );
    harness.dispatchPaste([
      imageFile(harness.window, "same-name.png", "image/png"),
    ]);
    await harness.settleAttachmentOperation();

    const status = harness.document.querySelector("#status")?.textContent ?? "";
    assert.match(status, /unconfirmed.*verify/i);
    assert.doesNotMatch(status, /confirmed attached|do not upload those files/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("unknown upload stays unconfirmed when Web Crypto is unavailable", async () => {
  const harness = await createDialogHarness(
    imageCapableState(),
    { baseUrl: "http://bridge.test", token: "test-token" },
    { webCryptoAvailable: false },
  );
  try {
    harness.failNextAttachmentUnknown("upload commit could not be confirmed");
    harness.dispatchPaste([
      imageFile(harness.window, "no-web-crypto.png", "image/png"),
    ]);
    await harness.settleAttachmentOperation();

    const status = harness.document.querySelector("#status")?.textContent ?? "";
    assert.match(status, /unconfirmed.*verify/i);
    assert.doesNotMatch(status, /confirmed attached|do not upload those files/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Session switching renders only the active Session attachment chips", async () => {
  const harness = await createDialogHarness(imageCapableState());
  try {
    harness.dispatchPaste([
      imageFile(harness.window, "bass.png", "image/png"),
    ]);
    await harness.settleAttachmentOperation();
    const leadRow = [...harness.document.querySelectorAll<HTMLButtonElement>(
      ".session-row",
    )].find((row) => row.textContent?.includes("Lead session"));
    assert.ok(leadRow);
    leadRow.click();
    await harness.settle();
    assert.equal(
      harness.document.querySelectorAll("#pendingAttachments [data-attachment-id]").length,
      0,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a wire-projected timeline attachment chip renders inert filename metadata", async () => {
  const state = stateFixture();
  state.events = [{
    id: "event-image",
    createdAt: "2026-08-01T00:00:00.000Z",
    kind: "user",
    content: "Review this",
    attachments: [pendingImage(
      "attachment-event",
      'C:\\private\\<img src=x onerror="alert(1)">.png',
      "image/png",
      1_536,
    )],
  }];
  const harness = await createDialogHarness(chatDialogStateForWire(state));
  try {
    const chip = harness.document.querySelector<HTMLElement>(
      ".timeline-attachment-chip",
    );
    assert.equal(
      chip?.textContent,
      '<img src=x onerror="alert(1)">.png · PNG · 1.5 KiB',
    );
    assert.equal(chip?.querySelector("img"), null);
    assert.doesNotMatch(chip?.innerHTML ?? "", /base64|data:image/i);
    assert.doesNotMatch(chip?.textContent ?? "", /C:|private/);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("timeline labels native PDFs and extracted Office documents without claiming visual rendering", async () => {
  const state = stateFixture();
  state.events = [{
    id: "event-documents",
    createdAt: "2026-08-01T00:00:00.000Z",
    kind: "user",
    content: "Review these",
    attachments: [
      pendingDocument("attachment-pdf", "score.pdf", "application/pdf", 1_024),
      pendingDocument(
        "attachment-docx",
        "notes.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        2_048,
      ),
      pendingDocument(
        "attachment-xlsx",
        "data.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        3_072,
      ),
      pendingDocument(
        "attachment-pptx",
        "deck.pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        4_096,
      ),
    ],
  }];
  const harness = await createDialogHarness(state);
  try {
    const labels = [...harness.document.querySelectorAll(
      ".timeline-attachment-chip",
    )].map((chip) => chip.textContent);
    assert.deepEqual(labels, [
      "score.pdf · PDF · Native PDF · 1 KiB",
      "notes.docx · DOCX · Extracted document · 2 KiB",
      "data.xlsx · XLSX · Extracted document · 3 KiB",
      "deck.pptx · PPTX · Extracted document · 4 KiB",
    ]);
    assert.doesNotMatch(labels.join(" "), /rendered|preview|vision/i);
    assert.equal(
      harness.document.querySelector(".timeline-attachments")
        ?.getAttribute("aria-label"),
      "File attachments",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("timeline labels consumed audio with authoritative duration and no source-path metadata", async () => {
  const state = stateFixture();
  state.events = [{
    id: "event-audio",
    createdAt: "2026-08-01T00:00:00.000Z",
    kind: "user",
    content: "Listen to these",
    attachments: [
      pendingAudio("audio-wav", "take.wav", "audio/wav", 1_024, 83.25),
      pendingAudio("audio-mp3", "reference.mp3", "audio/mpeg", 2_048, 1.5),
    ],
  }];
  const harness = await createDialogHarness(state);
  try {
    const labels = [...harness.document.querySelectorAll(
      ".timeline-attachment-chip",
    )].map((chip) => chip.textContent);
    assert.deepEqual(labels, [
      "take.wav · WAV · 1:23.3 · 1 KiB",
      "reference.mp3 · MP3 · 1.5 s · 2 KiB",
    ]);
    assert.doesNotMatch(labels.join(" "), /private|path|sampleRate|channels|base64/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("the compact attachment menu stays available while image capability gates only images", async () => {
  const supportedHarness = await createDialogHarness(imageCapableState());
  try {
    assert.equal(
      supportedHarness.document.querySelector<HTMLButtonElement>(
        "#attachmentMenuButton",
      )?.disabled,
      false,
    );
    assert.equal(supportedHarness.document.querySelector("#attachmentInput"), null);
  } finally {
    supportedHarness.close();
  }

  const unsupportedState = stateFixture();
  unsupportedState.runtimeProfile!.inputCapabilityEvidence.image = "unsupported";
  const unsupportedHarness = await createDialogHarness(unsupportedState);
  try {
    const attach = unsupportedHarness.document.querySelector<HTMLButtonElement>(
      "#attachmentMenuButton",
    );
    assert.equal(attach?.disabled, false);
    assert.match(attach?.title ?? "", /does not support image input/i);
    assert.equal(
      unsupportedHarness.document.querySelector<HTMLButtonElement>("#sendButton")
        ?.disabled,
      false,
    );
    const unsupportedImage = imageFile(
      unsupportedHarness.window,
      "unsupported.png",
      "image/png",
    );
    assert.equal(unsupportedHarness.dispatchPaste([unsupportedImage], "Pasted text"), false);
    assert.equal(unsupportedHarness.dispatchDragOver([unsupportedImage]), true);
    assert.equal(unsupportedHarness.dispatchDrop([unsupportedImage]), true);
    await unsupportedHarness.settle();
    assert.equal(
      unsupportedHarness.calls.some((call) => call.path === "/attachments"),
      false,
    );
  } finally {
    unsupportedHarness.close();
  }

  const unverifiedState = stateFixture();
  unverifiedState.pendingAttachments = [
    pendingImage("attachment-unverified", "remove-me.png"),
  ];
  const unverifiedHarness = await createDialogHarness(unverifiedState);
  try {
    const attach = unverifiedHarness.document.querySelector<HTMLButtonElement>(
      "#attachmentMenuButton",
    );
    assert.equal(attach?.disabled, false);
    assert.match(attach?.title ?? "", /unverified/i);
    const unverifiedImage = imageFile(
      unverifiedHarness.window,
      "unverified.png",
      "image/png",
    );
    assert.equal(unverifiedHarness.dispatchPaste([unverifiedImage], "Pasted text"), false);
    assert.equal(unverifiedHarness.dispatchDrop([unverifiedImage]), true);
    const remove = unverifiedHarness.document.querySelector<HTMLButtonElement>(
      '[data-attachment-id="attachment-unverified"] button',
    );
    assert.equal(remove?.disabled, false);
    remove?.click();
    await unverifiedHarness.settle();
    assert.equal(
      unverifiedHarness.document.querySelector(
        '[data-attachment-id="attachment-unverified"]',
      ),
      null,
    );
  } finally {
    unverifiedHarness.close();
  }
});

test("a text-only runtime keeps attachment chips visible but blocks Send precisely", async () => {
  const state = stateFixture();
  state.pendingAttachments = [pendingImage("attachment-text-only", "score.png")];
  state.capabilities.inputs.image = true;
  state.capabilityEvidence.inputs.image = "supported";
  state.runtimeProfile!.capabilities.inputs.image = false;
  state.runtimeProfile!.inputCapabilityEvidence.image = "unsupported";
  const harness = await createDialogHarness(state);
  try {
    assert.match(
      harness.document.querySelector("#pendingAttachments")?.textContent ?? "",
      /score\.png/,
    );
    harness.input("#prompt", "Review this score");
    harness.click("#sendButton");
    await harness.settle();
    assert.equal(harness.calls.some((call) => call.path === "/send"), false);
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /active model does not support image input/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("unverified attachment guidance separates subscription model reloads from Direct API overrides", async () => {
  const cases = [
    {
      attachment: pendingImage("attachment-unverified", "score.png"),
      capability: "image",
      prompt: "Review this score",
      removeGuidance: /remove the attached images/i,
      overrideGuidance: /explicit image-input override/i,
    },
    {
      attachment: pendingAudio("audio-unverified", "mix.wav"),
      capability: "audio",
      prompt: "Review this mix",
      removeGuidance: /remove the attached audio/i,
      overrideGuidance: /explicit audio-input override/i,
    },
  ] as const;

  for (const entry of cases) {
    const directState = stateFixture();
    directState.pendingAttachments = [entry.attachment];
    const directHarness = await createDialogHarness(directState);
    try {
      directHarness.input("#prompt", entry.prompt);
      directHarness.click("#sendButton");
      await directHarness.settle();
      assert.equal(
        directHarness.calls.some((call) => call.path === "/send"),
        false,
        `Direct API ${entry.capability} should remain gated`,
      );
      assert.match(
        directHarness.document.querySelector("#status")?.textContent ?? "",
        entry.overrideGuidance,
      );
      assert.deepEqual(directHarness.errors, []);
    } finally {
      directHarness.close();
    }

    const subscriptionState = stateFixture();
    const subscriptionProfile = profileFixture({
      connection: { kind: "codex-subscription", provider: "openai" },
      parameters: {
        reasoning: { mode: "default" },
      },
      advanced: {},
    });
    subscriptionState.settings.profiles = [subscriptionProfile];
    subscriptionState.settings.activeProfileId = subscriptionProfile.id;
    subscriptionState.modelStateSource = modelStateSourceFixture(subscriptionProfile);
    subscriptionState.runtimeProfile!.profile.connectionKind = "codex-subscription";
    subscriptionState.runtimeProfile!.profile.apiMode = null;
    subscriptionState.codexAuth = {
      status: "signed-in",
      accountLabel: "studio@example.test",
      planType: "pro",
      subscriptionEligible: true,
    };
    subscriptionState.pendingAttachments = [entry.attachment];
    const subscriptionHarness = await createDialogHarness(subscriptionState);
    try {
      assert.equal(
        subscriptionHarness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
        false,
      );
      subscriptionHarness.input("#prompt", entry.prompt);
      subscriptionHarness.click("#sendButton");
      await subscriptionHarness.settle();
      assert.equal(
        subscriptionHarness.calls.some((call) => call.path === "/send"),
        false,
        `Subscription ${entry.capability} should remain gated`,
      );
      const status = subscriptionHarness.document.querySelector("#status")?.textContent ?? "";
      assert.match(status, entry.removeGuidance);
      assert.match(status, /reload the model list/i);
      assert.match(
        status,
        new RegExp(`select a model with verified ${entry.capability} input support`, "i"),
      );
      assert.doesNotMatch(status, /override/i);
      assert.deepEqual(subscriptionHarness.errors, []);
    } finally {
      subscriptionHarness.close();
    }
  }
});

test("session actions send only their command-specific fields", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#newSessionButton");
    await harness.settle();

    const leadRow = [...harness.document.querySelectorAll<HTMLButtonElement>(".session-row")]
      .find((row) => row.textContent?.includes("Lead session"));
    assert.ok(leadRow);
    leadRow.click();
    await harness.settle();

    const leadTitle = [...harness.document.querySelectorAll<HTMLElement>(".session-title")]
      .find((title) => title.textContent === "Lead session");
    assert.ok(leadTitle);
    leadTitle.dispatchEvent(new harness.window.MouseEvent("dblclick", { bubbles: true }));
    const rename = harness.document.querySelector<HTMLInputElement>(".session-rename-input");
    assert.ok(rename);
    rename.value = "Lead ideas";
    rename.dispatchEvent(new harness.window.Event("blur"));
    await harness.settle();

    harness.click('[data-session-menu-button="session-2"]');
    harness.click('[data-session-id="session-2"] [data-session-action="delete"]');
    harness.click('[data-delete-session-id="session-2"] [data-delete-confirm]');
    await harness.settle();

    assert.deepEqual(commandCalls(harness), [
      { path: "/command", body: { kind: "new_session" } },
      {
        path: "/command",
        body: { kind: "select_session", sessionId: "session-2" },
      },
      {
        path: "/command",
        body: {
          kind: "rename_session",
          sessionId: "session-2",
          title: "Lead ideas",
        },
      },
      {
        path: "/command",
        body: { kind: "delete_session", sessionId: "session-2" },
      },
    ]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("keyboard users can paste Skill Markdown without a native file picker", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
    const install = harness.document.querySelector<HTMLButtonElement>(
      "#installPastedSkillButton",
    );
    assert.equal(
      harness.document.querySelector("#skillPasteText")?.getAttribute("name"),
      "skillMarkdown",
    );
    assert.equal(install?.disabled, true);
    harness.input("#skillPasteText", [
      "---",
      "name: pasted-skill",
      "description: Imported from pasted Markdown",
      "---",
      "Pasted Skill body",
      "",
    ].join("\n"));
    assert.equal(install?.disabled, false);
    harness.click("#installPastedSkillButton");
    await waitForCondition(
      () => harness.calls.some((call) => call.path === "/skills"),
      "Expected pasted Skill install request.",
    );
    await harness.settle();

    const upload = harness.calls.find((call) => call.path === "/skills");
    assert.ok(upload?.body instanceof harness.window.File);
    assert.match(
      harness.document.querySelector("[data-skill-id='pasted-skill']")?.textContent ?? "",
      /Imported from pasted Markdown/,
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#skillPasteText")?.value,
      "",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Skill import, activation, and deletion keep bodies off JSON command paths", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
    const markdown = [
      "---",
      "name: mix-review",
      "description: Review balance and space",
      "---",
      "PRIVATE SKILL BODY",
      "",
    ].join("\n");
    const file = new harness.window.File(
      [markdown],
      "PRIVATE-local-path-name.md",
      { type: "text/markdown" },
    );
    harness.dropSkillFile(file);
    await waitForCondition(
      () => harness.calls.some((call) => call.path === "/skills"),
      "Expected Skill import request.",
    );
    await harness.settle();

    const upload = harness.calls.find((call) => call.path === "/skills");
    assert.ok(upload);
    assert.equal(upload.body, file);
    assert.equal(upload.url.includes("PRIVATE-local-path-name"), false);
    assert.equal(
      (upload.headers as Record<string, string>)["Content-Type"],
      "text/markdown; charset=utf-8",
    );
    assert.match(
      (upload.headers as Record<string, string>)["X-Live-Smith-Command-Id"] ?? "",
      /^[A-Za-z0-9._:-]+$/,
    );
    assert.match(
      harness.document.querySelector("[data-skill-id='mix-review']")?.textContent ?? "",
      /Review balance and space/,
    );
    assert.doesNotMatch(harness.document.body.textContent ?? "", /PRIVATE SKILL BODY/);

    const toggle = harness.document.querySelector<HTMLInputElement>(
      "[data-skill-id='mix-review'] input[type='checkbox']",
    );
    assert.ok(toggle);
    toggle.click();
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_session_skills",
      sessionId: "session-1",
      skillIds: ["mix-review"],
    });
    const deleteButton = harness.document.querySelector<HTMLButtonElement>(
      "[data-skill-id='mix-review'] .skill-delete",
    );
    assert.equal(deleteButton?.disabled, false);
    assert.equal(deleteButton?.textContent, "Disable");
    deleteButton?.click();
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_session_skills",
      sessionId: "session-1",
      skillIds: [],
    });
    const enabledDelete = harness.document.querySelector<HTMLButtonElement>(
      "[data-skill-id='mix-review'] .skill-delete",
    );
    assert.equal(enabledDelete?.disabled, false);
    enabledDelete?.click();
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.ok(harness.calls.some((call) => call.path === "/skills/mix-review"));
    assert.equal(
      harness.calls.filter((call) => call.jsonBody !== undefined)
        .some((call) => JSON.stringify(call.jsonBody).includes("PRIVATE SKILL BODY")),
      false,
    );
  } finally {
    harness.close();
  }
});

test("Skill replacement requires confirmation and retries the same raw file explicitly", async () => {
  const state = stateFixture();
  state.availableSkills = [{ id: "mix-review", description: "Old guidance" }];
  const harness = await createDialogHarness(state);
  try {
    const file = new harness.window.File([
      "---\nname: mix-review\ndescription: New guidance\n---\nNew private body.\n",
    ], "replacement.md", { type: "text/markdown" });
    harness.dropSkillFile(file);
    await harness.acceptAppConfirmation();
    await waitForCondition(
      () => harness.calls.filter((call) => call.path === "/skills").length === 2,
      "Expected confirmed Skill replacement request.",
    );
    await harness.settle();

    const uploads = harness.calls.filter((call) => call.path === "/skills");
    assert.equal(uploads.length, 2);
    assert.match(uploads[0]!.url, /replace=false/);
    assert.match(uploads[1]!.url, /replace=true/);
    assert.equal(uploads[0]!.body, file);
    assert.equal(uploads[1]!.body, file);
    assert.match(
      harness.document.querySelector("[data-skill-id='mix-review']")?.textContent ?? "",
      /New guidance/,
    );
  } finally {
    harness.close();
  }
});

test("a response-lost Skill replacement crosses the state barrier before a new-ID receipt retry", async () => {
  const state = stateFixture();
  state.availableSkills = [{ id: "mix-review", description: "Same summary" }];
  const harness = await createDialogHarness(state);
  try {
    const file = new harness.window.File([
      "---\nname: mix-review\ndescription: Same summary\n---\nReplacement body that differs from the installed Skill.\n",
    ], "replacement.md", { type: "text/markdown" });
    harness.rejectNextSkillResponseAfterCommit("Bridge response was lost.");
    harness.dropSkillFile(file);
    await harness.acceptAppConfirmation();

    await waitForCondition(
      () => harness.calls.filter((call) => call.path === "/skills").length === 3,
      "Expected the interrupted replacement to make one reconciled retry.",
    );
    await harness.settle();

    const paths = harness.calls.map((call) => call.path);
    assert.deepEqual(paths, ["/skills", "/skills", "/state", "/skills"]);
    const replacementCalls = harness.calls.filter(
      (call) => call.path === "/skills" && call.url.includes("replace=true"),
    );
    assert.equal(replacementCalls.length, 2);
    assert.equal(replacementCalls[0]?.body, file);
    assert.equal(replacementCalls[1]?.body, file);
    const firstId = (replacementCalls[0]?.headers as Record<string, string>)[
      "X-Live-Smith-Command-Id"
    ];
    const retryId = (replacementCalls[1]?.headers as Record<string, string>)[
      "X-Live-Smith-Command-Id"
    ];
    assert.match(firstId ?? "", /^[A-Za-z0-9._:-]+$/);
    assert.match(retryId ?? "", /^[A-Za-z0-9._:-]+$/);
    assert.notEqual(retryId, firstId);
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.match(
      harness.document.querySelector("[data-skill-id='mix-review']")?.textContent ?? "",
      /Same summary/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an interrupted Skill retry that cannot confirm a receipt blocks later mutations", async () => {
  const state = stateFixture();
  state.availableSkills = [{ id: "mix-review", description: "Same summary" }];
  const harness = await createDialogHarness(state);
  try {
    const file = new harness.window.File([
      "---\nname: mix-review\ndescription: Same summary\n---\nReplacement body that must be confirmed.\n",
    ], "replacement.md", { type: "text/markdown" });
    harness.rejectNextSkillResponseAfterCommit("Bridge response was lost.");
    harness.rejectNextSkillResponseAfterCommit("Bridge response was lost again.");
    harness.dropSkillFile(file);
    await harness.acceptAppConfirmation();

    await waitForCondition(
      () => harness.calls.filter((call) => call.path === "/skills").length === 3,
      "Expected the unconfirmed replacement to make one reconciled retry.",
    );
    await harness.settle();

    assert.equal(
      harness.calls.filter((call) => call.path === "/skills").length,
      3,
    );
    assert.equal(
      harness.calls.filter((call) => call.path === "/state").length,
      1,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      true,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Skill result is unconfirmed/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a committed Skill delete with truncated JSON reconciles before an idempotent retry", async () => {
  const state = stateFixture();
  state.availableSkills = [{ id: "mix-review", description: "Review balance" }];
  const harness = await createDialogHarness(state);
  try {
    harness.truncateNextSkillResponseAfterCommit();
    const deleteButton = harness.document.querySelector<HTMLButtonElement>(
      "[data-skill-id='mix-review'] .skill-delete",
    );
    assert.equal(deleteButton?.disabled, false);
    deleteButton?.click();
    await harness.acceptAppConfirmation();

    await waitForCondition(
      () => harness.calls.filter(
        (call) => call.path === "/skills/mix-review",
      ).length === 2,
      "Expected the truncated delete response to cross state reconciliation before retrying.",
    );
    await harness.settle();

    assert.deepEqual(
      harness.calls.map((call) => call.path),
      ["/skills/mix-review", "/state", "/skills/mix-review"],
    );
    const deletes = harness.calls.filter(
      (call) => call.path === "/skills/mix-review",
    );
    const firstId = (deletes[0]?.headers as Record<string, string>)[
      "X-Live-Smith-Command-Id"
    ];
    const retryId = (deletes[1]?.headers as Record<string, string>)[
      "X-Live-Smith-Command-Id"
    ];
    assert.match(firstId ?? "", /^[A-Za-z0-9._:-]+$/);
    assert.match(retryId ?? "", /^[A-Za-z0-9._:-]+$/);
    assert.notEqual(retryId, firstId);
    assert.equal(
      harness.document.querySelector("[data-skill-id='mix-review']"),
      null,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Skill autocomplete is accessible and skips numeric IDs and Markdown code", async () => {
  const state = stateFixture();
  state.availableSkills = [
    { id: "mix-review", description: "Review balance" },
    { id: "midi-editor", description: "Edit notes" },
    { id: "4-on-floor", description: "Numeric ID" },
  ];
  const harness = await createDialogHarness(state);
  try {
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
    const listbox = harness.document.querySelector<HTMLElement>("#skillAutocomplete");
    assert.ok(prompt && listbox);
    prompt.focus();
    harness.input("#prompt", "$mi");
    assert.equal(listbox.hidden, false);
    assert.equal(prompt.getAttribute("aria-expanded"), "true");
    assert.deepEqual(
      [...listbox.querySelectorAll("[role='option'] strong")]
        .map((option) => option.textContent),
      ["$midi-editor", "$mix-review"],
    );
    prompt.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    }));
    assert.equal(prompt.value, "$midi-editor ");
    assert.equal(listbox.hidden, true);

    for (const value of [
      "$4",
      "`$mix`",
      "```\n$mix\n```",
      "~~~\n$mix\n~~~",
      "mail $mix@example.com",
      "path $mix/review",
    ]) {
      harness.input("#prompt", value);
      assert.equal(listbox.hidden, true, `Expected no suggestion for ${value}`);
    }

    prompt.value = "$mix-review@example.com";
    prompt.setSelectionRange("$mix-review".length, "$mix-review".length);
    prompt.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
    assert.equal(listbox.hidden, true);

    harness.input("#prompt", "` unmatched $mi");
    assert.equal(listbox.hidden, false);
  } finally {
    harness.close();
  }
});

test("Cmd or Ctrl Enter sends the unchanged prompt instead of accepting a Skill suggestion", async () => {
  const state = stateFixture();
  state.availableSkills = [
    { id: "midi-editor", description: "Edit notes" },
    { id: "mix-review", description: "Review balance" },
  ];
  const harness = await createDialogHarness(state);
  try {
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
    const listbox = harness.document.querySelector<HTMLElement>("#skillAutocomplete");
    assert.ok(prompt && listbox);
    prompt.focus();
    harness.input("#prompt", "$mi");
    assert.equal(listbox.hidden, false);

    prompt.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      metaKey: true,
    }));
    await harness.settle();

    assert.deepEqual(jsonCalls(harness, "/send"), [{
      path: "/send",
      body: { prompt: "$mi", sessionId: state.activeSessionId },
    }]);
  } finally {
    harness.close();
  }
});

test("a Skill can be disabled from archived history before deletion", async () => {
  const state = stateFixture();
  state.availableSkills = [{ id: "history-guide", description: "Historical guidance" }];
  state.archivedSessions = [{
    id: "session-archived",
    title: "Archived mix",
    projectKey: "previous-project",
    scope: { kind: "track", identity: "old-track", label: "Old Track" },
    archivedAt: "2026-08-09T00:00:00.000Z",
    activeSkillIds: ["history-guide"],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  }];
  const harness = await createDialogHarness(state);
  try {
    const disable = harness.document.querySelector<HTMLButtonElement>(
      "[data-skill-id='history-guide'] .skill-delete",
    );
    assert.equal(disable?.textContent, "Disable");
    disable?.click();
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_session_skills",
      sessionId: "session-archived",
      skillIds: [],
    });
    const deletion = harness.document.querySelector<HTMLButtonElement>(
      "[data-skill-id='history-guide'] .skill-delete",
    );
    assert.equal(deletion?.textContent, "Delete");
    deletion?.click();
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.ok(harness.calls.some((call) => call.path === "/skills/history-guide"));
  } finally {
    harness.close();
  }
});
