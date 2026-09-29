import { createSunoHttp, type SunoSessionRefreshHandler } from "./suno-http.js";

type SunoHttp = ReturnType<typeof createSunoHttp>;
export type SunoSession = { clientToken: string; accountId: string };
export type SunoMusicServiceRequest = {
  query: "catalog" | "library" | "persona";
  search?: string;
  cursor?: string;
  personaId?: string;
};

const LIMIT_FIELDS = ["title", "prompt", "tags", "negative_tags", "gpt_description_prompt"] as const;
type LimitField = (typeof LIMIT_FIELDS)[number];
export interface SunoMusicModel {
  id: string;
  name: string;
  canUse?: boolean;
  isDefault?: boolean;
  supportsDuration?: boolean;
  maxLengths: Partial<Record<LimitField, number>>;
  capabilities?: string[];
  features?: string[];
  allowedConditionCombinations?: string[][];
  supportsVariation?: boolean;
}

export function sunoObject(value: unknown, http: SunoHttp): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw http.fail("invalid response object.");
  return value as Record<string, unknown>;
}

export function sunoUuid(value: unknown, http: SunoHttp): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw http.fail("invalid clip or persona identifier.");
  }
  return value;
}

export function sunoActive(signal: AbortSignal, http: SunoHttp): void {
  if (!signal.aborted) return;
  const error = http.fail("request cancelled; a submitted remote task may still complete.");
  error.name = "AbortError";
  throw error;
}

// Only named display fields cross this boundary. No raw provider objects, URLs,
// credential-like tokens, error details, lyrics, or account metadata are exposed.
function display(value: unknown, secret: string, limit: number): string {
  if (typeof value !== "string") return "";
  return Array.from(value.split(secret).join("[REDACTED]")
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"']+/gu, "[URL]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED]")
    .replace(/\b(?:Bearer\s+|(?:api[_-]?key|authorization|cookie|token|secret)\s*[:=]\s*)\S+/giu, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " "))
    .slice(0, limit).join("").trim();
}

function opaqueCursor(value: unknown, session: SunoSession, http: SunoHttp): string {
  if (typeof value !== "string" || !/^[\x20-\x7e]{1,2048}$/u.test(value) || value.includes(session.clientToken)) {
    throw http.fail("invalid library cursor.");
  }
  return value;
}

/** Billing models are account evidence, never a hardcoded model-name registry. */
export async function readSunoCatalog(http: SunoHttp, session: SunoSession, signal: AbortSignal) {
  const body = sunoObject(await http.request("GET", "/api/billing/info/", undefined, signal), http);
  if (!Array.isArray(body.models) || body.models.length > 100) throw http.fail("invalid model catalog.");
  const projectModel = (entry: unknown, remaster = false): SunoMusicModel => {
    const model = sunoObject(entry, http);
    if (typeof model.external_key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(model.external_key) ||
        model.external_key.includes(session.clientToken)) throw http.fail("invalid catalog model identifier.");
    const limits = model.max_lengths == null ? {} : sunoObject(model.max_lengths, http);
    const maxLengths: SunoMusicModel["maxLengths"] = {};
    for (const key of LIMIT_FIELDS) {
      if (limits[key] === undefined) continue;
      const value = limits[key];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 100_000) {
        throw http.fail("invalid model text limit.");
      }
      maxLengths[key] = value;
    }
    const majorVersion = model.major_version;
    if (majorVersion !== undefined &&
      (typeof majorVersion !== "number" || !Number.isSafeInteger(majorVersion) || majorVersion < 0 || majorVersion > 100)) {
      throw http.fail("invalid catalog model major version.");
    }
    return {
      id: model.external_key, name: display(model.name, session.clientToken, 160),
      ...(typeof model.can_use === "boolean" ? { canUse: model.can_use } : {}),
      ...(typeof model.is_default_model === "boolean" ? { isDefault: model.is_default_model } : {}), maxLengths,
      ...(typeof majorVersion === "number" ? { supportsDuration: majorVersion >= 6 } : {}),
      ...(model.capabilities === undefined ? {} : { capabilities: evidenceList(model.capabilities, http) }),
      ...(model.features === undefined ? {} : { features: evidenceList(model.features, http) }),
      ...(model.allowed_condition_combinations === undefined ? {} : {
        allowedConditionCombinations: conditionCombinations(model.allowed_condition_combinations, http),
      }),
      ...(remaster ? { supportsVariation: supportsRemasterVariation(model.external_key) } : {}),
    };
  };
  const models = body.models.map((entry: unknown) => projectModel(entry));
  const remasterModels = body.remaster_model_types === undefined ? undefined : modelList(body.remaster_model_types, http).map((entry) => projectModel(entry, true));
  if (remasterModels && new Set(remasterModels.map((model) => model.id)).size !== remasterModels.length) throw http.fail("duplicate remaster model identifier.");
  if (new Set(models.map((model) => model.id)).size !== models.length) throw http.fail("duplicate catalog model identifier.");
  const credits = body.total_credits_left;
  const plan = body.plan && typeof body.plan === "object" && !Array.isArray(body.plan)
    ? display((body.plan as Record<string, unknown>).name, session.clientToken, 80) : "";
  return {
    query: "catalog" as const, models,
    ...(remasterModels === undefined ? {} : { remasterModels }),
    ...(typeof credits === "number" && Number.isFinite(credits) && credits >= 0 && credits <= Number.MAX_SAFE_INTEGER
      ? { creditsLeft: credits } : {}),
    ...(plan ? { plan } : {}),
  };
}

export async function readSunoPersona(http: SunoHttp, session: SunoSession, id: string, signal: AbortSignal) {
  sunoUuid(id, http);
  // Exact persona lookup, including its identity, from paperfoot/suno-cli persona.rs.
  const body = sunoObject(await http.request("GET", `/api/persona/get-persona-paginated/${id}/?page=0`, undefined, signal), http);
  const persona = sunoObject(body.persona, http);
  if (sunoUuid(persona.id, http) !== id) throw http.fail("persona response does not match the requested identifier.");
  return { id, name: display(persona.name, session.clientToken, 160), description: display(persona.description, session.clientToken, 500) };
}

function projectClip(value: unknown, session: SunoSession, http: SunoHttp) {
  const clip = sunoObject(value, http);
  const metadata = clip.metadata == null ? {} : sunoObject(clip.metadata, http);
  const status = typeof clip.status === "string" && /^[a-z][a-z0-9_-]{0,63}$/u.test(clip.status)
    ? clip.status : "unknown";
  const duration = metadata.duration;
  return {
    id: sunoUuid(clip.id, http), title: display(clip.title, session.clientToken, 160), status,
    modelId: display(clip.model_name, session.clientToken, 128),
    styles: display(metadata.tags, session.clientToken, 500),
    ...(typeof duration === "number" && Number.isFinite(duration) && duration > 0 && duration <= 86_400
      ? { durationSeconds: duration } : {}),
    ...(typeof metadata.make_instrumental === "boolean" ? { instrumental: metadata.make_instrumental } : {}),
    ...(typeof metadata.has_stem === "boolean" ? { hasStems: metadata.has_stem } : {}),
    ...(typeof metadata.can_remix === "boolean" ? { canRemix: metadata.can_remix } : {}),
    ...(typeof clip.is_download_unlocked === "boolean" ? { downloadUnlocked: clip.is_download_unlocked } : {}),
  };
}

/** One bounded read; no pagination loop, generation, or inferred ownership. */
export async function readSunoMusicService(
  session: SunoSession, request: SunoMusicServiceRequest, signal: AbortSignal, fetchImpl?: typeof fetch,
  onSessionRefresh?: SunoSessionRefreshHandler,
) {
  const http = createSunoHttp(session, fetchImpl, onSessionRefresh);
  sunoActive(signal, http);
  const input = sunoObject(request, http);
  const fields = request.query === "library" ? ["query", "search", "cursor"]
    : request.query === "persona" ? ["query", "personaId"] : ["query"];
  if (Object.keys(input).some((key) => !fields.includes(key))) throw http.fail("unsupported music-service query parameter.");
  if (request.query === "catalog") return http.publicResult(await readSunoCatalog(http, session, signal));
  if (request.query === "persona") {
    const id = sunoUuid(request.personaId, http);
    return http.publicResult({ query: "persona" as const, persona: await readSunoPersona(http, session, id, signal) });
  }
  if (request.query !== "library") throw http.fail("unsupported music-service query.");
  if (request.search !== undefined && (typeof request.search !== "string" ||
      Array.from(request.search).length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(request.search) ||
      request.search.includes(session.clientToken))) throw http.fail("invalid library search.");
  const cursor = request.cursor === undefined ? undefined : opaqueCursor(request.cursor, session, http);
  const body = sunoObject(await http.request("POST", "/api/feed/v3", {
    limit: 20, ...(cursor === undefined ? {} : { cursor }),
    filters: { trashed: "False", ...(request.search === undefined ? {} : { searchText: request.search }) },
  }, signal), http);
  if (!Array.isArray(body.clips) || body.clips.length > 20 || typeof body.has_more !== "boolean") {
    throw http.fail("invalid or oversized library page.");
  }
  const clips = body.clips.map((clip: unknown) => projectClip(clip, session, http));
  if (new Set(clips.map((clip) => clip.id)).size !== clips.length) throw http.fail("duplicate library clip identifier.");
  const nextCursor = body.next_cursor == null ? undefined : opaqueCursor(body.next_cursor, session, http);
  if (body.has_more && (!nextCursor || nextCursor === cursor)) throw http.fail("missing or repeated library cursor.");
  return http.publicResult({ query: "library" as const, clips, hasMore: body.has_more, ...(nextCursor ? { nextCursor } : {}) });
}

function evidenceList(value: unknown, http: SunoHttp): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((entry) =>
    typeof entry !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(entry))) {
    throw http.fail("invalid model capability evidence.");
  }
  return [...value];
}
function conditionCombinations(value: unknown, http: SunoHttp): string[][] {
  if (!Array.isArray(value) || value.length > 100) throw http.fail("invalid model condition evidence.");
  return value.map((entry) => evidenceList(entry, http));
}
function modelList(value: unknown, http: SunoHttp): unknown[] {
  if (!Array.isArray(value) || value.length > 100) throw http.fail("invalid remaster model catalog.");
  return value;
}
/** First-party Remaster client capability mapping; kept inside the website protocol. */
function supportsRemasterVariation(id: string): boolean {
  return ["chirp-carp", "chirp-dorado", "chirp-flounder", "chirp-haddock", "chirp-halibut"].some((family) => id.includes(family));
}
