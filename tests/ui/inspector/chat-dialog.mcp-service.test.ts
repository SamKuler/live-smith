import assert from "node:assert/strict";
import test from "node:test";
import { commandCalls, createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";
import { sessionNativeTools } from "../../../src/app/tools/tool-runtime.js";
import { mcpHelperTools } from "../../../src/app/mcp/tool-results.js";
import { uiMessage } from "../../../src/i18n/ui-message.js";

function state() {
  return { ...stateFixture(), mcpServer: { settings: { enabled: false, port: 17853, revision: "0" }, status: "disabled" as const,
    url: "http://127.0.0.1:17853/mcp", clients: [] } };
}
test("external-client service settings are disclosed separately and preserve an in-progress draft", async () => {
  const h = await createDialogHarness(state());
  try {
    h.click("#extensionsTab"); h.click("#mcpExtensionTab");
    const outward = h.document.querySelector<HTMLDetailsElement>("#mcpOutwardService")!;
    assert.equal(outward.open, false);
    h.click("#mcpOutwardService > summary");
    assert.equal(outward.open, true);
    h.input("#mcpServerPort", "18553");
    h.click("#mcpOutwardService > summary"); h.click("#mcpOutwardService > summary");
    assert.equal(h.document.querySelector<HTMLInputElement>("#mcpServerPort")!.value, "18553");
    assert.deepEqual(commandCalls(h), []);
  } finally { h.close(); }
});
test("MCP settings save an explicit local service config and create a Session-bound client", async () => {
  const h = await createDialogHarness(state());
  try {
    h.click("#extensionsTab"); h.click("#mcpExtensionTab");
    h.click("#mcpServerEnabled"); h.input("#mcpServerPort", "18553"); h.click("#saveMcpServer"); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)?.body, { kind: "save_global_settings", mcpServer: { enabled: true, port: 18553 } });
    h.input("#mcpClientName", "Studio assistant"); h.click("#createMcpClient"); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)?.body, { kind: "create_mcp_client", name: "Studio assistant" });
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
test("one-time client config is cleared when leaving MCP settings", async () => {
  const token = `client.${"a".repeat(43)}`;
  const h = await createDialogHarness({ ...state(), mcpCredential: { clientId: "client", token, url: "http://127.0.0.1:17853/mcp" } });
  try {
    h.click("#extensionsTab"); h.click("#mcpExtensionTab");
    assert.match(h.document.querySelector<HTMLTextAreaElement>("#mcpClientConfig")!.value, /Bearer client/);
    h.click("#skillsExtensionTab"); h.click("#mcpExtensionTab");
    assert.equal(h.document.querySelector<HTMLTextAreaElement>("#mcpClientConfig")!.value, "");
    assert.equal(h.document.querySelector<HTMLElement>("#mcpClientCredential")!.hidden, true);
    assert.equal(h.document.querySelector("#timeline")!.textContent!.includes(token), false);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
test("external Apply uses the shared preview and resolves only the bound operation", async () => {
  const s = state();
  const actor = { kind: "mcp" as const, clientId: "client", clientName: "Composer" };
  const plan = { message: "Tempo", actions: [{ type: "set_tempo" as const, tempo: 128 }] };
  const h = await createDialogHarness({ ...s, events: [
    { id: "call", createdAt: "2026-10-16T00:00:00Z", kind: "tool_call", name: "apply_live_actions", content: JSON.stringify(plan), toolActor: actor, toolOperationId: "operation" },
    { id: "proposal", createdAt: "2026-10-16T00:00:01Z", kind: "apply_requested", content: "Tempo", toolActor: actor, toolOperationId: "operation", applyOperation: { id: "apply", status: "proposed", plan } },
  ], mcpApprovals: [{ actor, operationId: "operation", request: { kind: "apply", operationId: "apply", message: "Tempo", groups: [], plan } }] });
  try {
    const review = h.document.querySelector('[data-operation-id="apply"]');
    assert(review); assert.match(review.textContent ?? "", /128/);
    assert.match(h.document.querySelector(".timeline-activity-summary")!.textContent!, /Waiting for approval/);
    assert.equal(h.document.querySelector<HTMLElement>("#inspectorPane")!.hidden, true);
    assert.equal(h.document.querySelector(".chat-pane")!.hasAttribute("inert"), false);
    h.click('[data-operation-id="apply"] .primary'); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)?.body, { kind: "resolve_mcp_approval", sessionId: s.activeSessionId, operationId: "operation", approve: true });
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("external operations localize every native tool and preserve caller-authored text", async () => {
  const names = [...sessionNativeTools(true, true), ...mcpHelperTools].map(tool => tool.function.name).concat("upload_attachment");
  const actor = { kind: "mcp" as const, clientId: "client", clientName: "Studio Assistant" };
  const events = names.map((name, index) => ({ id: `event-${index}`, createdAt: "2026-10-17T00:00:00Z", kind: "operation" as const,
    content: "Completed", operation: { id: `operation-${index}`, actor, toolName: name, status: "completed" as const, progress: "completed" } }));
  const h = await createDialogHarness({ ...state(), settings: { ...state().settings, uiLanguage: "zh-CN" }, events });
  try {
    for (const [index, name] of names.entries()) {
      const text = h.document.querySelector(`[data-external-operation-id="operation-${index}"] summary`)!.textContent!;
      assert.match(text.split(" · ")[1]!, /\p{Script=Han}/u, name);
      assert(text.startsWith("Studio Assistant · "));
    }
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("external progress descriptors translate while raw file names stay literal", async () => {
  const actor = { kind: "mcp" as const, clientId: "client", clientName: "Studio Assistant" };
  const h = await createDialogHarness({ ...state(), settings: { ...state().settings, uiLanguage: "zh-CN" }, events: [
    { id: "progress", createdAt: "2026-10-17T00:00:00Z", kind: "operation", content: "Starting tool", operation: {
      id: "operation", actor, toolName: "save_midi_artifact", status: "running", progress: uiMessage("Starting tool"),
    } },
    { id: "upload", createdAt: "2026-10-17T00:00:01Z", kind: "operation", content: "External file uploaded", operation: {
      id: "upload", actor, toolName: "upload_attachment", status: "completed", progress: "Completed.wav",
    } },
  ] });
  try {
    assert.equal(h.document.querySelector('[data-external-operation-id="operation"] .timeline-content')!.textContent, "正在启动工具");
    assert.equal(h.document.querySelector('[data-external-operation-id="upload"] .timeline-content')!.textContent, "Completed.wav");
    h.click("#appTab"); h.select("#uiLanguage", "en"); await h.settle();
    assert.equal(h.document.querySelector('[data-external-operation-id="operation"] .timeline-content')!.textContent, "Starting tool");
    assert.equal(h.document.querySelector('[data-external-operation-id="upload"] .timeline-content')!.textContent, "Completed.wav");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
