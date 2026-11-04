import type { JSDOM } from "jsdom";
export interface NativeDragMessage { type: string; id: string; sessionId?: string; artifact?: { kind: string; id: string }; token?: string }
export const nativeBridge = { baseUrl: "http://bridge.test", token: "test-token", hostMode: "native" as const, nativeWindowAvailable: true, nativeArtifactDrag: true };
export function installNativeDragBridge(window: JSDOM["window"], messages: NativeDragMessage[]) {
  const target = window as unknown as { webkit?: { messageHandlers: Record<string, { postMessage(message: unknown): void }> } };
  target.webkit ??= { messageHandlers: {} };
  target.webkit.messageHandlers.nativeDrag = { postMessage: message => messages.push(JSON.parse(JSON.stringify(message)) as NativeDragMessage) };
}
export function replyNativeDrag(window: JSDOM["window"], message: { type: string; id: string; token?: string }) {
  (window as unknown as { LiveSmithNativeDrag: { receive(message: unknown): void } }).LiveSmithNativeDrag.receive(message);
}
