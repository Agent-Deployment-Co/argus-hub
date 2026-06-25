import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import sqlite3, { type Database } from "sqlite3";
import { openHubStore, type HubStore, type HubUploadPayload } from "../src/store/hub-store.ts";
import { createHubApp } from "../src/api/serve.ts";
import { HUB_MAX_CLIENT_SCHEMA_VERSION, MAX_SESSION_IDS_PER_REQUEST, parseBearerToken, parseUploadPayload } from "../src/api/sync.ts";

// ---- Temp dir management ---------------------------------------------------------------

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "hub-sync-test-"));
  tempDirs.push(d);
  return d;
}

function newClientId(): string {
  return `client-${randomUUID()}`;
}

// ---- Upload payload fixture builder ----------------------------------------------------

interface FixtureSession {
  sessionId: string;
  source?: string;
  project?: string;
}

interface FixtureOptions {
  email?: string;
}

/** Build the JSON payload a client would POST to /api/sync for the given sessions. When
 *  `email` is set, includes a claude.oauth.email fingerprint observation so the auto-mapper
 *  has something to bucket the user on. */
function buildPayload(
  sessions: FixtureSession[],
  schemaVersion = HUB_MAX_CLIENT_SCHEMA_VERSION,
  opts: FixtureOptions = {},
): HubUploadPayload & { fingerprint?: Array<{ key: string; value: string; tsMs: number }> } {
  const base: HubUploadPayload = {
    schemaVersion,
    rows: {
      sessions: sessions.map(({ sessionId, source = "claude", project = "/Users/you/proj" }) => ({
        session_id: sessionId,
        source,
        project,
        cwd: project,
        first_ts: null,
        last_ts: null,
        message_count: 1,
        first_prompt: null,
        archived: 0,
        friction_interruptions: null,
        friction_rejections: null,
        friction_compactions: null,
        friction_turns: null,
        last_interruption_ms: null,
        meta_json: JSON.stringify({ sessionId, source, project, cwd: project }),
      })),
      usage: sessions.map(({ sessionId, source = "claude", project = "/Users/you/proj" }) => ({
        session_id: sessionId,
        seq: 0,
        source,
        ts: 1_000_000,
        date: "2026-01-01",
        cwd: project,
        project,
        record_json: JSON.stringify({
          sessionId, model: "claude-sonnet-4-6", ts: 1_000_000, date: "2026-01-01",
          source, project, cwd: project,
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
          toolUses: [],
        }),
        input_tokens: 100,
        output_tokens: 50,
        cache_read: 0,
        cache_write_5m: 0,
        cache_write_1h: 0,
        model: "claude-sonnet-4-6",
        attribution_skill: null,
        stop_reason: null,
        interaction_seq: null,
      })),
      tasks: [],
      interactions: [],
      invocations: [],
    },
  };
  if (opts.email) {
    return { ...base, fingerprint: [{ key: "claude.oauth.email", value: opts.email, tsMs: 1_000_000 }] };
  }
  return base;
}

// ---- Store + key helpers ---------------------------------------------------------------

function openDb(path: string, mode = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE): Promise<Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, mode, (err) => (err ? reject(err) : resolve(db)));
  });
}
function closeDb(db: Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

async function openTestStore(): Promise<{ store: HubStore; orgId: string; apiKey: string }> {
  const dir = tempDir();
  let printed = "";
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { printed += s; return true; };
  const store = await openHubStore(dir, 1_000_000);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = orig;

  const keyMatch = /Hub API key \(Default\): (hub-\S+)/.exec(printed);
  const apiKey = keyMatch?.[1] ?? "";

  const db = await openDb(join(dir, "hub.db"), sqlite3.OPEN_READONLY);
  const orgRow = await new Promise<{ org_id: string }>((resolve, reject) =>
    db.get("SELECT org_id FROM organizations LIMIT 1", (err, row: { org_id: string }) => (err ? reject(err) : resolve(row))),
  );
  await closeDb(db);

  return { store, orgId: orgRow.org_id, apiKey };
}

// ---- parseBearerToken ------------------------------------------------------------------

describe("parseBearerToken", () => {
  test("extracts token from valid header", () => {
    expect(parseBearerToken("Bearer hub-abc123")).toBe("hub-abc123");
    expect(parseBearerToken("bearer hub-abc123")).toBe("hub-abc123");
  });
  test("returns undefined for missing or malformed header", () => {
    expect(parseBearerToken(undefined)).toBeUndefined();
    expect(parseBearerToken("")).toBeUndefined();
    expect(parseBearerToken("Basic abc")).toBeUndefined();
    expect(parseBearerToken("Bearer")).toBeUndefined();
  });
});

// ---- parseUploadPayload ----------------------------------------------------------------

describe("parseUploadPayload", () => {
  test("accepts a well-formed payload", () => {
    const result = parseUploadPayload(buildPayload([{ sessionId: "s1" }, { sessionId: "s2" }]));
    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected rows");
    expect(result.rows.sessions).toHaveLength(2);
    expect(result.rows.usage).toHaveLength(2);
    expect(result.fingerprint).toEqual([]);
  });

  test("extracts the fingerprint array when present", () => {
    const payload = buildPayload([{ sessionId: "s" }], HUB_MAX_CLIENT_SCHEMA_VERSION, { email: "x@y" });
    const result = parseUploadPayload(payload);
    if ("error" in result) throw new Error("expected rows");
    expect(result.fingerprint).toEqual([{ key: "claude.oauth.email", value: "x@y", tsMs: 1_000_000 }]);
  });

  test("returns 400 when fingerprint is not an array", () => {
    const payload = { ...buildPayload([{ sessionId: "s" }]), fingerprint: "nope" };
    const result = parseUploadPayload(payload);
    expect("error" in result && result.status).toBe(400);
  });

  test("returns 400 for a non-object payload", () => {
    const result = parseUploadPayload("not an object");
    expect("error" in result && result.status).toBe(400);
  });

  test("returns 400 for missing schemaVersion", () => {
    const result = parseUploadPayload({ rows: {} });
    expect("error" in result && result.status).toBe(400);
  });

  test("returns 400 when rows is missing", () => {
    const result = parseUploadPayload({ schemaVersion: HUB_MAX_CLIENT_SCHEMA_VERSION });
    expect("error" in result && result.status).toBe(400);
  });

  test("returns 422 when schemaVersion is newer than the hub supports", () => {
    const result = parseUploadPayload(buildPayload([{ sessionId: "s" }], HUB_MAX_CLIENT_SCHEMA_VERSION + 1));
    expect("error" in result && result.status).toBe(422);
  });

  test("returns 422 when schemaVersion is older than the minimum", () => {
    const result = parseUploadPayload(buildPayload([{ sessionId: "s" }], 9));
    expect("error" in result && result.status).toBe(422);
  });
});

// ---- POST /api/sync (Hono integration) -------------------------------------------------

async function postSync(app: ReturnType<typeof createHubApp>, headers: Record<string, string>, payload: unknown): Promise<Response> {
  return await app.request("/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/sync", () => {
  test("returns 401 with no Authorization header", async () => {
    const { store } = await openTestStore();
    const app = createHubApp(store);
    try {
      const res = await postSync(app, { "X-Argus-Client": newClientId() }, buildPayload([{ sessionId: "s" }]));
      expect(res.status).toBe(401);
    } finally {
      await store.close();
    }
  });

  test("returns 401 for an invalid API key", async () => {
    const { store } = await openTestStore();
    const app = createHubApp(store);
    try {
      const res = await postSync(app, {
        Authorization: "Bearer hub-invalid-key",
        "X-Argus-Client": newClientId(),
      }, buildPayload([{ sessionId: "s" }]));
      expect(res.status).toBe(401);
    } finally {
      await store.close();
    }
  });

  test("returns 400 with no X-Argus-Client header", async () => {
    const { store, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const res = await postSync(app, {
        Authorization: `Bearer ${apiKey}`,
      }, buildPayload([{ sessionId: "s" }]));
      expect(res.status).toBe(400);
    } finally {
      await store.close();
    }
  });

  test("returns 400 when X-Argus-Client is malformed", async () => {
    const { store, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const res = await postSync(app, {
        Authorization: `Bearer ${apiKey}`,
        "X-Argus-Client": "not-a-client-id",
      }, buildPayload([{ sessionId: "s" }]));
      expect(res.status).toBe(400);
    } finally {
      await store.close();
    }
  });

  test("returns 400 for a non-JSON body", async () => {
    const { store, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const res = await app.request("/api/sync", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Argus-Client": newClientId(),
          "Content-Type": "application/json",
        },
        body: "not json",
      });
      expect(res.status).toBe(400);
    } finally {
      await store.close();
    }
  });

  test("returns 422 for a schema version newer than the hub supports", async () => {
    const { store, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const res = await postSync(app, {
        Authorization: `Bearer ${apiKey}`,
        "X-Argus-Client": newClientId(),
      }, buildPayload([{ sessionId: "s" }], HUB_MAX_CLIENT_SCHEMA_VERSION + 1));
      expect(res.status).toBe(422);
    } finally {
      await store.close();
    }
  });

  test("returns 200 with sessionsUpserted, usersKnown, and userId on success", async () => {
    const { store, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const res = await postSync(app, {
        Authorization: `Bearer ${apiKey}`,
        "X-Argus-Client": newClientId(),
      }, buildPayload([{ sessionId: "sess-a" }, { sessionId: "sess-b" }], HUB_MAX_CLIENT_SCHEMA_VERSION, { email: "alice@example.com" }));
      expect(res.status).toBe(200);
      const body = await res.json() as { sessionsUpserted: number; usersKnown: number; userId: string };
      expect(body.sessionsUpserted).toBe(2);
      expect(body.usersKnown).toBe(1);
      expect(body.userId.startsWith("user-")).toBe(true);
    } finally {
      await store.close();
    }
  });

  test("hub.db contains the uploaded sessions and usage rows", async () => {
    const { store, orgId, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const res = await postSync(app, {
        Authorization: `Bearer ${apiKey}`,
        "X-Argus-Client": newClientId(),
      }, buildPayload([{ sessionId: "sess-x" }], HUB_MAX_CLIENT_SCHEMA_VERSION, { email: "bob@example.com" }));
      const body = await res.json() as { userId: string };

      const result = await store.readResolved({ orgId, userId: body.userId });
      expect(result.sessions.has("sess-x")).toBe(true);
      expect(result.messages).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  test("re-uploading the same payload from the same client is idempotent", async () => {
    const { store, orgId, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const clientId = newClientId();
      const headers = {
        Authorization: `Bearer ${apiKey}`,
        "X-Argus-Client": clientId,
      };
      const payload = buildPayload([{ sessionId: "sess-idem" }], HUB_MAX_CLIENT_SCHEMA_VERSION, { email: "carol@example.com" });
      const r1 = await postSync(app, headers, payload);
      await postSync(app, headers, payload);
      const { userId } = await r1.json() as { userId: string };

      const result = await store.readResolved({ orgId, userId });
      expect(result.sessions.size).toBe(1);
      expect(result.messages).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  test("two clients with the same fingerprint email collapse to one user", async () => {
    const { store, orgId, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const payload1 = buildPayload([{ sessionId: "s1" }], HUB_MAX_CLIENT_SCHEMA_VERSION, { email: "dave@example.com" });
      const payload2 = buildPayload([{ sessionId: "s2" }], HUB_MAX_CLIENT_SCHEMA_VERSION, { email: "dave@example.com" });
      const r1 = await postSync(app, { Authorization: `Bearer ${apiKey}`, "X-Argus-Client": newClientId() }, payload1);
      const r2 = await postSync(app, { Authorization: `Bearer ${apiKey}`, "X-Argus-Client": newClientId() }, payload2);
      const b1 = await r1.json() as { userId: string };
      const b2 = await r2.json() as { userId: string };
      expect(b1.userId).toBe(b2.userId);
      expect(await store.countUsers(orgId)).toBe(1);
    } finally {
      await store.close();
    }
  });

  test("usersKnown increments as different-fingerprint clients sync", async () => {
    const { store, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const r1 = await postSync(app, {
        Authorization: `Bearer ${apiKey}`,
        "X-Argus-Client": newClientId(),
      }, buildPayload([{ sessionId: "s1" }], HUB_MAX_CLIENT_SCHEMA_VERSION, { email: "alice@example.com" }));
      const b1 = await r1.json() as { usersKnown: number };
      expect(b1.usersKnown).toBe(1);

      const r2 = await postSync(app, {
        Authorization: `Bearer ${apiKey}`,
        "X-Argus-Client": newClientId(),
      }, buildPayload([{ sessionId: "s2" }], HUB_MAX_CLIENT_SCHEMA_VERSION, { email: "bob@example.com" }));
      const b2 = await r2.json() as { usersKnown: number };
      expect(b2.usersKnown).toBe(2);
    } finally {
      await store.close();
    }
  });
});

// ---- POST /api/sync/unknown-sessions ---------------------------------------------------

async function postUnknown(
  app: ReturnType<typeof createHubApp>,
  headers: Record<string, string>,
  payload: unknown,
): Promise<Response> {
  return await app.request("/api/sync/unknown-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/sync/unknown-sessions", () => {
  test("returns 401 with no Authorization header", async () => {
    const { store } = await openTestStore();
    const app = createHubApp(store);
    try {
      const res = await postUnknown(app, { "X-Argus-Client": newClientId() }, { sessionIds: ["a"] });
      expect(res.status).toBe(401);
    } finally {
      await store.close();
    }
  });

  test("returns 401 for an invalid API key", async () => {
    const { store } = await openTestStore();
    const app = createHubApp(store);
    try {
      const res = await postUnknown(app, {
        Authorization: "Bearer hub-invalid-key",
        "X-Argus-Client": newClientId(),
      }, { sessionIds: ["a"] });
      expect(res.status).toBe(401);
    } finally {
      await store.close();
    }
  });

  test("returns 400 with no X-Argus-Client header", async () => {
    const { store, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const res = await postUnknown(app, {
        Authorization: `Bearer ${apiKey}`,
      }, { sessionIds: ["a"] });
      expect(res.status).toBe(400);
    } finally {
      await store.close();
    }
  });

  test("returns 400 when sessionIds is missing", async () => {
    const { store, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const res = await postUnknown(app, {
        Authorization: `Bearer ${apiKey}`,
        "X-Argus-Client": newClientId(),
      }, {});
      expect(res.status).toBe(400);
    } finally {
      await store.close();
    }
  });

  test("returns 400 when sessionIds contains a non-string", async () => {
    const { store, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const res = await postUnknown(app, {
        Authorization: `Bearer ${apiKey}`,
        "X-Argus-Client": newClientId(),
      }, { sessionIds: ["ok", 42] });
      expect(res.status).toBe(400);
    } finally {
      await store.close();
    }
  });

  test("returns 400 when sessionIds exceeds the per-request cap", async () => {
    const { store, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const ids = Array.from({ length: MAX_SESSION_IDS_PER_REQUEST + 1 }, (_, i) => `s${i}`);
      const res = await postUnknown(app, {
        Authorization: `Bearer ${apiKey}`,
        "X-Argus-Client": newClientId(),
      }, { sessionIds: ids });
      expect(res.status).toBe(400);
    } finally {
      await store.close();
    }
  });

  test("returns all candidates as unknown when the client has never synced", async () => {
    const { store, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const res = await postUnknown(app, {
        Authorization: `Bearer ${apiKey}`,
        "X-Argus-Client": newClientId(),
      }, { sessionIds: ["a", "b", "c"] });
      expect(res.status).toBe(200);
      const body = await res.json() as { unknownSessionIds: string[] };
      expect(body.unknownSessionIds).toEqual(["a", "b", "c"]);
    } finally {
      await store.close();
    }
  });

  test("returns only the IDs the hub does not already have for this client", async () => {
    const { store, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const clientId = newClientId();
      const headers = {
        Authorization: `Bearer ${apiKey}`,
        "X-Argus-Client": clientId,
      };
      await postSync(app, headers, buildPayload([{ sessionId: "have-1" }, { sessionId: "have-2" }]));

      const res = await postUnknown(app, headers, {
        sessionIds: ["have-1", "new-1", "have-2", "new-2"],
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { unknownSessionIds: string[] };
      expect(body.unknownSessionIds).toEqual(["new-1", "new-2"]);
    } finally {
      await store.close();
    }
  });

  test("scopes by client — another client's stored sessions don't count as known", async () => {
    const { store, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      await postSync(app, {
        Authorization: `Bearer ${apiKey}`,
        "X-Argus-Client": newClientId(),
      }, buildPayload([{ sessionId: "shared-id" }]));

      const res = await postUnknown(app, {
        Authorization: `Bearer ${apiKey}`,
        "X-Argus-Client": newClientId(),
      }, { sessionIds: ["shared-id"] });
      const body = await res.json() as { unknownSessionIds: string[] };
      expect(body.unknownSessionIds).toEqual(["shared-id"]);
    } finally {
      await store.close();
    }
  });

  test("dedupes input IDs in the response", async () => {
    const { store, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const res = await postUnknown(app, {
        Authorization: `Bearer ${apiKey}`,
        "X-Argus-Client": newClientId(),
      }, { sessionIds: ["x", "x", "y", "x"] });
      const body = await res.json() as { unknownSessionIds: string[] };
      expect(body.unknownSessionIds).toEqual(["x", "y"]);
    } finally {
      await store.close();
    }
  });

  test("empty sessionIds returns empty unknownSessionIds", async () => {
    const { store, apiKey } = await openTestStore();
    const app = createHubApp(store);
    try {
      const res = await postUnknown(app, {
        Authorization: `Bearer ${apiKey}`,
        "X-Argus-Client": newClientId(),
      }, { sessionIds: [] });
      expect(res.status).toBe(200);
      const body = await res.json() as { unknownSessionIds: string[] };
      expect(body.unknownSessionIds).toEqual([]);
    } finally {
      await store.close();
    }
  });
});
