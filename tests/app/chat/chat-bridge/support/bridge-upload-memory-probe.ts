import { once } from "node:events";
import { request } from "node:http";
import { createChatBridge } from "../../../../../src/app/chat/chat-bridge.js";
import type { ChatDialogState } from "../../../../../src/ui/chat-state.js";

async function main() {
  const total = 2 * 1024 * 1024 * 1024;
  const chunk = Buffer.alloc(64 * 1024);
  const state = {} as ChatDialogState;
  let received = 0;
  let peak = 0;
  const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "",
    handleCommand: async () => state, handleSend: async () => {}, preflightAttachmentUpload: async () => {},
    handleAttachmentStreamUpload: async input => {
      for await (const bytes of input.chunks) {
        received += bytes.byteLength;
        if (received % (32 * 1024 * 1024) < bytes.byteLength) {
          global.gc?.();
          peak = Math.max(peak, process.memoryUsage().rss);
        }
      }
      return state;
    } });
  try {
    const target = new URL(bridge.url); target.pathname = "/attachments";
    target.searchParams.set("sessionId", "s"); target.searchParams.set("fileName", "a.wav");
    global.gc?.(); const baseline = process.memoryUsage().rss;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(target, { method: "POST", headers: { "content-type": "application/octet-stream", "content-length": String(total) } }, response => {
        response.resume(); response.once("end", () => resolve(response.statusCode));
      });
      req.once("error", reject);
      void (async () => {
        for (let offset = 0; offset < total; offset += chunk.byteLength) if (!req.write(chunk)) await once(req, "drain");
        req.end();
      })().catch(reject);
    });
    console.log(JSON.stringify({ status, received, rssGrowth: peak - baseline }));
  } finally { await bridge.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
