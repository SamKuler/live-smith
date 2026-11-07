import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { release } from "node:os";
import process from "node:process";
import { URL } from "node:url";
import { isArtifactRef, artifactKey, type ArtifactRef } from "../agent/artifact-contracts.js";
import { isSafeStorageId } from "../storage/id.js";
import { createHostAbortController, throwIfAborted } from "./host.js";
import { stageNativeApp } from "./native-app.js";

declare const __LIVE_SMITH_NATIVE_CHAT_CAPSULE__: string;
export class NativeChatCancelledError extends Error {
  constructor() { super("Native chat opening was cancelled."); this.name = "NativeChatCancelledError"; }
}
export interface NativeDragFile { filePath: string; discard(): Promise<void> }
export interface NativeDragInput { sessionId: string; artifact: ArtifactRef }
export interface NativeChatWindow {
  close(): void;
  readonly closed: Promise<void>;
}
export interface NativeChatHost {
  readonly supported: boolean;
  open(input: { url: string; signal?: AbortSignal; prepareArtifact(input: NativeDragInput, signal: AbortSignal): Promise<NativeDragFile> }): Promise<NativeChatWindow>;
}
interface Options {
  platform?: NodeJS.Platform; osRelease?: string; capsule?: string;
  launch?: (executable: string) => ChildProcessWithoutNullStreams;
}
const failure = () => new Error("The separate window could not open. Try again or choose System browser in App Preferences.");
const requestId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,96}$/u.test(value);

export function createNativeChatHost(options: Options = {}): NativeChatHost {
  const capsule = options.capsule ?? (typeof __LIVE_SMITH_NATIVE_CHAT_CAPSULE__ === "string" ? __LIVE_SMITH_NATIVE_CHAT_CAPSULE__ : "");
  const supported = (options.platform ?? process.platform) === "darwin" && Number((options.osRelease ?? release()).split(".")[0]) >= 23 && Boolean(capsule);
  const launch = options.launch ?? (executable => spawn(executable, [], { env: {}, stdio: ["pipe", "pipe", "pipe"] }));
  return {
    supported,
    async open(input) {
      throwIfAborted(input.signal);
      if (!supported) throw new Error("Native chat requires macOS 14 or later. Choose Live dialog or System browser.");
      const url = new URL(input.url);
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/chat" || !url.searchParams.get("token") || url.username || url.password) throw failure();
      const app = await stageNativeApp(capsule, "Live Smith", "live-smith-native-chat-").catch(() => { throw failure(); });
      try { throwIfAborted(input.signal); } catch (error) { await app.dispose(); throw error; }
      const controller = createHostAbortController();
      const entries = new Map<string, { token: string; claimed: boolean; prepared: Promise<NativeDragFile> }>();
      const tokens = new Map<string, { token: string; claimed: boolean; prepared: Promise<NativeDragFile> }>();
      let child: ChildProcessWithoutNullStreams;
      try { child = launch(app.executable); }
      catch { await app.dispose(); throw failure(); }
      let closed = false;
      let stopping = false;
      let ready = false;
      let startupCancelled = false;
      let resolveClosed!: () => void;
      const closedPromise = new Promise<void>(resolve => { resolveClosed = resolve; });
      const write = (message: unknown) => { if (!closed && !stopping && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + "\n"); };
      let finishPromise: Promise<void> | undefined;
      const finish = () => finishPromise ??= (async () => {
        closed = true; controller.abort();
        await Promise.allSettled([...entries.values()].map(async entry => {
          const file = await entry.prepared;
          if (!entry.claimed) await file.discard();
        }));
        await app.dispose().catch(() => {}); resolveClosed();
      })();
      return new Promise<NativeChatWindow>((resolve, reject) => {
        let buffer = "";
        const deadline = setTimeout(() => fail(), 30_000);
        const fail = () => {
          if (stopping) return;
          stopping = true; clearTimeout(deadline); child.kill();
          if (!ready) reject(input.signal?.aborted ? input.signal.reason : failure());
        };
        input.signal?.addEventListener("abort", fail, { once: true });
        child.once("error", () => { fail(); void finish(); });
        child.once("close", () => {
          input.signal?.removeEventListener("abort", fail);
          if (startupCancelled) {
            void finish().then(() => reject(new NativeChatCancelledError()));
          } else {
            if (!ready) fail();
            void finish();
          }
        });
        child.stdin.on("error", fail);
        child.stderr.resume();
        child.stdout.setEncoding("utf8");
        const receive = (message: unknown) => {
          if (!message || typeof message !== "object" || Array.isArray(message)) { fail(); return; }
          const value = message as Record<string, unknown>;
          if (value.type === "cancelled" && Object.keys(value).length === 1 && !ready) {
            startupCancelled = stopping = true;
            clearTimeout(deadline); child.kill(); return;
          }
          if (value.type === "ready" && Object.keys(value).length === 1 && !ready) {
            ready = true; clearTimeout(deadline); resolve({ close: fail, closed: closedPromise }); return;
          }
          if (value.type === "prepare" && requestId(value.id) && isSafeStorageId(value.sessionId) && isArtifactRef(value.artifact) && value.artifact.kind !== "device-parameters") {
            const id = value.id;
            const key = `${value.sessionId}:${artifactKey(value.artifact)}`;
            let entry = entries.get(key);
            if (!entry) {
              entry = { token: randomUUID(), claimed: false,
                prepared: Promise.resolve().then(() => input.prepareArtifact({ sessionId: value.sessionId as string, artifact: value.artifact as ArtifactRef }, controller.signal)) };
              entries.set(key, entry); tokens.set(entry.token, entry);
            }
            const selected = entry;
            void selected.prepared.then(file => {
              write({ type: "prepared", id, token: selected.token, filePath: file.filePath });
            }, () => {
              if (entries.get(key) === selected) { entries.delete(key); tokens.delete(selected.token); }
              write({ type: "prepare_failed", id });
            });
            return;
          }
          if (value.type === "claim" && requestId(value.id) && typeof value.token === "string") {
            const entry = tokens.get(value.token);
            if (!entry) { write({ type: "claim_failed", id: value.id }); return; }
            // Commit retention before allowing AppKit to hand a path to another application.
            entry.claimed = true;
            write({ type: "claimed", id: value.id, token: entry.token }); return;
          }
          fail();
        };
        child.stdout.on("data", chunk => {
          if (closed || stopping) return;
          buffer += String(chunk);
          if (buffer.length > 65_536) { fail(); return; }
          let newline: number;
          while (!stopping && (newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            try { receive(JSON.parse(line)); } catch { fail(); return; }
          }
        });
        if (input.signal?.aborted) fail();
        else write({ protocol: 1, url: input.url });
      });
    },
  };
}
