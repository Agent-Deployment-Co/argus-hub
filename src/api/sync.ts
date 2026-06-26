import type {
  HubStore, HubUploadRows, UploadedFingerprintEntry,
  UploadedInteraction, UploadedInvocation, UploadedSession, UploadedTask, UploadedUsage,
} from "../store/hub-store.ts";
import type { Context } from "hono";

// Argus client store schema versions this Hub can ingest. Bump the upper bound when a new client
// adds columns the Hub knows how to read; the lower bound matches what `hub-store.ts` expects.
// v17 added only the client-side `hub_session_cursors` table (per-Hub upload cursors); it changed
// none of the uploaded `resolved_*` row shapes, so it ingests identically to v16.
export const HUB_MIN_CLIENT_SCHEMA_VERSION = 10;
export const HUB_MAX_CLIENT_SCHEMA_VERSION = 17;

const CLIENT_ID_HEADER = "X-Argus-Client";

// ---- Hono handler factory ---------------------------------------------------------------

/** Returns a Hono handler for `POST /api/sync`. Auth is checked before the body is buffered. */
export function syncHandler(store: HubStore) {
  return async (c: Context): Promise<Response> => {
    // Auth before body — avoid processing the upload on a bad key.
    const token = parseBearerToken(c.req.header("Authorization"));
    if (!token) return c.json({ error: "Missing or malformed Authorization header." }, 401);
    const key = await store.lookupApiKey(token);
    if (!key || !key.isEnabled) return c.json({ error: "Invalid or disabled API key." }, 401);

    const clientId = c.req.header(CLIENT_ID_HEADER)?.trim() ?? "";
    if (!clientId) return c.json({ error: `Missing ${CLIENT_ID_HEADER} header.` }, 400);
    if (!isClientId(clientId)) return c.json({ error: `Malformed ${CLIENT_ID_HEADER} header.` }, 400);

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "Request body is not valid JSON." }, 400);
    }

    const parsed = parseUploadPayload(payload);
    if ("error" in parsed) return c.json({ error: parsed.error }, parsed.status);

    // Register the client (idempotent), append any new fingerprint observations, then run the
    // auto-mapper to attach (or refresh) the client → user link. Reads scope by user_id, so
    // dashboards roll up across all of this user's clients.
    await store.upsertClient(key.orgId, clientId);
    if (parsed.fingerprint.length) {
      await store.recordFingerprintObservations(clientId, parsed.fingerprint);
    }
    const userId = await store.resolveUserForClient(key.orgId, clientId);
    const { sessionsUpserted } = await store.upsertClientSessions(key.orgId, clientId, parsed.rows);
    const usersKnown = await store.countUsers(key.orgId);

    return c.json({ sessionsUpserted, usersKnown, userId });
  };
}

// ---- Unknown-sessions probe -------------------------------------------------------------

/** Cap on session IDs accepted per request, to bound server work. */
export const MAX_SESSION_IDS_PER_REQUEST = 10_000;

/**
 * Returns a Hono handler for `POST /api/sync/unknown-sessions`. The client posts
 * `{ sessionIds: string[] }`; the response lists the IDs the Hub does NOT yet have for
 * this client. Uses the same API-key + X-Argus-Client auth as `POST /api/sync`.
 */
export function unknownSessionsHandler(store: HubStore) {
  return async (c: Context): Promise<Response> => {
    const token = parseBearerToken(c.req.header("Authorization"));
    if (!token) return c.json({ error: "Missing or malformed Authorization header." }, 401);
    const key = await store.lookupApiKey(token);
    if (!key || !key.isEnabled) return c.json({ error: "Invalid or disabled API key." }, 401);

    const clientId = c.req.header(CLIENT_ID_HEADER)?.trim() ?? "";
    if (!clientId) return c.json({ error: `Missing ${CLIENT_ID_HEADER} header.` }, 400);
    if (!isClientId(clientId)) return c.json({ error: `Malformed ${CLIENT_ID_HEADER} header.` }, 400);

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "Request body is not valid JSON." }, 400);
    }

    const parsed = parseSessionIdsPayload(payload);
    if ("error" in parsed) return c.json({ error: parsed.error }, parsed.status);

    // Register the client even on the probe — it's the first call of a sync, and we want the
    // clients row to exist so resolved_sessions' FK doesn't fail later.
    await store.upsertClient(key.orgId, clientId);
    const unknownSessionIds = await store.findUnknownSessionIds(key.orgId, clientId, parsed.sessionIds);
    return c.json({ unknownSessionIds });
  };
}

type SessionIdsParseResult =
  | { sessionIds: string[] }
  | { error: string; status: 400 };

export function parseSessionIdsPayload(payload: unknown): SessionIdsParseResult {
  if (!payload || typeof payload !== "object") {
    return { error: "Request body must be a JSON object.", status: 400 };
  }
  const raw = (payload as { sessionIds?: unknown }).sessionIds;
  if (!Array.isArray(raw)) {
    return { error: "Missing sessionIds array.", status: 400 };
  }
  if (raw.length > MAX_SESSION_IDS_PER_REQUEST) {
    return {
      error: `Too many sessionIds (${raw.length}); max ${MAX_SESSION_IDS_PER_REQUEST} per request.`,
      status: 400,
    };
  }
  const sessionIds: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !v) {
      return { error: "sessionIds must be a list of non-empty strings.", status: 400 };
    }
    sessionIds.push(v);
  }
  return { sessionIds };
}

// ---- Bearer token parsing ---------------------------------------------------------------

export function parseBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m?.[1];
}

const CLIENT_ID_RE = /^client-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isClientId(value: string): boolean {
  return CLIENT_ID_RE.test(value);
}

// ---- JSON payload parsing ---------------------------------------------------------------

type ParseResult =
  | { rows: HubUploadRows; fingerprint: UploadedFingerprintEntry[] }
  | { error: string; status: 400 | 422 };

/**
 * Validate the JSON body shape and schema version, returning the resolved_* rows + fingerprint
 * observations ready for ingest, or an error descriptor. Missing per-row columns become `null`
 * so older clients can sync.
 */
export function parseUploadPayload(payload: unknown): ParseResult {
  if (!payload || typeof payload !== "object") {
    return { error: "Request body must be a JSON object.", status: 400 };
  }
  const obj = payload as { schemaVersion?: unknown; rows?: unknown; fingerprint?: unknown };

  const schemaVersion = obj.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isFinite(schemaVersion)) {
    return { error: "Missing or invalid schemaVersion.", status: 400 };
  }
  if (schemaVersion > HUB_MAX_CLIENT_SCHEMA_VERSION) {
    return {
      error:
        `Argus client version too new for this Hub (store v${schemaVersion}, Hub supports up to v${HUB_MAX_CLIENT_SCHEMA_VERSION}). Update Argus Hub.`,
      status: 422,
    };
  }
  if (schemaVersion < HUB_MIN_CLIENT_SCHEMA_VERSION) {
    return {
      error:
        `Client store schema is too old (v${schemaVersion}). Run \`argus index\` to migrate, then sync again.`,
      status: 422,
    };
  }

  const raw = obj.rows;
  if (!raw || typeof raw !== "object") {
    return { error: "Missing rows object.", status: 400 };
  }
  const r = raw as Record<string, unknown>;
  const sessions = asArray<UploadedSession>(r.sessions);
  const usage = asArray<UploadedUsage>(r.usage);
  const tasks = asArray<UploadedTask>(r.tasks);
  const interactions = asArray<UploadedInteraction>(r.interactions);
  const invocations = asArray<UploadedInvocation>(r.invocations);
  if (!sessions || !usage || !tasks || !interactions || !invocations) {
    return { error: "rows must contain sessions, usage, tasks, interactions, invocations arrays.", status: 400 };
  }

  const fingerprint = parseFingerprint(obj.fingerprint);
  if ("error" in fingerprint) return fingerprint;

  return {
    rows: {
      sessions: sessions.map(normalizeSession),
      usage,
      tasks,
      interactions,
      invocations: invocations.map(normalizeInvocation),
    },
    fingerprint: fingerprint.entries,
  };
}

function parseFingerprint(
  raw: unknown,
): { entries: UploadedFingerprintEntry[] } | { error: string; status: 400 } {
  if (raw === undefined || raw === null) return { entries: [] };
  if (!Array.isArray(raw)) return { error: "fingerprint must be an array.", status: 400 };
  const entries: UploadedFingerprintEntry[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") {
      return { error: "fingerprint entries must be { key, value, tsMs } objects.", status: 400 };
    }
    const e = v as { key?: unknown; value?: unknown; tsMs?: unknown };
    if (typeof e.key !== "string" || !e.key) {
      return { error: "fingerprint.key must be a non-empty string.", status: 400 };
    }
    if (typeof e.value !== "string") {
      return { error: "fingerprint.value must be a string.", status: 400 };
    }
    if (typeof e.tsMs !== "number" || !Number.isFinite(e.tsMs)) {
      return { error: "fingerprint.tsMs must be a number.", status: 400 };
    }
    entries.push({ key: e.key, value: e.value, tsMs: e.tsMs });
  }
  return { entries };
}

function asArray<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? (value as T[]) : undefined;
}

/** Older clients (pre-v12) lack the friction columns — fill with NULL. */
function normalizeSession(s: UploadedSession): UploadedSession {
  return {
    ...s,
    friction_interruptions: s.friction_interruptions ?? null,
    friction_rejections: s.friction_rejections ?? null,
    friction_compactions: s.friction_compactions ?? null,
    friction_turns: s.friction_turns ?? null,
    last_interruption_ms: s.last_interruption_ms ?? null,
  };
}

/** Older invocations rows may omit date/cwd/args/approx_result_tokens (added v12). */
function normalizeInvocation(v: UploadedInvocation): UploadedInvocation {
  return {
    ...v,
    date: v.date ?? null,
    cwd: v.cwd ?? null,
    args: v.args ?? null,
    approx_result_tokens: v.approx_result_tokens ?? 0,
  };
}
