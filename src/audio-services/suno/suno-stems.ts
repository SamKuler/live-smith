import { randomUUID } from "node:crypto";
import { SUNO_STEM_BASE_ROLES, SUNO_STEM_ROLES, type SunoStemBaseRole, type AudioDownloadAuthorization, type AudioJob, type SunoStemRole } from "../contracts.js";
import type { createSunoHttp } from "./suno-http.js";
import { sunoObject, sunoUuid, type SunoSession } from "./suno-catalog.js";
import { sourceActionAllowed } from "./suno-editing.js";
import { downloadSunoClip } from "./suno-download.js";

type Http = ReturnType<typeof createSunoHttp>;
const stemGroups: Record<string, SunoStemBaseRole> = {
  Vocals: "suno_stem_vocals", Backing_Vocals: "suno_stem_backing_vocals", Drums: "suno_stem_drums",
  Bass: "suno_stem_bass", Guitar: "suno_stem_guitar", Keyboard: "suno_stem_keyboard", Percussion: "suno_stem_percussion",
  Strings: "suno_stem_strings", Synth: "suno_stem_synth", FX: "suno_stem_fx", Brass: "suno_stem_brass", Woodwinds: "suno_stem_woodwinds",
};
const stemNames: Record<string, SunoStemBaseRole> = {
  "Lead Vocal": "suno_stem_vocals", "Backing Vocals": "suno_stem_backing_vocals", "Drum Kit": "suno_stem_drums",
  Bass: "suno_stem_bass", Guitar: "suno_stem_guitar", Keyboards: "suno_stem_keyboard", Percussion: "suno_stem_percussion",
  "String Section": "suno_stem_strings", Synth: "suno_stem_synth", "Sound Effects": "suno_stem_fx",
  "Brass Section": "suno_stem_brass", Woodwinds: "suno_stem_woodwinds",
};
export const baseSunoStemRole = (role: SunoStemRole): SunoStemBaseRole => role.replace(/_alternative$/u, "") as SunoStemBaseRole;
export const isSunoStemRole = (value: unknown): value is SunoStemRole => SUNO_STEM_ROLES.includes(value as SunoStemRole);

export function sunoStemRole(clip: Record<string, unknown>, http: Http): SunoStemBaseRole {
  const metadata = sunoObject(clip.metadata, http);
  const group = typeof metadata.stem_type_group_name === "string" ? metadata.stem_type_group_name : undefined;
  const name = typeof metadata.stem_name === "string" ? metadata.stem_name : typeof metadata.stem === "string" ? metadata.stem : undefined;
  const role = group && Object.hasOwn(stemGroups, group) ? stemGroups[group] : name && Object.hasOwn(stemNames, name) ? stemNames[name] : undefined;
  if (!role) throw http.fail("stem output has no supported instrument identity.");
  return role;
}

export async function prepareSunoStems(http: Http, session: SunoSession, sourceId: string, signal: AbortSignal): Promise<object> {
  sunoUuid(sourceId, http);
  const billing = sunoObject(await http.request("GET", "/api/billing/info/", undefined, signal), http);
  const model = Array.isArray(billing.models) ? billing.models.find((entry) => entry?.external_key === "chirp-v3-5-b") : undefined;
  if (model?.can_use === false) throw http.fail("stem extraction is unavailable for this account.");
  const account = sunoObject(await http.request("GET", "/api/session/", undefined, signal), http);
  const owner = sunoObject(account.user, http);
  if (owner.clerk_id !== session.accountId || typeof owner.id !== "string") throw http.fail("account ownership could not be verified.");
  const featureEnabled = Array.isArray(billing.accessible_features) && billing.accessible_features.some((feature) =>
    feature && typeof feature === "object" && feature.name === "get_stems");
  const staff = account.roles && typeof account.roles === "object" && (account.roles as Record<string, unknown>).staff === true;
  const bypass = account.flags && typeof account.flags === "object" && (account.flags as Record<string, unknown>)["skip-paywall"] === true;
  if (!featureEnabled && !staff && !bypass) throw http.fail("this account does not expose stem extraction.");
  const clips = await http.request("GET", `/api/feed/?ids=${sourceId}`, undefined, signal);
  if (!Array.isArray(clips) || clips.length !== 1) throw http.fail("stem source is unavailable.");
  const source = sunoObject(clips[0], http);
  if (sunoUuid(source.id, http) !== sourceId || source.status !== "complete" || source.is_trashed === true ||
      source.download_disabled_reason || !sourceActionAllowed(source, "get_stems", source.user_id === owner.id)) {
    throw http.fail("source clip does not permit stem extraction on this account.");
  }
  const title = typeof source.title === "string" && source.title.length <= 200 ? source.title : "";
  return { token: null, token_provider: null, generation_type: "TEXT", task: "gen_stem", mv: "chirp-v3-5-b",
    title, tags: "", negative_tags: "", prompt: "", make_instrumental: true, user_uploaded_images_b64: null,
    continue_clip_id: sourceId, stem_type_id: 91, stem_type_group_name: "Twelve", stem_task: "twelve",
    transaction_uuid: randomUUID(), metadata: { web_client_pathname: "/create", create_mode: "custom", is_remix: true,
      create_session_token: randomUUID(), disable_volume_normalization: false },
  };
}

export function sunoStemManifest(value: unknown, http: Http): NonNullable<AudioJob["expectedOutputs"]> {
  const body = sunoObject(value, http);
  if (!Array.isArray(body.clips) || body.clips.length < 1 || body.clips.length > SUNO_STEM_ROLES.length) throw http.fail("invalid stem submission manifest.");
  const manifest = body.clips.map((raw, index) => {
    const clip = sunoObject(raw, http);
    const instrument = sunoStemRole(clip, http);
    const role: SunoStemRole = index < SUNO_STEM_BASE_ROLES.length ? instrument : `${instrument}_alternative`;
    return { key: sunoUuid(clip.id, http), role };
  }).sort((a, b) => a.key.localeCompare(b.key));
  if (new Set(manifest.map((entry) => entry.key)).size !== manifest.length ||
      new Set(manifest.map((entry) => entry.role)).size !== manifest.length) throw http.fail("duplicate stem output identity.");
  for (const entry of manifest) Object.freeze(entry);
  Object.freeze(manifest);
  return manifest;
}

/** Resolve download ownership from the selected stem's freshly read lineage. */
export async function downloadSunoStem(http: Http, clipId: string, role: SunoStemRole, signal: AbortSignal,
  authorizeDownload: boolean, authorization?: AudioDownloadAuthorization): Promise<Uint8Array> {
  const clips = await http.request("GET", `/api/feed/?ids=${sunoUuid(clipId, http)}`, undefined, signal);
  if (!Array.isArray(clips) || clips.length !== 1) throw http.fail("stem download source is unavailable.");
  const clip = sunoObject(clips[0], http);
  if (clip.id !== clipId || clip.status !== "complete" || sunoStemRole(clip, http) !== baseSunoStemRole(role)) throw http.fail("stem output changed before download.");
  const metadata = sunoObject(clip.metadata, http);
  const history = Array.isArray(metadata.history) ? metadata.history : [];
  let root: string | undefined;
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index];
    if (!entry || typeof entry !== "string" && typeof entry !== "object") continue;
    const rawId = typeof entry === "string" ? entry : typeof entry.id === "string" ? entry.id : undefined;
    const previous = history[index - 1];
    if (rawId && (typeof entry === "string" || entry.type !== "stem") &&
        (previous == null || typeof previous === "string" || previous.stem_task == null && previous.stem_from_id == null)) {
      root = rawId.replace(/^m_/u, ""); break;
    }
  }
  root ??= typeof metadata.stem_from_id === "string" ? metadata.stem_from_id : undefined;
  if (!root || sunoUuid(root, http) === clipId) throw http.fail("stem download permission owner is unavailable.");
  return downloadSunoClip(http, clipId, signal, authorizeDownload, authorization, root);
}
