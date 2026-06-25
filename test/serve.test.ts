import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import sqlite3, { type Database } from "sqlite3";
import { openHubStore, type HubStore, type HubUploadPayload } from "../src/store/hub-store.ts";
import { createHubApp } from "../src/api/serve.ts";
import { HUB_MAX_CLIENT_SCHEMA_VERSION } from "../src/api/sync.ts";
import { createAdminAuth } from "../src/admin-auth.ts";

// ---- Temp dir management ---------------------------------------------------------------

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "hub-serve-test-"));
  tempDirs.push(d);
  return d;
}

// ---- DB helpers ------------------------------------------------------------------------

function openDb(path: string, mode = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE): Promise<Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, mode, (err) => (err ? reject(err) : resolve(db)));
  });
}
function execDb(db: Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}
function runDb(db: Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}
function closeDb(db: Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

function buildUploadPayload(sessions: Array<{ id: string; source?: string; project?: string }>): HubUploadPayload {
  return {
    schemaVersion: HUB_MAX_CLIENT_SCHEMA_VERSION,
    rows: {
      sessions: sessions.map(({ id, source = "claude", project = "/Users/you/proj" }) => ({
        session_id: id,
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
        meta_json: JSON.stringify({ sessionId: id, source, project, cwd: project, filePath: "" }),
      })),
      usage: sessions.map(({ id, source = "claude", project = "/Users/you/proj" }) => ({
        session_id: id,
        seq: 0,
        source,
        ts: 1_000_000,
        date: "2026-01-01",
        cwd: project,
        project,
        record_json: JSON.stringify({
          sessionId: id, model: "claude-sonnet-4-6", ts: 1_000_000, date: "2026-01-01",
          source, project, cwd: project, gitBranch: "",
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
          attributionSkill: null, toolUses: [],
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
}

// ---- Test store + seeding helper -------------------------------------------------------

interface TestEnv {
  store: HubStore;
  orgId: string;
  apiKey: string;
  /** Stable client_id per email within one test env. Two syncs from "alice@example.com"
   *  share the same client_id (and so map to the same user). */
  clientFor(email: string): string;
}

async function openTestEnv(): Promise<TestEnv> {
  const dir = tempDir();
  let printed = "";
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { printed += s; return true; };
  const store = await openHubStore(dir, 1_000_000);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = orig;
  const apiKey = (/Hub API key \(Default\): (hub-\S+)/.exec(printed))?.[1] ?? "";
  const orgId = (await store.getDefaultOrgId())!;
  const clientIds = new Map<string, string>();
  const clientFor = (email: string): string => {
    let id = clientIds.get(email);
    if (!id) { id = `client-${randomUUID()}`; clientIds.set(email, id); }
    return id;
  };
  return { store, orgId, apiKey, clientFor };
}

/** Sync a fixture payload from an Argus client whose claude.oauth.email fingerprint is
 *  `email`. Returns the resolved user_id so callers can use it in URL filters. */
async function syncAs(env: TestEnv, email: string, sessions: Array<{ id: string }>): Promise<string> {
  const app = createHubApp(env.store);
  const clientId = env.clientFor(email);
  const payload = {
    ...buildUploadPayload(sessions),
    fingerprint: [{ key: "claude.oauth.email", value: email, tsMs: 1_000_000 }],
  };
  const res = await app.request("/api/sync", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.apiKey}`,
      "X-Argus-Client": clientId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (res.status !== 200) throw new Error(`sync failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { userId: string };
  return body.userId;
}

// ---- Auth ------------------------------------------------------------------------------

describe("POST /login", () => {
  test("sets Secure on the session cookie for non-loopback hosts", async () => {
    const app = createHubApp({} as HubStore, createAdminAuth("secret"));

    const res = await app.request("https://hub.example.com/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=secret",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("; Secure");
  });

  test("omits Secure on the session cookie for loopback dev hosts", async () => {
    const app = createHubApp({} as HubStore, createAdminAuth("secret"));

    const res = await app.request("http://localhost:4242/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=secret",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).not.toContain("; Secure");
  });
});

// ---- GET /api/users --------------------------------------------------------------------

describe("GET /api/users", () => {
  test("returns empty list when no data has been synced", async () => {
    const { store } = await openTestEnv();
    const app = createHubApp(store);
    try {
      const res = await app.request("/api/users");
      expect(res.status).toBe(200);
      const body = await res.json() as { users: unknown[] };
      expect(body.users).toEqual([]);
    } finally {
      await store.close();
    }
  });

  test("returns users sorted by last-sync desc", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      const aliceId = await syncAs(env, "alice@example.com", [{ id: "s1" }]);
      const bobId = await syncAs(env, "bob@example.com", [{ id: "s2" }]);

      const res = await app.request("/api/users");
      expect(res.status).toBe(200);
      const body = await res.json() as { users: Array<{ userId: string; displayName: string; email: string | null; sessionCount: number }> };
      expect(body.users).toHaveLength(2);
      // Bob synced last, so he's first.
      expect(body.users[0]!.userId).toBe(bobId);
      expect(body.users[0]!.email).toBe("bob@example.com");
      expect(body.users[0]!.sessionCount).toBe(1);
      expect(body.users[1]!.userId).toBe(aliceId);
      expect(body.users[1]!.email).toBe("alice@example.com");
    } finally {
      await env.store.close();
    }
  });
});

// ---- GET /api/snapshot -----------------------------------------------------------------

describe("GET /api/snapshot", () => {
  test("returns 503 when no data exists yet", async () => {
    const { store } = await openTestEnv();
    const app = createHubApp(store);
    try {
      const res = await app.request("/api/snapshot");
      expect(res.status).toBe(503);
    } finally {
      await store.close();
    }
  });

  test("returns a valid snapshot after data is synced", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      await syncAs(env, "alice@example.com", [{ id: "s1" }, { id: "s2" }]);

      const res = await app.request("/api/snapshot");
      expect(res.status).toBe(200);
      const body = await res.json() as { dashboard: { totals: { sessions: number } }; generatedAtMs: number };
      expect(body.dashboard.totals.sessions).toBe(2);
      expect(typeof body.generatedAtMs).toBe("number");
    } finally {
      await env.store.close();
    }
  });

  test("?user= scopes the snapshot to one user", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      const aliceId = await syncAs(env, "alice@example.com", [{ id: "sa1" }, { id: "sa2" }]);
      const bobId = await syncAs(env, "bob@example.com", [{ id: "sb1" }]);

      const orgWide = await app.request("/api/snapshot");
      const allBody = await orgWide.json() as { dashboard: { totals: { sessions: number } } };
      expect(allBody.dashboard.totals.sessions).toBe(3);

      const aliceRes = await app.request(`/api/snapshot?user=${encodeURIComponent(aliceId)}`);
      const aliceBody = await aliceRes.json() as { dashboard: { totals: { sessions: number } } };
      expect(aliceBody.dashboard.totals.sessions).toBe(2);

      const bobRes = await app.request(`/api/snapshot?user=${encodeURIComponent(bobId)}`);
      const bobBody = await bobRes.json() as { dashboard: { totals: { sessions: number } } };
      expect(bobBody.dashboard.totals.sessions).toBe(1);
    } finally {
      await env.store.close();
    }
  });

  test("returns 400 for an unknown source", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      await syncAs(env, "alice@example.com", [{ id: "s" }]);
      const res = await app.request("/api/snapshot?source=unknown");
      expect(res.status).toBe(400);
    } finally {
      await env.store.close();
    }
  });
});

// ---- GET /api/sessions -----------------------------------------------------------------

describe("GET /api/sessions", () => {
  test("returns sessions after a sync", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      await syncAs(env, "alice@example.com", [{ id: "sa1" }, { id: "sa2" }]);

      const res = await app.request("/api/sessions");
      expect(res.status).toBe(200);
      const body = await res.json() as { rows: unknown[]; total: number };
      expect(body.total).toBe(2);
      expect(body.rows).toHaveLength(2);
    } finally {
      await env.store.close();
    }
  });

  test("?user= scopes the session list", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      const aliceId = await syncAs(env, "alice@example.com", [{ id: "sa" }]);
      const bobId = await syncAs(env, "bob@example.com", [{ id: "sb1" }, { id: "sb2" }]);

      const aliceRes = await app.request(`/api/sessions?user=${encodeURIComponent(aliceId)}`);
      const aliceBody = await aliceRes.json() as { total: number };
      expect(aliceBody.total).toBe(1);

      const bobRes = await app.request(`/api/sessions?user=${encodeURIComponent(bobId)}`);
      const bobBody = await bobRes.json() as { total: number };
      expect(bobBody.total).toBe(2);
    } finally {
      await env.store.close();
    }
  });

  test("respects ?limit= and ?offset=", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      await syncAs(env, "alice@example.com", [{ id: "s1" }, { id: "s2" }, { id: "s3" }]);

      const res = await app.request("/api/sessions?limit=2&offset=0");
      const body = await res.json() as { rows: unknown[]; total: number; limit: number; offset: number };
      expect(body.total).toBe(3);
      expect(body.rows).toHaveLength(2);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);
    } finally {
      await env.store.close();
    }
  });

  test("returns 400 for an unknown sort", async () => {
    const { store } = await openTestEnv();
    const app = createHubApp(store);
    try {
      const res = await app.request("/api/sessions?sort=invalid");
      expect(res.status).toBe(400);
    } finally {
      await store.close();
    }
  });
});

// ---- GET /api/session/:id --------------------------------------------------------------

describe("GET /api/session/:id", () => {
  test("returns 400 when ?user= is missing", async () => {
    const { store } = await openTestEnv();
    const app = createHubApp(store);
    try {
      const res = await app.request("/api/session/some-id");
      expect(res.status).toBe(400);
    } finally {
      await store.close();
    }
  });

  test("returns 404 for an unknown session", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      const aliceId = await syncAs(env, "alice@example.com", [{ id: "real-sess" }]);
      const res = await app.request(`/api/session/does-not-exist?user=${encodeURIComponent(aliceId)}`);
      expect(res.status).toBe(404);
    } finally {
      await env.store.close();
    }
  });

  test("returns 404 when the user doesn't own the session", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      await syncAs(env, "alice@example.com", [{ id: "alice-sess" }]);
      // Bob has a separate client, even if he never uploaded the "alice-sess" session.
      const bobId = await syncAs(env, "bob@example.com", [{ id: "bob-sess" }]);
      const res = await app.request(`/api/session/alice-sess?user=${encodeURIComponent(bobId)}`);
      expect(res.status).toBe(404);
    } finally {
      await env.store.close();
    }
  });

  test("returns the full session row for a valid request", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      const aliceId = await syncAs(env, "alice@example.com", [{ id: "detail-sess" }]);
      const res = await app.request(`/api/session/detail-sess?user=${encodeURIComponent(aliceId)}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { session: { sessionId: string; source: string } };
      expect(body.session.sessionId).toBe("detail-sess");
      expect(body.session.source).toBe("claude");
    } finally {
      await env.store.close();
    }
  });
});
