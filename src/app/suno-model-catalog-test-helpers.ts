import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import type { TestContext } from "node:test";
import { URL } from "node:url";
import type { LiveInteractionContext } from "../live/context.js";
import { resolveFetchImplementation } from "../runtime/host.js";
import { SunoSessions } from "../storage/suno-sessions.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { runAgentFlow, type AgentFlowDependencies } from "./agent-flow.js";
import { liveContextPresentationFixture } from "./live-context.test-harness.js";
import { saveIntegrationConnection } from "./integration-connection-test-helpers.js";

export const connection = { id: "suno-one", name: "My Suno", provider: "suno" as const, enabled: false, apiKey: "" };
export const token = (claims: object) => [JSON.stringify({ alg: "RS256" }), JSON.stringify(claims), "synthetic-signature"]
  .map((part) => Buffer.from(part).toString("base64url")).join(".");
export const clientCookie = (claims: object) => `__client=${token(claims)}`;
export const session = { clientToken: clientCookie({ client: "fixture" }), accountId: "user_fixture" };
export const models = [
  { id: "model-fixture", name: "Fixture model", canUse: true, isDefault: true },
  { id: "model-denied", name: "Denied model", canUse: false, isDefault: false },
  { id: "model-unknown", name: "Unverified model" },
];
export const catalog = () => ({ query: "catalog" as const, models: models.map((model) => ({ ...model, maxLengths: { title: 80 } })),
  creditsLeft: 123, plan: "Private plan" });
export type Reader = NonNullable<AgentFlowDependencies["readSunoMusicService"]>;

export async function storageFixture(t: TestContext, enabled = false) {
  const storage = await fs.mkdtemp("/private/tmp/live-smith-suno-models-");
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  await saveIntegrationConnection(storage, "0", { ...connection, enabled });
  await new SunoSessions(storage).save(connection.id, session);
  return storage;
}

export function route(url: string, pathname: string) {
  const endpoint = new URL(url); endpoint.pathname = pathname; return endpoint;
}

export async function post(url: string, body: unknown, commandId = "catalog-load", pathname = "/command") {
  return resolveFetchImplementation()(route(url, pathname), { method: "POST", headers: {
    "Content-Type": "application/json", "X-Live-Smith-Command-Id": commandId,
  }, body: JSON.stringify(body) });
}

export async function state(url: string): Promise<ChatDialogState> {
  const response = await resolveFetchImplementation()(route(url, "/state"));
  assert.equal(response.status, 200);
  return response.json() as Promise<ChatDialogState>;
}

export async function flow(storage: string, dialog: (url: string) => Promise<void>, read: Reader = async () => catalog()) {
  const interaction: LiveInteractionContext = { presentation: liveContextPresentationFixture("Audio"), summary: "Track: Audio",
    target: {}, scope: { kind: "track", identity: "track-catalog", label: "Audio" } };
  interaction.selectionContext = { refresh: () => interaction };
  return runAgentFlow({ application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: storage },
    ui: { showModalDialog: dialog },
  } as never, interaction, { renderHtml: () => "<html></html>", readSunoMusicService: read,
    verifySunoSession: async () => ({ accountId: session.accountId }) });
}

/** Content snapshot only of the synthetic test directory. */
export async function files(storage: string): Promise<unknown> {
  return Promise.all((await fs.readdir(storage)).sort().map(async (name) => {
    const path = `${storage}/${name}`;
    return [name, (await fs.stat(path)).isDirectory() ? await files(path) : await fs.readFile(path, "utf8")];
  }));
}
