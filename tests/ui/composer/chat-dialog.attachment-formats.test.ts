import assert from "node:assert/strict";
import test from "node:test";
import type { JSDOM } from "jsdom";

import { ATTACHMENT_FORMATS, ATTACHMENT_IMPORT_FORMATS } from "../../../src/attachments/contracts.js";
import type { SavedProfile } from "../../../src/model/profile.js";
import {
  createDialogHarness,
  imageCapableState,
  pendingAudio,
  pendingDocument,
  waitForCondition,
  pendingImage,
  profileFixture,
  profileRevisionFixture,
  modelStateSourceFixture,
  runtimeSummaryForHarnessProfile,
  stateFixture,
  type DialogHarness,
} from "../support/chat-dialog.test-harness.js";

interface DecoderOptions {
  imageWidth?: number;
  imageHeight?: number;
  imageOutputBytes?: number;
  rejectImages?: boolean;
  holdImages?: boolean;
}

function browserDecoders(options: DecoderOptions = {}) {
  const probe = {
    createdUrls: [] as string[],
    revokedUrls: [] as string[],
    imageLoads: 0,
    imageDraws: 0,
    audioDecodes: 0,
    releaseImages: [] as Array<() => void>,
    expireConversion: null as (() => void) | null,
  };
  const beforeParse = (window: JSDOM["window"]) => {
    Object.defineProperty(window.URL, "createObjectURL", { configurable: true, value: () => {
      const url = "blob:attachment-" + (probe.createdUrls.length + 1);
      probe.createdUrls.push(url);
      return url;
    } });
    Object.defineProperty(window.URL, "revokeObjectURL", { configurable: true,
      value: (url: string) => probe.revokedUrls.push(url) });
    Object.defineProperty(window, "Image", { configurable: true, value: class {
      naturalWidth = options.imageWidth ?? 2;
      naturalHeight = options.imageHeight ?? 2;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        if (!value) return;
        probe.imageLoads += 1;
        const finish = () => options.rejectImages ? this.onerror?.() : this.onload?.();
        if (options.holdImages) probe.releaseImages.push(finish);
        else queueMicrotask(finish);
      }
    } });
    Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", { configurable: true,
      value: () => ({ drawImage: () => { probe.imageDraws += 1; } }) });
    Object.defineProperty(window.HTMLCanvasElement.prototype, "toBlob", { configurable: true,
      value: (callback: (blob: Blob) => void) => callback(new window.Blob([
        new Uint8Array(options.imageOutputBytes ?? 68),
      ], { type: "image/png" })) });
    Object.defineProperty(window, "AudioContext", { configurable: true, value: class {
      decodeAudioData() { probe.audioDecodes++; throw new Error("Audio must not be converted"); }
    } });
    const setTimeout = window.setTimeout.bind(window);
    Object.defineProperty(window, "setTimeout", { configurable: true, value: (
      callback: TimerHandler, delay?: number, ...args: unknown[]
    ) => {
      if (delay === 30_000) {
        probe.expireConversion = () => {
          if (typeof callback === "function") callback(...args);
        };
        return -1;
      }
      return setTimeout(callback, delay, ...args);
    } });
  };
  return { probe, beforeParse };
}

function importFile(harness: DialogHarness, name: string, type = "", byteLength = 32) {
  return new harness.window.File([new Uint8Array(byteLength)], name, { type });
}

function dropOn(harness: DialogHarness, selector: string, files: File[]) {
  const event = new harness.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } });
  harness.document.querySelector(selector)!.dispatchEvent(event);
  return event.defaultPrevented;
}

function uploads(harness: DialogHarness) {
  return harness.calls.filter((call) => call.path === "/attachments");
}

function verifiedProfileState(profile: SavedProfile) {
  const state = stateFixture();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.modelStateSource = modelStateSourceFixture(profile);
  state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
  state.runtimeProfile.capabilities.inputs = { image: true, audio: true, pdf: true };
  state.runtimeProfile.inputCapabilityEvidence = { image: "supported", audio: "supported", pdf: "supported" };
  state.capabilities = state.runtimeProfile.capabilities;
  state.capabilityEvidence.inputs = state.runtimeProfile.inputCapabilityEvidence;
  if (profile.connection.kind === "oauth-subscription") {
    state.oauthAuthProvider = profile.connection.provider;
    state.oauthAuthProfileId = profile.id;
    state.oauthAuthGeneration = 1;
    state.oauthAuth = {
      status: "signed-in",
      accountLabel: "studio@example.test",
      planType: "subscription",
      subscriptionEligible: true,
    };
  }
  return state;
}

test("every local document format uses its canonical label and sends without binary input capabilities", async () => {
  const formats = ATTACHMENT_FORMATS.filter((format) => format.kind === "document" && format.mediaType !== "application/pdf");
  for (let index = 0; index < formats.length; index += 4) {
    const group = formats.slice(index, index + 4);
    const state = stateFixture();
    state.runtimeProfile!.inputCapabilityEvidence.image = "unsupported";
    state.runtimeProfile!.inputCapabilityEvidence.audio = "unsupported";
    state.runtimeProfile!.inputCapabilityEvidence.pdf = "unsupported";
    const harness = await createDialogHarness(state);
    try {
      assert.equal(dropOn(harness, "#timeline", group.map((format) =>
        importFile(harness, "reference." + format.extensions[0], format.mediaType))), true);
      await harness.settleAttachmentOperation();
      assert.equal(uploads(harness).length, group.length);
      assert.equal(harness.document.querySelectorAll("#pendingAttachments [data-attachment-id]").length, group.length);
      for (const format of group) {
        assert.ok(harness.document.querySelector("#pendingAttachments")?.textContent?.includes(format.label));
      }
      harness.input("#prompt", "Summarize the reference material");
      harness.click("#sendButton");
      await harness.settle();
      assert.equal(harness.calls.some((call) => call.path === "/send"), true);
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); }
  }
});

test("unknown text extensions drop anywhere in the window and the server owns binary rejection", async () => {
  const harness = await createDialogHarness();
  try {
    harness.failAttachmentNamed("archive.zip", "The attachment is not a supported readable document.", 400);
    assert.equal(dropOn(harness, "body", [
      new harness.window.File(["print('hello')\n"], "analysis.py", { type: "application/octet-stream" }),
      importFile(harness, "archive.zip", "application/zip"),
      new harness.window.File(["title\tvalue\n"], "records.unknown"),
    ]), true);
    await harness.settleAttachmentOperation();
    assert.deepEqual(uploads(harness).map((call) => new URL(call.url).searchParams.get("fileName")),
      ["analysis.py", "archive.zip", "records.unknown"]);
    assert.deepEqual(Array.from(harness.document.querySelectorAll("#pendingAttachments .attachment-chip-label"),
      (chip) => chip.getAttribute("title")), ["analysis.py", "records.unknown"]);
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /archive\.zip.*not a supported readable document/i);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("the attachment drop handler preserves a Skill drop's ownership", async () => {
  const harness = await createDialogHarness();
  try {
    const file = new harness.window.File(["---\nname: test-skill\ndescription: Read a reference\n---\nRead the reference."], "SKILL.md");
    assert.equal(harness.dropSkillFile(file), true);
    await waitForCondition(() => harness.document.querySelector("#skillDropZone")?.getAttribute("aria-disabled") === "false",
      "Expected the Skill import to reach its terminal UI state.");
    assert.equal(uploads(harness).length, 0);
    assert.equal(harness.calls.some((call) => call.path === "/skills"), true);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("import extensions and MIME aliases normalize images before upload", async () => {
  for (const format of ATTACHMENT_IMPORT_FORMATS.filter((format) => format.kind === "image")) {
    const entries = [
      ...format.extensions.filter((extension) => extension !== "svg").map((extension) => ["sample." + extension, ""]),
      ...format.mediaTypes.filter((mediaType) => mediaType !== "image/svg+xml").map((mediaType) => ["sample", mediaType]),
    ];
    for (let index = 0; index < entries.length; index += 2) {
      const decoders = browserDecoders();
      const harness = await createDialogHarness(imageCapableState(), undefined, decoders);
      try {
        const group = entries.slice(index, index + 2);
        assert.equal(harness.dispatchDrop(group.map(([name, type]) => importFile(harness, name!, type!))), true);
        await harness.settleAttachmentOperation();
        const uploaded = uploads(harness);
        assert.equal(uploaded.length, group.length);
        for (const call of uploaded) {
          const file = call.body as File;
          assert.equal(file.type, format.kind === "image" ? "image/png" : "audio/wav");
          assert.equal(new URL(call.url).searchParams.get("fileName"), format.kind === "image" ? "sample.png" : "sample.wav");

        }
        assert.deepEqual(decoders.probe.revokedUrls, decoders.probe.createdUrls);
        assert.deepEqual(harness.errors, []);
      } finally { harness.close(); }
    }
  }
});

test("supported image and audio uploads preserve their original bytes without browser decoding", async () => {
  const decoders = browserDecoders({ rejectImages: true });
  const harness = await createDialogHarness(imageCapableState(), undefined, decoders);
  try {
    const files = [
      importFile(harness, "cover.jpeg", "image/pjpeg"),
      importFile(harness, "source.wav", "audio/x-wav"),
      importFile(harness, "music.mp3", "audio/mpeg"),
    ];
    harness.dispatchDrop(files);
    await harness.settleAttachmentOperation();
    assert.deepEqual(uploads(harness).map((call) => call.body), files);
    assert.equal(decoders.probe.imageLoads, 0);
    assert.equal(decoders.probe.audioDecodes, 0);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("converted bytes govern per-file and pending quotas while a failed conversion leaves the next file eligible", async () => {
  const state = imageCapableState();
  state.pendingAttachments = [pendingImage("existing", "existing.png", "image/png", 5 * 1024 * 1024)];
  const decoders = browserDecoders({ imageOutputBytes: 68 });
  const harness = await createDialogHarness(state, undefined, decoders);
  try {
    harness.dispatchDrop([
      importFile(harness, "large.gif", "image/gif", 16 * 1024 * 1024),
      importFile(harness, "too-large.avif", "image/avif", 20 * 1024 * 1024 + 1),
      new harness.window.File(["A readable note"], "note.md", { type: "text/plain" }),
    ]);
    await harness.settleAttachmentOperation();
    assert.deepEqual(uploads(harness).map((call) => new URL(call.url).searchParams.get("fileName")), ["large.png", "note.md"]);
    assert.equal((uploads(harness)[0]!.body as File).size, 68);
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /too-large\.avif.*browser conversion.*20 MiB/i);
    assert.deepEqual(decoders.probe.revokedUrls, decoders.probe.createdUrls);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }

  const over = browserDecoders({ imageOutputBytes: 5 * 1024 * 1024 + 1 });
  const overHarness = await createDialogHarness(imageCapableState(), undefined, over);
  try {
    overHarness.dispatchDrop([importFile(overHarness, "small.bmp", "image/bmp")]);
    await overHarness.settleAttachmentOperation();
    assert.equal(uploads(overHarness).length, 0);
    assert.match(overHarness.document.querySelector("#status")?.textContent ?? "", /larger than 5 MiB/i);
  } finally { overHarness.close(); }
});

test("image capability and attachment counts reject imports before a decoder starts", async () => {
  const cases = [
    { state: stateFixture(), file: "image.heic", type: "image/heic", status: /image input.*unverified/i },
    { state: imageCapableState(), file: "third.flac", type: "audio/flac", status: /at most 2 pending audio/i },
  ];
  cases[1]!.state.pendingAttachments = [pendingAudio("one", "one.wav"), pendingAudio("two", "two.wav")];
  for (const entry of cases) {
    const decoders = browserDecoders();
    const harness = await createDialogHarness(entry.state, undefined, decoders);
    try {
      harness.dispatchDrop([importFile(harness, entry.file, entry.type)]);
      await harness.settleAttachmentOperation();
      assert.equal(uploads(harness).length, 0);
      assert.equal(decoders.probe.imageLoads + decoders.probe.audioDecodes, 0);
      assert.match(harness.document.querySelector("#status")?.textContent ?? "", entry.status);
    } finally { harness.close(); }
  }
});

test("decoder failures are explicit and mixed batches retain ordinary files", async () => {
  const decoders = browserDecoders({ rejectImages: true });
  const harness = await createDialogHarness(imageCapableState(), undefined, decoders);
  try {
    harness.dispatchDrop([
      importFile(harness, "image.heic", "image/heic"),
      importFile(harness, "music.flac", "audio/flac"),
      importFile(harness, "source.wav", "audio/wav"),
    ]);
    await harness.settleAttachmentOperation();
    assert.deepEqual(uploads(harness).map((call) => new URL(call.url).searchParams.get("fileName")), ["source.wav"]);
    const status = harness.document.querySelector("#status")?.textContent ?? "";
    assert.match(status, /image\.heic.*cannot decode the image format/i);
    assert.match(status, /music\.flac.*requires conversion/i);
    assert.doesNotMatch(status, /Unconfirmed uploads/i);
    assert.deepEqual(decoders.probe.revokedUrls, decoders.probe.createdUrls);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("an absent platform decoder leaves controls usable and names the unsupported operation", async () => {
  const harness = await createDialogHarness(imageCapableState());
  try {
    harness.dispatchDrop([importFile(harness, "image.heif", "image/heif"), importFile(harness, "music.m4a", "audio/mp4")]);
    await harness.settleAttachmentOperation();
    assert.equal(uploads(harness).length, 0);
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /Image conversion is unavailable.*audio format requires conversion/is);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled, false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("decoded dimension bounds are checked before output is allocated", async () => {
  for (const options of [{ imageWidth: 16_385 }, { imageWidth: 10_001, imageHeight: 10_000 }]) {
    const decoders = browserDecoders(options);
    const harness = await createDialogHarness(imageCapableState(), undefined, decoders);
    try {
      const image = "imageWidth" in options;
      harness.dispatchDrop([importFile(harness, image ? "huge.tiff" : "long.aiff", image ? "image/tiff" : "audio/aiff")]);
      await harness.settleAttachmentOperation();
      assert.equal(uploads(harness).length, 0);
      assert.equal(decoders.probe.imageDraws, 0);
      assert.match(harness.document.querySelector("#status")?.textContent ?? "", /dimensions or pixel count/i);
      assert.deepEqual(decoders.probe.revokedUrls, decoders.probe.createdUrls);
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); }
  }
});

test("conversion owns the upload busy state and cancellation releases decoding resources", async () => {
  for (const options of [{ holdImages: true }]) {
    const decoders = browserDecoders(options);
    const harness = await createDialogHarness(imageCapableState(), undefined, decoders);
    try {
      const image = "holdImages" in options;
      harness.dispatchDrop([importFile(harness, image ? "slow.gif" : "slow.ogg", image ? "image/gif" : "audio/ogg")]);
      await harness.settle();
      assert.equal(uploads(harness).length, 0);
      assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled, true);
      assert.equal(harness.document.querySelector<HTMLButtonElement>("#newSessionButton")?.disabled, true);
      assert.equal(harness.document.querySelector("#pendingAttachments")?.getAttribute("aria-busy"), "true");
      harness.window.dispatchEvent(new harness.window.Event("pagehide"));
      await harness.settleAttachmentOperation();
      assert.equal(uploads(harness).length, 0);
      assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled, false);
      assert.deepEqual(decoders.probe.revokedUrls, decoders.probe.createdUrls);
      for (const release of decoders.probe.releaseImages) release();
      await harness.settle();
      assert.equal(uploads(harness).length, 0);
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); }
  }
});

test("conversion timeout releases controls and allows the next document in a mixed drop", async () => {
  const decoders = browserDecoders({ holdImages: true });
  const harness = await createDialogHarness(imageCapableState(), undefined, decoders);
  try {
    harness.dispatchDrop([importFile(harness, "stalled.gif", "image/gif"), new harness.window.File(["A note"], "note.txt")]);
    await harness.settle();
    assert.ok(decoders.probe.expireConversion);
    decoders.probe.expireConversion();
    await harness.settleAttachmentOperation();
    assert.deepEqual(uploads(harness).map((call) => new URL(call.url).searchParams.get("fileName")), ["note.txt"]);
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /30 seconds/i);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled, false);
    decoders.probe.releaseImages[0]!();
    await harness.settle();
    assert.equal(uploads(harness).length, 1);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("SVG conversion rejects active and external graphics before creating a browser URL", async () => {
  const decoders = browserDecoders();
  const harness = await createDialogHarness(imageCapableState(), undefined, decoders);
  try {
    for (const body of [
      '<script>run()</script>', '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Text</div></foreignObject>',
      '<image href="https://example.test/image.png"/>', '<path style="fill:url(https://example.test/paint.svg)"/>',
      '<?xml-stylesheet href="https://example.test/style.css"?>', '<animateColor attributeName="fill" to="red"/>',
      '<style>@import "https://example.test/style.css";</style>',
      '<style>.shape { fill: url(https://example.test/paint.svg); }</style>',
      '<style>.shape { fill: u\\72l(https://example.test/paint.svg); }</style>',
      '<style>.shape { background: image-set("https://example.test/paint.png"); }</style>',
      '<style>.shape { fill: src("https://example.test/paint.svg"); }</style>',
      '<path style="background:image-set(\'https://example.test/paint.png\')"/>', '<path onload="run()"/>',
    ]) {
      harness.dispatchDrop([new harness.window.File(['<svg xmlns="http://www.w3.org/2000/svg">' + body + "</svg>"], "unsafe.svg", { type: "image/svg+xml" })]);
      await harness.settleAttachmentOperation();
      assert.match(harness.document.querySelector("#status")?.textContent ?? "", /static graphics and local references/i);
    }
    assert.equal(decoders.probe.createdUrls.length, 0);
    assert.equal(uploads(harness).length, 0);
    harness.dispatchDrop([new harness.window.File([
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><defs><linearGradient id="paint"/></defs><path fill="url(#paint)" d="M0 0H2V2Z"/></svg>',
    ], "drawing.svg", { type: "image/svg+xml" })]);
    await harness.settleAttachmentOperation();
    assert.equal(uploads(harness).length, 1);
    assert.equal(new URL(uploads(harness)[0]!.url).searchParams.get("fileName"), "drawing.png");
    assert.deepEqual(decoders.probe.revokedUrls, decoders.probe.createdUrls);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("static SVG stylesheets and inert export metadata rasterize without external resources", async () => {
  const decoders = browserDecoders();
  const harness = await createDialogHarness(imageCapableState(), undefined, decoders);
  try {
    const source = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="2" height="2">',
      '<metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '<rdf:Description rdf:about="https://example.test/project">A drawing</rdf:Description></rdf:RDF></metadata>',
      '<defs><linearGradient id="paint"/><style>/* exported drawing */ .shape { fill: url(#paint); stroke: rgb(0, 0, 0); stroke-width: 1 }</style></defs>',
      '<path class="shape" id="outline" d="M0 0H2V2Z"/><use xlink:href="#outline"/></svg>',
    ].join("");
    harness.dispatchDrop([new harness.window.File([source], "drawing.svg", { type: "image/svg+xml" })]);
    await harness.settleAttachmentOperation();
    assert.equal(uploads(harness).length, 1);
    assert.equal((uploads(harness)[0]!.body as File).type, "image/png");
    assert.equal(decoders.probe.imageDraws, 1);
    assert.deepEqual(decoders.probe.revokedUrls, decoders.probe.createdUrls);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("unknown upload receipts compare the converted bytes rather than source bytes", async () => {
  const decoders = browserDecoders();
  const harness = await createDialogHarness(imageCapableState(), undefined, decoders);
  try {
    harness.failNextAttachmentUnknown("Interrupted response", { fileName: "canonical server name.png" });
    harness.dispatchDrop([importFile(harness, "converted.gif", "image/gif", 1_024)]);
    await harness.settleAttachmentOperation();
    assert.equal(uploads(harness).length, 1);
    assert.equal((uploads(harness)[0]!.body as File).size, 68);
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /converted\.png was confirmed attached/i);
    assert.doesNotMatch(harness.document.querySelector("#status")?.textContent ?? "", /Unconfirmed uploads/i);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("timeline labels MIDI and readable documents as locally extracted material", async () => {
  const state = stateFixture();
  state.events = [{
    id: "reference-event", kind: "user", createdAt: "2026-09-30T00:00:00.000Z", content: "Use the references",
    attachments: [pendingDocument("midi", "score.mid", "audio/midi"), pendingDocument("text", "reference.md", "text/plain")],
  }];
  const harness = await createDialogHarness(state);
  try {
    assert.deepEqual(Array.from(harness.document.querySelectorAll(".timeline-attachment-chip"), (chip) => chip.textContent), [
      "score.mid · MIDI · Extracted document · 24 B", "reference.md · Text · Extracted document · 24 B",
    ]);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("MIDI uses its local byte limit while readable text keeps the document limit", async () => {
  const harness = await createDialogHarness();
  try {
    harness.dispatchDrop([
      importFile(harness, "large.mid", "audio/midi", 8 * 1024 * 1024 + 1),
      importFile(harness, "notes.txt", "text/plain", 8 * 1024 * 1024 + 1),
    ]);
    await harness.settleAttachmentOperation();
    assert.deepEqual(uploads(harness).map((call) => new URL(call.url).searchParams.get("fileName")), ["notes.txt"]);
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /large\.mid.*8 MiB/i);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("catalog-verified Google subscription accepts PDF and audio together", async () => {
  const state = verifiedProfileState(profileFixture({ connection: { kind: "oauth-subscription", provider: "google" } }));
  state.pendingAttachments = [pendingDocument("pdf", "score.pdf", "application/pdf"), pendingAudio("audio", "source.wav")];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#prompt", "Review the references");
    harness.click("#sendButton");
    await harness.settle();
    const send = harness.calls.find((call) => call.path === "/send");
    assert.ok(send);
    assert.deepEqual(send.jsonBody, { prompt: "Review the references", sessionId: "session-1" });
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("Google subscription requires supported capability evidence for each native input", async () => {
  for (const input of ["pdf", "audio"] as const) {
    for (const evidence of ["unsupported", "unverified"] as const) {
      const state = verifiedProfileState(profileFixture({ connection: { kind: "oauth-subscription", provider: "google" } }));
      state.runtimeProfile!.capabilities.inputs[input] = false;
      state.runtimeProfile!.inputCapabilityEvidence[input] = evidence;
      state.pendingAttachments = [input === "pdf" ? pendingDocument("pdf", "score.pdf", "application/pdf") : pendingAudio("audio", "source.wav")];
      const harness = await createDialogHarness(state);
      try {
        harness.input("#prompt", "Review the reference");
        harness.click("#sendButton");
        await harness.settle();
        assert.equal(harness.calls.some((call) => call.path === "/send"), false);
        assert.match(harness.document.querySelector("#status")?.textContent ?? "", input === "pdf"
          ? /PDF.*verified PDF input support.*Google subscription/i
          : evidence === "unsupported" ? /does not support audio input/i : /audio input support.*unverified/i);
        assert.deepEqual(harness.errors, []);
      } finally { harness.close(); }
    }
  }
});

test("native input transport admission preserves the supported Direct API and subscription protocols", async () => {
  const entries = [
    { profile: profileFixture({ connection: { kind: "direct-api", apiFamily: "openai", apiMode: "responses", baseUrl: "https://example.test/v1", apiKey: "test-key" } }), pdf: true, audio: false },
    { profile: profileFixture(), pdf: false, audio: true },
    { profile: profileFixture({ connection: { kind: "direct-api", apiFamily: "anthropic", apiMode: "messages", baseUrl: "https://example.test/v1", apiKey: "test-key" } }), pdf: true, audio: false },
    { profile: profileFixture({ connection: { kind: "oauth-subscription", provider: "openai" } }), pdf: true, audio: false },
    { profile: profileFixture({ connection: { kind: "oauth-subscription", provider: "anthropic" } }), pdf: true, audio: false },
  ];
  for (const entry of entries) {
    for (const input of ["pdf", "audio"] as const) {
      const state = verifiedProfileState(entry.profile);
      state.pendingAttachments = [input === "pdf" ? pendingDocument("pdf", "score.pdf", "application/pdf") : pendingAudio("audio", "source.wav")];
      const harness = await createDialogHarness(state);
      try {
        harness.input("#prompt", "Review the reference");
        harness.click("#sendButton");
        await harness.settle();
        assert.equal(harness.calls.some((call) => call.path === "/send"), entry[input], entry.profile.connection.kind + ":" + input);
        assert.deepEqual(harness.errors, []);
      } finally { harness.close(); }
    }
  }
});

test("Google subscription text and MIDI remain sendable with unsupported native input capabilities", async () => {
  const state = verifiedProfileState(profileFixture({ connection: { kind: "oauth-subscription", provider: "google" } }));
  state.runtimeProfile!.capabilities.inputs = { image: false, audio: false, pdf: false };
  state.runtimeProfile!.inputCapabilityEvidence = { image: "unsupported", audio: "unsupported", pdf: "unsupported" };
  state.capabilityEvidence.inputs = state.runtimeProfile!.inputCapabilityEvidence;
  state.pendingAttachments = [pendingDocument("midi", "score.mid", "audio/midi"), pendingDocument("text", "notes.txt", "text/plain")];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#prompt", "Summarize these references");
    harness.click("#sendButton");
    await harness.settle();
    assert.equal(harness.calls.some((call) => call.path === "/send"), true);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("audio formats requiring conversion fail explicitly without decoding or changing the next original file", async () => {
  const decoders = browserDecoders();
  const harness = await createDialogHarness(stateFixture(), undefined, decoders);
  try {
    const source = importFile(harness, "original.wav", "audio/wav");
    harness.dispatchDrop([importFile(harness, "source.flac", "audio/flac"), source]);
    await harness.settleAttachmentOperation();
    assert.deepEqual(uploads(harness).map(call => call.body), [source]);
    assert.equal(decoders.probe.audioDecodes, 0);
    assert.match(harness.document.querySelector("#status")!.textContent!, /source\.flac.*requires conversion/);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
