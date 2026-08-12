import assert from "node:assert/strict";
import test from "node:test";

import { AgentPartialCompletionError } from "../agent/loop.js";
import {
  cloneState,
  commandCalls,
  createDialogHarness,
  jsonCalls,
  stateFixture,
} from "./chat-dialog.test-harness.js";

test("Send posts only the prompt and active session ID", async () => {
  const harness = await createDialogHarness();
  try {
    assert.equal(harness.document.querySelector("#webSearchMenuButton"), null);
    harness.input("#prompt", "Make the drums wider");
    harness.click("#sendButton");
    await harness.settle();

    assert.deepEqual(
      jsonCalls(harness, "/send"),
      [{
        path: "/send",
        body: {
          prompt: "Make the drums wider",
          sessionId: "session-1",
        },
      }],
    );
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Send rejects an empty composer without creating a request", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.input("#prompt", "   ");
    harness.click("#sendButton");
    await harness.settle();

    assert.equal(harness.calls.some((call) => call.path === "/send"), false);
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /Enter a request/);
    assert.equal(harness.document.activeElement?.id, "prompt");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Send restores the prompt only when the bridge says it was not persisted", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Retry this safe prompt");
    harness.failNextSend("Profile validation failed.", "not_persisted");
    harness.click("#sendButton");
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Retry this safe prompt",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Send remains busy until its HTTP fallback state refresh settles", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextState();
    harness.input("#prompt", "Keep this attempt active");
    harness.click("#sendButton");
    for (let index = 0; index < 20; index += 1) {
      if (harness.calls.some((call) => call.path === "/state")) break;
      await Promise.resolve();
    }
    assert.equal(
      harness.calls.some((call) => call.path === "/state"),
      true,
    );

    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      true,
    );

    harness.releaseHeldState();
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("HTTP send completion clears stale streaming and confirmation UI before terminal SSE", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Complete through the HTTP fallback");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({ type: "assistant_delta", sendId, delta: "Transient draft" });
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      id: "confirm-http-race",
      message: "Apply changes?",
      groups: [{ title: "Track", rows: ["Create clip"] }],
    });
    harness.holdNextConfirmation();
    harness.clickButton("Apply");
    await Promise.resolve();
    assert.ok(harness.document.querySelector(".timeline-item.streaming"));
    assert.ok(harness.document.querySelector(".confirm-card"));

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.flushAnimationFrames(), 0);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(harness.document.querySelector(".timeline-item.streaming"), null);
    assert.equal(harness.document.querySelector(".confirm-card"), null);

    harness.releaseHeldConfirmation();
    await harness.settle();
    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("stopping a send clears its unpersisted streaming draft", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Stop after a partial response");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({ type: "assistant_delta", sendId, delta: "Partial response" });
    harness.flushAnimationFrames();
    assert.ok(harness.document.querySelector(".timeline-item.streaming"));

    harness.click("#sendButton");
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(harness.document.querySelector(".timeline-item.streaming"), null);

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a reconciled send failure clears its unpersisted streaming draft", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.failNextSend("The model request failed.", "persisted");
    harness.input("#prompt", "Fail after a partial response");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({ type: "assistant_delta", sendId, delta: "Partial response" });
    harness.flushAnimationFrames();
    assert.ok(harness.document.querySelector(".timeline-item.streaming"));

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(harness.document.querySelector(".timeline-item.streaming"), null);
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /timeline/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an expanded timeline Error does not repeat its summary line in the body", async () => {
  const state = stateFixture();
  state.events = [{
    id: "event-error-once",
    createdAt: "2026-08-06T00:00:00.000Z",
    kind: "error",
    content: [
      "Live action plan failed after 9 completed actions.",
      "Failed action 10: Insert Delay.",
    ].join("\n"),
  }];
  const harness = await createDialogHarness(state);
  try {
    const itemText = harness.document.querySelector(".timeline-item.error")?.textContent ?? "";
    assert.equal(
      itemText.match(/Live action plan failed after 9 completed actions\./g)?.length,
      1,
    );
    assert.match(itemText, /Failed action 10: Insert Delay/);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("the timeline distinguishes an Apply request from automatic approval", async () => {
  const state = stateFixture();
  state.events = [
    {
      id: "event-tool-call-before-search",
      createdAt: "2026-08-05T23:59:59.000Z",
      kind: "tool_call",
      name: "inspect_song_info",
      content: "Inspect current Song information\n{}",
    },
    {
      id: "event-apply-proposal",
      createdAt: "2026-08-07T00:00:00.000Z",
      kind: "apply_requested",
      content: "Set tempo to 128 BPM.\n\nActions:\n1. Set tempo to 128 BPM.",
    },
    {
      id: "event-auto-approved",
      createdAt: "2026-08-07T00:00:01.000Z",
      kind: "apply_auto_approved",
      content: [
        "1 change · Low Risk",
        "Automatic approval. Standard safety checks completed.",
      ].join("\n"),
    },
    {
      id: "event-auto-approved-legacy",
      createdAt: "2026-08-07T00:00:02.000Z",
      kind: "apply_auto_approved",
      content: [
        "Auto-approved 21 changes under Accept Everything mode without opening an approval prompt.",
        "Live observation, validation, preflight, and state revalidation still ran before execution.",
      ].join("\n"),
    },
  ];
  const harness = await createDialogHarness(state);
  try {
    assert.match(
      harness.document.querySelector(".timeline-item.apply_requested summary")?.textContent ?? "",
      /^Apply request —/,
    );
    assert.equal(
      harness.document.querySelector(
        ".timeline-item.apply_requested .timeline-content",
      )?.textContent,
      "Actions:\n1. Set tempo to 128 BPM.",
    );
    const autoApproved = harness.document.querySelector(
      ".timeline-item.apply_auto_approved",
    );
    const summary = autoApproved?.querySelector("summary")?.textContent ?? "";
    assert.equal(summary, "Auto-approved — 1 change · Low Risk");
    assert.doesNotMatch(summary, /Auto-approved.*Auto-approved/i);
    assert.equal(
      autoApproved?.querySelector(".timeline-content")?.textContent,
      "Automatic approval. Standard safety checks completed.",
    );
    assert.equal(
      harness.document.querySelector(
        '[data-event-id="event-auto-approved-legacy"] summary',
      )?.textContent,
      "Auto-approved — 21 changes · Accept Everything",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a rejected tool input is labelled and keeps its complete first line", async () => {
  const state = stateFixture();
  const firstLine = [
    'Tool call "apply_live_actions" has invalid arguments:',
    "Action 2 must use either trackName or trackRef, not both.",
  ].join(" ");
  state.events = [{
    id: "event-long-error",
    createdAt: "2026-08-06T00:00:00.000Z",
    kind: "tool_result",
    name: "apply_live_actions",
    content: [firstLine, "Correct the tool fields and types, then retry."].join("\n"),
  }];
  const harness = await createDialogHarness(state);
  try {
    const details = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-item.tool_result",
    );
    assert.equal(details?.open, true);
    assert.equal(
      details?.querySelector(".timeline-content")?.textContent,
      `${firstLine}\nCorrect the tool fields and types, then retry.`,
    );
    assert.match(
      details?.querySelector("summary")?.textContent ?? "",
      /^Tool input rejected \/ apply_live_actions — .*…$/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("multiline user and assistant messages keep their first line", async () => {
  const state = stateFixture();
  state.events = [
    {
      id: "event-multiline-user",
      createdAt: "2026-08-06T00:00:00.000Z",
      kind: "user",
      content: "Build the drums\nThen add the bass",
    },
    {
      id: "event-multiline-assistant",
      createdAt: "2026-08-06T00:00:01.000Z",
      kind: "assistant",
      content: "Drums are ready\nBass is next",
    },
  ];
  const harness = await createDialogHarness(state);
  try {
    const items = [...harness.document.querySelectorAll(".timeline-item .timeline-content")]
      .map((item) => item.textContent);
    assert.deepEqual(items, [
      "Build the drums\nThen add the bass",
      "Drums are ready\nBass is next",
    ]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("conversation Markdown uses the bundled safe renderer", async () => {
  const state = stateFixture();
  state.events = [{
    id: "event-markdown-assistant",
    createdAt: "2026-08-06T00:00:01.000Z",
    kind: "assistant",
    content: [
      "## Arrangement",
      "",
      "Use **Wavetable** with `Auto Filter`.",
      "",
      "- Chords",
      "  - Wavetable",
      "",
      "[Ableton](https://www.ableton.com \"Ableton Live\")",
      "[unsafe](javascript:alert(1))",
      "",
      "| Track | Device |",
      "| --- | --- |",
      "| Lead | Wavetable |",
      "",
      "<img src=x onerror=alert(1)>",
    ].join("\n"),
  }];
  const harness = await createDialogHarness(state);
  try {
    const content = harness.document.querySelector<HTMLElement>(
      ".timeline-item.assistant .timeline-content",
    );
    assert.ok(content);
    assert.ok(content.querySelector("p"));
    assert.equal(content.querySelector("h2")?.textContent, "Arrangement");
    assert.equal(content.querySelector("strong")?.textContent, "Wavetable");
    assert.equal(content.querySelector("code")?.textContent, "Auto Filter");
    assert.equal(content.querySelector("ul ul li")?.textContent, "Wavetable");
    const link = content.querySelector<HTMLAnchorElement>("a");
    assert.ok(link);
    assert.equal(link.href, "https://www.ableton.com/");
    assert.equal(link.title, "Ableton Live");
    assert.equal(link.rel, "noopener noreferrer");
    const table = content.querySelector("table");
    assert.ok(table);
    assert.equal(table.querySelector("td")?.textContent, "Lead");
    const tableScrollContainer = table.parentElement;
    assert.ok(tableScrollContainer);
    assert.equal(
      tableScrollContainer.classList.contains("markdown-table-scroll"),
      true,
    );
    assert.equal(content.querySelector('a[href^="javascript:"]'), null);
    assert.equal(content.querySelector("img"), null);
    assert.match(content.textContent ?? "", /<img src=x onerror=alert\(1\)>/);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("assistant Web Search citations render as bounded safe source links", async () => {
  const state = stateFixture();
  state.events = [
    {
      id: "event-web-search",
      createdAt: "2026-08-06T00:00:00.000Z",
      kind: "web_search",
      content: "Searched for “current Ableton release” · 2 pages",
      webSearch: {
        id: "search-1",
        status: "completed",
        action: "search",
        queries: [
          "current Ableton release",
          "Ableton Live release notes",
          "latest Ableton Live version",
        ],
        sources: [
          { url: "https://example.test/release", title: "Release notes" },
          { url: "https://docs.example.test/live", title: "Live manual" },
        ],
      },
    },
    {
      id: "event-cited-assistant",
      createdAt: "2026-08-06T00:00:01.000Z",
      kind: "assistant",
      content: "A current answer.",
      citations: [
        { url: "https://example.test/source", title: "Official source" },
        { url: "https://example.test/source", title: "Duplicate" },
        { url: "javascript:alert(1)", title: "Unsafe" },
        { url: "https://user:secret@example.test/private", title: "Credentials" },
      ],
    },
    {
      id: "event-tool-call",
      createdAt: "2026-08-06T00:00:02.000Z",
      kind: "tool_call",
      content: "Observed the selected track.",
    },
  ];
  const harness = await createDialogHarness(state);
  try {
    const searchStatus = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-item.web_search",
    );
    assert.equal(searchStatus?.open, false);
    assert.equal(
      searchStatus?.querySelector("summary")?.classList.contains("timeline-label"),
      true,
    );
    assert.ok(searchStatus?.querySelector(".timeline-content"));
    assert.equal(searchStatus?.querySelector(".web-search-content"), null);
    assert.equal(searchStatus?.querySelector(".web-search-status-icon"), null);
    assert.equal(
      searchStatus?.getAttribute("aria-label"),
      "Web Search: “current Ableton release” + 2 more · 2 pages",
    );
    assert.match(searchStatus?.textContent ?? "", /current Ableton release/);
    assert.match(searchStatus?.textContent ?? "", /Ableton Live release notes/);
    assert.match(searchStatus?.textContent ?? "", /latest Ableton Live version/);
    assert.match(searchStatus?.textContent ?? "", /Source pages/);
    assert.equal(searchStatus?.querySelector(".web-search-source-note"), null);
    const sourceHelp = searchStatus?.querySelector<HTMLElement>(
      ".web-search-source-help",
    );
    assert.equal(sourceHelp?.textContent, "?");
    assert.equal(sourceHelp?.tabIndex, 0);
    assert.match(sourceHelp?.getAttribute("aria-label") ?? "", /page text is available/i);
    assert.equal(sourceHelp?.dataset.tooltip, sourceHelp?.getAttribute("aria-label"));
    const reviewedPages = [...searchStatus?.querySelectorAll<HTMLAnchorElement>(
      ".web-search-source-list a",
    ) ?? []];
    assert.deepEqual(
      reviewedPages.map((link) => [
        link.querySelector(".web-search-source-title")?.textContent,
        link.href,
      ]),
      [
        ["Release notes", "https://example.test/release"],
        ["Live manual", "https://docs.example.test/live"],
      ],
    );
    const sources = harness.document.querySelector(".citation-sources");
    assert.equal(sources?.getAttribute("aria-label"), "Citations");
    assert.equal(sources?.querySelector(".citation-sources-label")?.textContent, "Citations");
    const links = [...harness.document.querySelectorAll<HTMLAnchorElement>(
      ".citation-source-list a",
    )];
    assert.equal(links.length, 1);
    assert.equal(links[0]?.href, "https://example.test/source");
    assert.equal(links[0]?.textContent, "Official source");
    assert.equal(links[0]?.target, "_blank");
    assert.equal(links[0]?.rel, "noopener noreferrer");
    assert.equal(sources?.textContent?.includes("Unsafe"), false);
    assert.equal(sources?.textContent?.includes("secret"), false);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a completed Web Search without URLs names the provider metadata gap", async () => {
  const state = stateFixture();
  state.events = [{
    id: "event-web-search-without-sources",
    createdAt: "2026-08-06T00:00:00.000Z",
    kind: "web_search",
    content: "Searched the web",
    webSearch: {
      id: "search-without-sources",
      status: "completed",
      action: "search",
      queries: ["fun chord progressions"],
      sources: [],
    },
  }];
  const harness = await createDialogHarness(state);
  try {
    assert.match(
      harness.document.querySelector(".timeline-item.web_search")?.textContent ?? "",
      /provider returned no result page URLs/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Web Search result rows hide provider call IDs and do not repeat hostname titles", async () => {
  const state = stateFixture();
  state.events = [{
    id: "event-web-search-internal-url",
    createdAt: "2026-08-06T00:00:00.000Z",
    kind: "web_search",
    content: "Opened a page",
    webSearch: {
      id: "search-internal-url",
      status: "completed",
      action: "open_page",
      queries: [],
      sources: [{
        url: "https://www.hooktheory.com/theorytab/view/mitis/born#ws_call_id=call_01_internal",
        title: "www.hooktheory.com",
      }, {
        url: "https://www.hooktheory.com/theorytab/view/mitis/born#ws_call_id=call_01_duplicate",
        title: "Duplicate provider result",
      }],
    },
  }];
  const harness = await createDialogHarness(state);
  try {
    const rows = harness.document.querySelectorAll(
      ".web-search-source-list li",
    );
    assert.equal(rows.length, 1);
    const link = rows[0]?.querySelector<HTMLAnchorElement>("a");
    assert.equal(
      link?.href,
      "https://www.hooktheory.com/theorytab/view/mitis/born",
    );
    assert.equal(
      link?.querySelector(".web-search-source-title")?.textContent,
      "www.hooktheory.com",
    );
    assert.equal(link?.querySelector(".web-search-source-domain"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("the timeline preserves persisted event chronology", async () => {
  const state = stateFixture();
  state.events = [
    {
      id: "event-research-user",
      createdAt: "2026-08-06T00:00:00.000Z",
      kind: "user",
      content: "Research the current release.",
    },
    {
      id: "event-research-search",
      createdAt: "2026-08-06T00:00:01.000Z",
      kind: "web_search",
      content: "Searched for the current release.",
      webSearch: {
        id: "search-reading-order",
        status: "completed",
        action: "search",
        queries: ["current release"],
        sources: [{
          url: "https://example.test/release",
          title: "Release notes",
        }],
      },
    },
    {
      id: "event-research-tool-call",
      createdAt: "2026-08-06T00:00:02.000Z",
      kind: "tool_call",
      name: "inspect_live_set",
      content: "Inspecting the Live Set.",
    },
    {
      id: "event-research-tool-result",
      createdAt: "2026-08-06T00:00:03.000Z",
      kind: "tool_result",
      name: "inspect_live_set",
      content: "Observed the Live Set.",
    },
    {
      id: "event-research-tool-error",
      createdAt: "2026-08-06T00:00:03.500Z",
      kind: "error",
      content: "A later Live operation failed.",
    },
    {
      id: "event-research-search-2",
      createdAt: "2026-08-06T00:00:04.000Z",
      kind: "web_search",
      content: "Opened the current release notes.",
      webSearch: {
        id: "search-reading-order-2",
        status: "completed",
        action: "open_page",
        queries: [],
        sources: [{
          url: "https://example.test/release/details",
          title: "Release details",
        }],
      },
    },
    {
      id: "event-research-assistant-2",
      createdAt: "2026-08-06T00:00:05.000Z",
      kind: "assistant",
      content: "Here is the updated answer.",
    },
  ];
  const harness = await createDialogHarness(state);
  try {
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLElement>("#timeline > .timeline-item")]
        .map((item) => item.dataset.eventId),
      [
        "event-research-user",
        "event-research-search",
        "event-research-tool-call",
        "event-research-tool-result",
        "event-research-tool-error",
        "event-research-search-2",
        "event-research-assistant-2",
      ],
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a streaming reply remains after the Web Search that started first", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Research the current release");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.emitServerEvent({
      type: "web_search_update",
      sendId,
      sessionId: "session-1",
      update: {
        id: "search-live-order",
        status: "searching",
        action: "search",
        queries: ["current release"],
        sources: [],
      },
    });
    harness.emitServerEvent({
      type: "assistant_delta",
      sendId,
      sessionId: "session-1",
      delta: "Checking the current release…",
    });
    harness.flushAnimationFrames();

    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLElement>("#timeline > .timeline-item")]
        .map((item) => item.classList.contains("streaming")
          ? "assistant-streaming"
          : item.classList.contains("web_search")
            ? "web-search-live"
            : "other"),
      ["web-search-live", "assistant-streaming"],
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("Web Search pages appear live and reconcile into the persisted search card", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Find the current Ableton release");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.emitServerEvent({
      type: "web_search_update",
      sendId,
      sessionId: "session-1",
      update: {
        id: "search-live-1",
        status: "searching",
        action: "search",
        queries: ["current Ableton release"],
        sources: [],
      },
    });
    let liveCard = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-item.web_search.live",
    );
    assert.equal(liveCard?.open, true);
    assert.match(liveCard?.textContent ?? "", /Searching.*current Ableton release/);
    assert.match(liveCard?.textContent ?? "", /Waiting for result pages/);
    liveCard?.querySelector("summary")?.focus();

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: {
        id: "event-search-live-1",
        createdAt: "2026-08-06T00:00:00.000Z",
        kind: "web_search",
        content: "Searched for “current Ableton release” · 1 page",
        webSearch: {
          id: "search-live-1",
          status: "completed",
          action: "search",
          queries: ["current Ableton release"],
          sources: [{
            url: "https://example.test/release",
            title: "Release notes",
          }],
        },
      },
    });
    assert.equal(
      harness.document.querySelectorAll(".timeline-item.web_search").length,
      1,
    );
    assert.equal(
      harness.document.querySelector(".timeline-item.web_search.live"),
      null,
    );
    const terminalCard = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-item.web_search",
    );
    assert.equal(terminalCard?.open, true);
    assert.equal(
      harness.document.activeElement,
      terminalCard?.querySelector("summary"),
    );
    assert.equal(
      terminalCard?.querySelector(".web-search-section-label")?.textContent,
      "Query",
    );
    assert.equal(
      terminalCard?.querySelector(".web-search-query-single")?.textContent,
      "current Ableton release",
    );
    assert.equal(terminalCard?.querySelector(".web-search-query-list"), null);
    assert.equal(
      terminalCard?.querySelectorAll(".web-search-section-label")[1]?.textContent,
      "Source pages",
    );
    assert.equal(terminalCard?.querySelector(".web-search-source-note"), null);
    assert.match(
      terminalCard?.querySelector(".web-search-source-help")
        ?.getAttribute("aria-label") ?? "",
      /page text is available to the model/i,
    );
    assert.equal(
      harness.document.querySelector<HTMLAnchorElement>(
        ".timeline-item.web_search .web-search-source-list a",
      )?.href,
      "https://example.test/release",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("focused Web Search result and citation links survive searching and terminal events", async () => {
  const state = stateFixture();
  state.events = [{
    id: "event-cited-assistant",
    createdAt: "2026-08-06T00:00:00.000Z",
    kind: "assistant",
    content: "A cited answer.",
    citations: [{
      url: "https://example.test/citation",
      title: "Official citation",
    }],
  }];
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Refresh the research");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    const citation = harness.document.querySelector<HTMLAnchorElement>(
      ".citation-source-list a",
    );
    assert.ok(citation);
    citation.focus();
    harness.emitServerEvent({
      type: "web_search_update",
      sendId,
      sessionId: "session-1",
      update: {
        id: "focused-search",
        status: "searching",
        action: "search",
        queries: ["current Ableton release"],
        sources: [{
          url: "https://example.test/release",
          title: "Release notes",
        }],
      },
    });
    assert.equal(
      (harness.document.activeElement as HTMLAnchorElement | null)?.href,
      "https://example.test/citation",
    );

    const result = harness.document.querySelector<HTMLAnchorElement>(
      ".timeline-item.web_search.live .web-search-source-list a",
    );
    assert.ok(result);
    result.focus();
    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: {
        id: "event-focused-search",
        createdAt: "2026-08-06T00:00:01.000Z",
        kind: "web_search",
        content: "Searched for current Ableton release",
        webSearch: {
          id: "focused-search",
          status: "completed",
          action: "search",
          queries: ["current Ableton release", "Ableton release notes"],
          sources: [{
            url: "https://example.test/release",
            title: "Updated release notes",
          }],
        },
      },
    });
    assert.equal(
      (harness.document.activeElement as HTMLAnchorElement | null)?.href,
      "https://example.test/release",
    );
    assert.equal(
      harness.document.activeElement?.closest(".timeline-item")?.getAttribute(
        "data-event-id",
      ),
      "event-focused-search",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("focused persisted Web Search links use event identity when provider IDs collide", async () => {
  const state = stateFixture();
  const sharedSource = [{
    url: "https://example.test/shared",
    title: "Shared result",
  }];
  state.events = [
    {
      id: "event-search-history",
      createdAt: "2026-08-05T00:00:00.000Z",
      kind: "web_search",
      content: "Historical search",
      webSearch: {
        id: "openai-search-1",
        status: "completed",
        action: "search",
        queries: ["historical query"],
        sources: sharedSource,
      },
    },
    {
      id: "event-search-current",
      createdAt: "2026-08-06T00:00:00.000Z",
      kind: "web_search",
      content: "Current persisted search",
      webSearch: {
        id: "openai-search-1",
        status: "completed",
        action: "search",
        queries: ["current persisted query"],
        sources: sharedSource,
      },
    },
  ];
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start another search");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    const currentLink = harness.document.querySelector<HTMLAnchorElement>(
      '[data-event-id="event-search-current"] .web-search-source-list a',
    );
    assert.ok(currentLink);
    currentLink.focus();
    harness.emitServerEvent({
      type: "web_search_update",
      sendId,
      sessionId: "session-1",
      update: {
        id: "openai-search-1",
        status: "searching",
        action: "search",
        queries: [],
        sources: [],
      },
    });

    assert.equal(
      harness.document.activeElement?.closest(".timeline-item")?.getAttribute(
        "data-event-id",
      ),
      "event-search-current",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("a focused live Web Search link follows its terminal event past a historical ID collision", async () => {
  const state = stateFixture();
  state.events = [{
    id: "event-search-history",
    createdAt: "2026-08-05T00:00:00.000Z",
    kind: "web_search",
    content: "Historical search",
    webSearch: {
      id: "openai-search-1",
      status: "completed",
      action: "search",
      queries: ["historical query"],
      sources: [{
        url: "https://example.test/shared",
        title: "Historical result",
      }],
    },
  }];
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Run the current search");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.emitServerEvent({
      type: "web_search_update",
      sendId,
      sessionId: "session-1",
      update: {
        id: "openai-search-1",
        status: "searching",
        action: "search",
        queries: ["current query"],
        sources: [{
          url: "https://example.test/shared",
          title: "Live result",
        }],
      },
    });
    const liveLink = harness.document.querySelector<HTMLAnchorElement>(
      ".timeline-item.web_search.live .web-search-source-list a",
    );
    assert.ok(liveLink);
    liveLink.focus();

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: {
        id: "event-search-terminal",
        createdAt: "2026-08-06T00:00:00.000Z",
        kind: "web_search",
        content: "Searched the current query",
        webSearch: {
          id: "openai-search-1",
          status: "completed",
          action: "search",
          queries: ["current query"],
          sources: [{
            url: "https://example.test/shared",
            title: "Terminal result",
          }],
        },
      },
    });

    assert.equal(
      harness.document.activeElement?.closest(".timeline-item")?.getAttribute(
        "data-event-id",
      ),
      "event-search-terminal",
    );
    assert.equal(
      harness.document.querySelector(".timeline-item.web_search.live"),
      null,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("safe Web Search page counts match mixed and unsafe-only rendered results", async () => {
  const state = stateFixture();
  state.events = [
    {
      id: "event-mixed-search",
      createdAt: "2026-08-06T00:00:00.000Z",
      kind: "web_search",
      content: "Searched mixed results",
      webSearch: {
        id: "mixed-search",
        status: "completed",
        action: "search",
        queries: ["mixed source safety"],
        sources: [
          { url: "https://example.test/safe", title: "Safe result" },
          { url: "javascript:alert(1)", title: "Unsafe result" },
        ],
      },
    },
    {
      id: "event-unsafe-only-search",
      createdAt: "2026-08-06T00:00:01.000Z",
      kind: "web_search",
      content: "Searched unsafe results",
      webSearch: {
        id: "unsafe-only-search",
        status: "completed",
        action: "search",
        queries: ["unsafe-only source safety"],
        sources: [{ url: "javascript:alert(2)", title: "Unsafe result" }],
      },
    },
  ];
  const harness = await createDialogHarness(state);
  try {
    const mixed = harness.document.querySelector<HTMLDetailsElement>(
      '[data-web-search-id="mixed-search"]',
    );
    assert.ok(mixed);
    assert.match(mixed.querySelector("summary")?.textContent ?? "", /1 page$/);
    assert.equal(mixed.querySelectorAll(".web-search-source-list a").length, 1);

    const unsafeOnly = harness.document.querySelector<HTMLDetailsElement>(
      '[data-web-search-id="unsafe-only-search"]',
    );
    assert.ok(unsafeOnly);
    assert.doesNotMatch(
      unsafeOnly.querySelector("summary")?.textContent ?? "",
      /\b\d+ pages?\b/,
    );
    assert.equal(unsafeOnly.querySelectorAll(".web-search-source-list a").length, 0);
    assert.match(unsafeOnly.textContent ?? "", /provider returned no result page URLs/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Web Search summaries preserve search, open_page, and find_in_page actions", async () => {
  const state = stateFixture();
  const source = [{ url: "https://example.test/page", title: "Result page" }];
  state.events = [
    {
      id: "event-search-action",
      createdAt: "2026-08-06T00:00:00.000Z",
      kind: "web_search",
      content: "Searched the web",
      webSearch: {
        id: "search-action",
        status: "completed",
        action: "search",
        queries: ["current Ableton release"],
        sources: source,
      },
    },
    {
      id: "event-open-action",
      createdAt: "2026-08-06T00:00:01.000Z",
      kind: "web_search",
      content: "Opened a web page",
      webSearch: {
        id: "open-action",
        status: "completed",
        action: "open_page",
        queries: [],
        sources: source,
      },
    },
    {
      id: "event-find-action",
      createdAt: "2026-08-06T00:00:02.000Z",
      kind: "web_search",
      content: "Searched within a web page",
      webSearch: {
        id: "find-action",
        status: "completed",
        action: "find_in_page",
        queries: ["minimum system requirements"],
        sources: source,
      },
    },
  ];
  const harness = await createDialogHarness(state);
  try {
    assert.equal(
      harness.document.querySelector('[data-web-search-id="search-action"] summary')
        ?.textContent,
      "Web Search — “current Ableton release” · 1 page",
    );
    assert.equal(
      harness.document.querySelector('[data-web-search-id="open-action"] summary')
        ?.textContent,
      "Web Search — Opened a web page · 1 page",
    );
    assert.equal(
      harness.document.querySelector('[data-web-search-id="find-action"] summary')
        ?.textContent,
      "Web Search — Searched within a web page · 1 page",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("long Web Search queries keep summaries compact without losing details or aria", async () => {
  const longQuery = `long-start-${"x".repeat(180)}-distinct-tail`;
  const state = stateFixture();
  state.events = [{
    id: "event-long-search",
    createdAt: "2026-08-06T00:00:00.000Z",
    kind: "web_search",
    content: "Searched a long query",
    webSearch: {
      id: "long-search",
      status: "completed",
      action: "search",
      queries: [longQuery],
      sources: [{ url: "https://example.test/long", title: "Long result" }],
    },
  }];
  const harness = await createDialogHarness(state);
  try {
    const card = harness.document.querySelector<HTMLDetailsElement>(
      '[data-web-search-id="long-search"]',
    );
    assert.ok(card);
    const summary = card.querySelector<HTMLElement>("summary");
    assert.ok(summary);
    assert.equal(summary.textContent?.includes("distinct-tail"), false);
    assert.ok((summary.textContent?.length ?? 0) < 130);
    assert.equal(
      card.querySelector(".web-search-query-single")?.textContent,
      longQuery,
    );
    assert.match(summary.getAttribute("aria-label") ?? "", /distinct-tail/);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("streaming Markdown falls back to plain text when rendering fails", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Stream Markdown");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    const markdownRenderer = harness.window.LiveSmithMarkdown;
    assert.ok(markdownRenderer);
    const renderInto = markdownRenderer.renderInto;
    markdownRenderer.renderInto = () => {
      throw new Error("Renderer failed");
    };

    harness.emitServerEvent({
      type: "assistant_delta",
      sendId,
      delta: "Use **Wavetable** safely.",
    });
    assert.equal(harness.flushAnimationFrames(), 1);
    const content = harness.document.querySelector(
      ".timeline-item.streaming .timeline-content",
    );
    assert.equal(content?.textContent, "Use **Wavetable** safely.");
    assert.equal(content?.classList.contains("markdown-body"), false);
    assert.deepEqual(harness.errors, []);

    markdownRenderer.renderInto = renderInto;
    harness.releaseHeldSend();
    await harness.settle();
  } finally {
    harness.close();
  }
});

test("an expanded partial Apply Result does not repeat its summary line", async () => {
  const state = stateFixture();
  const partialError = new AgentPartialCompletionError(
    Array.from({ length: 9 }, (_, index) => `Completed action ${index + 1}.`),
    new Error("Failed to insert device"),
    9,
    {
      type: "insert_device",
      trackName: "FB Lead",
      deviceName: "Ping Pong Delay",
      index: 2,
    },
    "FB Lead",
  );
  state.events = [{
    id: "event-partial-apply-once",
    createdAt: "2026-08-06T00:00:00.000Z",
    kind: "apply_result",
    content: partialError.message,
  }];
  const harness = await createDialogHarness(state);
  try {
    const item = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-item.apply_result",
    );
    assert.equal(item?.open, true);
    assert.equal(item?.querySelector("summary")?.textContent?.startsWith("Partial Apply —"), true);
    const itemText = item?.textContent ?? "";
    assert.equal(
      itemText.match(/Live action plan partially completed after 9 action\(s\)\./g)?.length,
      1,
    );
    assert.match(itemText, /Failed action 10: Insert Live device "Ping Pong Delay"/);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a zero-completion Apply failure is labeled failed and opened by default", async () => {
  const state = stateFixture();
  state.events = [{
    id: "event-failed-apply",
    createdAt: "2026-08-06T00:00:00.000Z",
    kind: "apply_result",
    content: [
      "Live action plan could not complete its first action.",
      'Failed action 1: Insert Live device "Drift" on track "Arp".',
      "No actions from this plan were completed.",
      "Failed to insert device",
    ].join("\n"),
  }];
  const harness = await createDialogHarness(state);
  try {
    const item = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-item.apply_result",
    );
    assert.equal(item?.open, true);
    assert.equal(item?.querySelector("summary")?.textContent?.startsWith("Apply Failed —"), true);
    assert.match(item?.textContent ?? "", /No actions from this plan were completed/);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a reconciled persisted failure keeps full detail in timeline instead of status", async () => {
  const state = stateFixture();
  const failureDetail = "HOST-FAILURE-DETAIL: failed action 10 on FB Lead.";
  state.events = [{
    id: "event-persisted-error",
    createdAt: "2026-08-06T00:00:00.000Z",
    kind: "error",
    content: failureDetail,
  }];
  const harness = await createDialogHarness(state);
  try {
    harness.failNextSend(failureDetail, "persisted");
    harness.input("#prompt", "Continue safely");
    harness.click("#sendButton");
    await harness.settle();

    const status = harness.document.querySelector("#status")?.textContent ?? "";
    const timeline = harness.document.querySelector("#timeline")?.textContent ?? "";
    assert.match(status, /timeline/i);
    assert.doesNotMatch(status, /HOST-FAILURE-DETAIL/);
    assert.match(timeline, /HOST-FAILURE-DETAIL/);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Send keeps its attempt busy when the HTTP fallback state is unavailable", async () => {
  const harness = await createDialogHarness();
  try {
    harness.failNextState("Bridge state is unavailable.");
    harness.input("#prompt", "Do not silently settle this send");
    harness.click("#sendButton");
    await harness.settle();

    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      true,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /outcome|state.*unavailable/i,
    );

    harness.click("#sendButton");
    await harness.settle();

    assert.deepEqual(harness.stopIds, [sendId]);
    assert.deepEqual(
      harness.calls
        .filter((call) => ["/send", "/stop", "/state"].includes(call.path))
        .map((call) => call.path),
      ["/send", "/state", "/stop", "/state"],
    );
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

for (const promptPersistence of ["persisted", undefined] as const) {
  test(`a ${promptPersistence ?? "unknown"} send failure stays busy until authoritative state recovers`, async () => {
    const harness = await createDialogHarness();
    try {
      harness.failNextSend("The model request failed.", promptPersistence);
      if (promptPersistence === "persisted") {
        harness.failNextState("Bridge state is unavailable.");
      } else {
        harness.rejectNextState("Bridge state is unavailable.");
      }
      harness.input("#prompt", "Do not duplicate this persisted prompt");
      harness.click("#sendButton");
      await harness.settle();

      const sendId = harness.sendIds[0];
      assert.ok(sendId);
      assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
      assert.equal(
        harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
        true,
      );
      assert.equal(
        harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
        "",
      );
      assert.match(
        harness.document.querySelector("#status")?.textContent ?? "",
        /authoritative state.*unavailable/i,
      );

      harness.click("#sendButton");
      await harness.settle();

      assert.deepEqual(harness.stopIds, [sendId]);
      assert.deepEqual(
        harness.calls
          .filter((call) => ["/send", "/stop", "/state"].includes(call.path))
          .map((call) => call.path),
        ["/send", "/state", "/stop", "/state"],
      );
      assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
      assert.equal(
        harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
        false,
      );
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}

test("an authoritative error SSE settles a persisted send without another state read", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Keep the terminal search result");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    const authoritativeState = cloneState(stateFixture());
    authoritativeState.events = [
      {
        id: "event-search-failed",
        createdAt: "2026-08-06T00:00:01.000Z",
        kind: "web_search",
        content: "Web Search failed before result pages were returned.",
        webSearch: {
          id: "search-failed",
          status: "failed",
          action: "search",
          queries: ["current source"],
          sources: [],
        },
      },
      {
        id: "event-request-error",
        createdAt: "2026-08-06T00:00:02.000Z",
        kind: "error",
        content: "The model request failed after Web Search.",
      },
    ];
    authoritativeState.sessionActivities = [{
      sessionId: "session-1",
      sendId,
      status: "failed",
      message: "The model request failed after Web Search.",
      unread: false,
    }];
    harness.failNextState("Bridge state is unavailable.");
    harness.emitServerEvent({
      type: "error",
      sendId,
      sessionId: "session-1",
      message: "The model request failed after Web Search.",
      promptPersistence: "persisted",
      state: authoritativeState,
    });
    await harness.settle();

    assert.equal(harness.calls.some((call) => call.path === "/state"), false);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      false,
    );
    assert.equal(
      harness.document.querySelector('[data-event-id="event-search-failed"]')
        ?.textContent?.includes("Web Search failed"),
      true,
    );
    assert.equal(
      harness.document.querySelector('[data-event-id="event-request-error"]')
        ?.textContent?.includes("model request failed"),
      true,
    );
    assert.deepEqual(harness.errors, []);

    harness.releaseHeldSend();
    await harness.settle();
  } finally {
    harness.close();
  }
});

test("an SSE send error restores once before the matching HTTP error arrives", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Restore exactly once");
    harness.holdNextSend();
    harness.failNextSend("Profile validation failed.", "not_persisted");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.emitServerEvent({
      type: "error",
      sendId,
      message: "Profile validation failed.",
      promptPersistence: "not_persisted",
    });
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Restore exactly once",
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Restore exactly once",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an SSE done settles its send before a late HTTP failure or command error", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Completed through SSE");
    harness.holdNextSend();
    harness.failNextSend("Late HTTP transport loss.");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.emitServerEvent({ type: "done", sendId, state: cloneState(stateFixture()) });
    harness.emitServerEvent({ type: "error", message: "Command failed separately." });
    await harness.settle();

    assert.equal(harness.document.querySelector("#status")?.textContent, "Command failed separately.");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.document.querySelector("#status")?.textContent, "Command failed separately.");
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /send result is unknown/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("late SSE from send A cannot settle send B or restore A over B", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Prompt A");
    harness.click("#sendButton");
    await harness.settle();
    const sendA = harness.sendIds[0];
    assert.ok(sendA);

    harness.input("#prompt", "Prompt B");
    harness.holdNextSend();
    harness.failNextSend("Prompt B was rejected before persistence.", "not_persisted");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendB = harness.sendIds[1];
    assert.ok(sendB);
    assert.notEqual(sendB, sendA);

    harness.emitServerEvent({
      type: "done",
      sendId: sendA,
      state: cloneState(stateFixture()),
    });
    harness.emitServerEvent({
      type: "error",
      sendId: sendA,
      message: "Late failure from Prompt A.",
      promptPersistence: "persisted",
    });
    await harness.settle();

    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      true,
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Prompt B",
    );
    assert.notEqual(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Prompt A",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

for (const promptPersistence of ["persisted", undefined] as const) {
  test(`Send does not restore a ${promptPersistence ?? "network-unknown"} prompt result`, async () => {
    const harness = await createDialogHarness();
    try {
      harness.input("#prompt", "Do not duplicate this prompt");
      harness.failNextSend("The model request failed.", promptPersistence);
      harness.click("#sendButton");
      await harness.settle();

      assert.equal(
        harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
        "",
      );
      assert.equal(
        harness.calls.some((call) => call.path === "/state"),
        true,
      );
      assert.match(
        harness.document.querySelector("#status")?.textContent ?? "",
        /timeline|session|before trying again/i,
      );
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}
