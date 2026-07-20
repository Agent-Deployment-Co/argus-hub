import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  DuplicateGroupNameError,
  HUB_APPLICATION_ID,
  HUB_SCHEMA_VERSION,
  openHubStore,
  type HubStore,
  type HubUploadRows,
} from "../src/store/hub-store.ts";
import sqlite3 from "sqlite3";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hub-store-test-"));
  tempDirs.push(dir);
  return dir;
}

function newClientId(): string {
  return `client-${randomUUID()}`;
}

function openRaw(path: string) {
  return new Promise<sqlite3.Database>((resolve, reject) => {
    const db = new sqlite3.Database(path, (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function rawGet<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get<T>(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function rawAll<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all<T>(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function rawExec(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function closeRaw(db: sqlite3.Database) {
  return new Promise<void>((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

async function openStoreCapturingApiKey(dataDir: string): Promise<{ store: HubStore; apiKey: string; printed: string }> {
  let printed = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    printed += s;
    return true;
  };
  try {
    const store = await openHubStore(dataDir, 1_000_000);
    const apiKey = (/Hub API key \(Default\): (hub-\S+)/.exec(printed))?.[1] ?? "";
    return { store, apiKey, printed };
  } finally {
    (process.stdout as unknown as { write: (s: string) => boolean }).write = origWrite;
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Register a client, attach an email fingerprint, resolve its user, and upsert sessions.
 *  Mirrors what POST /api/sync does end-to-end. Returns the resolved user_id. */
async function syncAs(
  store: HubStore,
  orgId: string,
  clientId: string,
  email: string | null,
  rows: HubUploadRows,
  now: number,
): Promise<string> {
  await store.upsertClient(orgId, clientId, now);
  if (email) {
    await store.recordFingerprintObservations(clientId, [
      { key: "claude.oauth.email", value: email, tsMs: now },
    ]);
  }
  const userId = await store.resolveUserForClient(orgId, clientId, now);
  await store.upsertClientSessions(orgId, clientId, rows, now);
  return userId;
}

function minimalUploadRows(sessionId = "sess-1"): HubUploadRows {
  return {
    sessions: [
      {
        session_id: sessionId,
        source: "claude",
        project: "/Users/you/myproject",
        cwd: "/Users/you/myproject",
        first_ts: 1_000_000,
        last_ts: 2_000_000,
        message_count: 1,
        first_prompt: "hello",
        archived: 0,
        friction_interruptions: null,
        friction_rejections: null,
        friction_compactions: null,
        friction_turns: null,
        last_interruption_ms: null,
        title: null,
        summary: null,
        meta_json: JSON.stringify({
          sessionId,
          source: "claude",
          project: "/Users/you/myproject",
          cwd: "/Users/you/myproject",
          firstPrompt: "hello",
        }),
      },
    ],
    usage: [
      {
        session_id: sessionId,
        seq: 0,
        source: "claude",
        ts: 1_000_000,
        date: "2026-01-01",
        cwd: "/Users/you/myproject",
        project: "/Users/you/myproject",
        record_json: JSON.stringify({
          sessionId,
          model: "claude-sonnet-4-6",
          ts: 1_000_000,
          date: "2026-01-01",
          source: "claude",
          project: "/Users/you/myproject",
          cwd: "/Users/you/myproject",
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
        stop_reason: "end_turn",
        interaction_seq: null,
      },
    ],
    tasks: [],
    interactions: [],
    invocations: [],
    labels: [],
  };
}

function addInvocation(rows: HubUploadRows, sessionId: string): void {
  rows.invocations.push({
    session_id: sessionId,
    seq: 0,
    source: "claude",
    interaction_seq: null,
    tool: "Read",
    category: "file-io",
    mcp_server: null,
    mcp_tool: null,
    skill: null,
    file_path: "/Users/you/myproject/file.ts",
    date: "2026-01-01",
    cwd: "/Users/you/myproject",
    args: "{}",
    approx_result_tokens: 25,
  });
}

// ---- Schema creation -------------------------------------------------------------------

describe("schema", () => {
  test("creates hub.db with correct application_id and user_version", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    await store.close();

    const db = await openRaw(join(dataDir, "hub.db"));
    try {
      const appId = await rawGet<{ application_id: number }>(db, "PRAGMA application_id");
      const ver = await rawGet<{ user_version: number }>(db, "PRAGMA user_version");
      expect(appId?.application_id).toBe(HUB_APPLICATION_ID);
      expect(ver?.user_version).toBe(HUB_SCHEMA_VERSION);
    } finally {
      await closeRaw(db);
    }
  });

  test("creates all expected tables", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    await store.close();

    const db = await openRaw(join(dataDir, "hub.db"));
    try {
      const tables = await rawAll<{ name: string }>(
        db,
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      const names = tables.map((t) => t.name);
      expect(names).toContain("organizations");
      expect(names).toContain("api_keys");
      expect(names).toContain("groups");
      expect(names).toContain("users");
      expect(names).toContain("clients");
      expect(names).toContain("client_fingerprint");
      expect(names).toContain("client_syncs");
      expect(names).toContain("resolved_sessions");
      expect(names).toContain("resolved_usage");
      expect(names).toContain("resolved_tasks");
      expect(names).toContain("resolved_interactions");
      expect(names).toContain("resolved_invocations");
    } finally {
      await closeRaw(db);
    }
  });

  test("stores only hashed API key identifiers", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    await store.close();

    const db = await openRaw(join(dataDir, "hub.db"));
    try {
      const columns = await rawAll<{ name: string }>(db, "PRAGMA table_info(api_keys)");
      const names = columns.map((c) => c.name);
      expect(names).toContain("key_hash");
      expect(names).not.toContain("key");
    } finally {
      await closeRaw(db);
    }
  });

  test("idempotent: opening an existing store does not re-create tables", async () => {
    const dataDir = tempDataDir();
    const store1 = await openHubStore(dataDir, 1_000_000);
    await store1.close();
    const store2 = await openHubStore(dataDir, 2_000_000);
    await store2.close();
  });

  test("upgrades a v1 store to the current version in place, preserving data", async () => {
    const dataDir = tempDataDir();
    const dbPath = join(dataDir, "hub.db");

    // Build a real current-version store with a synced session, then downgrade the file to
    // look like v1 (drop every additive migration's changes + reset user_version) so reopening
    // exercises the full migration chain.
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;
    const clientId = newClientId();
    await syncAs(store, orgId, clientId, "alice@example.com", minimalUploadRows("sess-mig"), 1_000_000);
    await store.close();

    const raw = await openRaw(dbPath);
    await rawExec(raw,
      `DROP TABLE resolved_session_labels;
       ALTER TABLE resolved_sessions DROP COLUMN title;
       ALTER TABLE resolved_sessions DROP COLUMN summary;
       DROP INDEX users_group;
       ALTER TABLE users DROP COLUMN group_id;
       DROP TABLE groups;
       PRAGMA user_version = 1;`);
    await closeRaw(raw);

    // Reopen — should migrate in place, not throw.
    const upgraded = await openHubStore(dataDir, 2_000_000);
    await upgraded.close();

    const db = await openRaw(dbPath);
    try {
      const ver = await rawGet<{ user_version: number }>(db, "PRAGMA user_version");
      expect(ver?.user_version).toBe(HUB_SCHEMA_VERSION);

      const cols = (await rawAll<{ name: string }>(db, "PRAGMA table_info(resolved_sessions)")).map((c) => c.name);
      expect(cols).toContain("title");
      expect(cols).toContain("summary");

      const labelTable = await rawGet<{ name: string }>(
        db, "SELECT name FROM sqlite_schema WHERE type='table' AND name='resolved_session_labels'");
      expect(labelTable?.name).toBe("resolved_session_labels");

      const groupsTable = await rawGet<{ name: string }>(
        db, "SELECT name FROM sqlite_schema WHERE type='table' AND name='groups'");
      expect(groupsTable?.name).toBe("groups");

      const userCols = (await rawAll<{ name: string }>(db, "PRAGMA table_info(users)")).map((c) => c.name);
      expect(userCols).toContain("group_id");

      // Pre-existing session data survived the upgrade.
      const sess = await rawGet<{ session_id: string; title: string | null }>(
        db, "SELECT session_id, title FROM resolved_sessions WHERE session_id = ?", ["sess-mig"]);
      expect(sess?.session_id).toBe("sess-mig");
      expect(sess?.title).toBeNull();
    } finally {
      await closeRaw(db);
    }
  });

  test("refuses to open a store newer than the build (no downgrade)", async () => {
    const dataDir = tempDataDir();
    const dbPath = join(dataDir, "hub.db");
    const store = await openHubStore(dataDir, 1_000_000);
    await store.close();

    const raw = await openRaw(dbPath);
    await rawExec(raw, `PRAGMA user_version = ${HUB_SCHEMA_VERSION + 1};`);
    await closeRaw(raw);

    await expect(openHubStore(dataDir, 2_000_000)).rejects.toThrow(/newer than this build/);
  });
});

// ---- Bootstrap -------------------------------------------------------------------------

describe("bootstrap", () => {
  test("creates a Default org on first open", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    await store.close();

    const db = await openRaw(join(dataDir, "hub.db"));
    try {
      const org = await rawGet<{ org_id: string; name: string }>(db, "SELECT org_id, name FROM organizations LIMIT 1");
      expect(org?.name).toBe("Default");
      expect(org?.org_id).toMatch(/^org-/);
    } finally {
      await closeRaw(db);
    }
  });

  test("prints and stores an API key on first open", async () => {
    const dataDir = tempDataDir();
    const { store, apiKey, printed } = await openStoreCapturingApiKey(dataDir);
    await store.close();

    expect(printed).toMatch(/^Hub API key \(Default\): hub-/);
    expect(apiKey).toMatch(/^hub-/);

    const db = await openRaw(join(dataDir, "hub.db"));
    try {
      const key = await rawGet<{ key_hash: string; is_enabled: number }>(
        db,
        "SELECT key_hash, is_enabled FROM api_keys LIMIT 1",
      );
      expect(key?.key_hash).toBe(sha256Hex(apiKey));
      expect(key?.key_hash).not.toBe(apiKey);
      expect(key?.is_enabled).toBe(1);
    } finally {
      await closeRaw(db);
    }
  });

  test("does not print a second key on subsequent opens", async () => {
    const dataDir = tempDataDir();
    const store1 = await openHubStore(dataDir, 1_000_000);
    await store1.close();

    let printed = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      printed += s;
      return true;
    };
    try {
      const store2 = await openHubStore(dataDir, 2_000_000);
      await store2.close();
    } finally {
      (process.stdout as unknown as { write: (s: string) => boolean }).write = origWrite;
    }
    expect(printed).toBe("");
  });
});

// ---- lookupApiKey ----------------------------------------------------------------------

describe("lookupApiKey", () => {
  test("returns orgId and isEnabled for a valid key", async () => {
    const dataDir = tempDataDir();
    const { store, apiKey } = await openStoreCapturingApiKey(dataDir);

    const db = await openRaw(join(dataDir, "hub.db"));
    const keyRow = await rawGet<{ key_hash: string; org_id: string }>(
      db,
      "SELECT key_hash, org_id FROM api_keys LIMIT 1",
    );
    await closeRaw(db);

    expect(keyRow).toBeDefined();
    expect(keyRow!.key_hash).toBe(sha256Hex(apiKey));
    const result = await store.lookupApiKey(apiKey);
    await store.close();

    expect(result).toBeDefined();
    expect(result?.orgId).toBe(keyRow!.org_id);
    expect(result?.isEnabled).toBe(true);
  });

  test("returns undefined for an unknown key", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const result = await store.lookupApiKey("hub-does-not-exist");
    await store.close();
    expect(result).toBeUndefined();
  });

  test("returns isEnabled=false for a disabled key", async () => {
    const dataDir = tempDataDir();
    const { store, apiKey } = await openStoreCapturingApiKey(dataDir);

    const db = await openRaw(join(dataDir, "hub.db"));
    await new Promise<void>((resolve, reject) =>
      db.run("UPDATE api_keys SET is_enabled = 0", (err) => (err ? reject(err) : resolve())),
    );
    await closeRaw(db);

    const result = await store.lookupApiKey(apiKey);
    await store.close();

    expect(result?.isEnabled).toBe(false);
  });
});

// ---- upsertClient + resolveUserForClient -----------------------------------------------

describe("client + user resolution", () => {
  test("rejects malformed client ids", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;
    await expect(store.upsertClient(orgId, "not-a-client-id")).rejects.toThrow();
    await store.close();
  });

  test("clients with same email fingerprint collapse onto one user", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    const c1 = newClientId();
    const c2 = newClientId();
    const u1 = await syncAs(store, orgId, c1, "alice@example.com", minimalUploadRows("s1"), 1_000_000);
    const u2 = await syncAs(store, orgId, c2, "alice@example.com", minimalUploadRows("s2"), 2_000_000);
    expect(u1).toBe(u2);
    expect(await store.countUsers(orgId)).toBe(1);
    await store.close();
  });

  test("clients with no fingerprint each get their own user (display = client_id)", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;
    const u1 = await syncAs(store, orgId, newClientId(), null, minimalUploadRows("s1"), 1_000_000);
    const u2 = await syncAs(store, orgId, newClientId(), null, minimalUploadRows("s2"), 2_000_000);
    expect(u1).not.toBe(u2);
    expect(await store.countUsers(orgId)).toBe(2);
    await store.close();
  });

  test("pinning prevents the auto-mapper from reassigning the client", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    const clientId = newClientId();
    const userId = await syncAs(store, orgId, clientId, "alice@example.com", minimalUploadRows("s1"), 1_000_000);
    await store.pinClientToUser(clientId, userId, true);

    // Now this client's fingerprint switches to bob@example.com — but pinning holds.
    await store.recordFingerprintObservations(clientId, [
      { key: "claude.oauth.email", value: "bob@example.com", tsMs: 2_000_000 },
    ]);
    const reresolved = await store.resolveUserForClient(orgId, clientId, 2_000_000);
    expect(reresolved).toBe(userId);
    await store.close();
  });
});

// ---- upsertClientSessions --------------------------------------------------------------

describe("upsertClientSessions", () => {
  test("inserts sessions and usage rows tagged with org_id and client_id", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    const clientId = newClientId();
    const userId = await syncAs(store, orgId, clientId, "alice@example.com", minimalUploadRows("sess-abc"), 1_000_000);

    expect(userId.startsWith("user-")).toBe(true);

    const db = await openRaw(join(dataDir, "hub.db"));
    try {
      const sess = await rawGet<{ org_id: string; client_id: string; session_id: string }>(
        db,
        "SELECT org_id, client_id, session_id FROM resolved_sessions WHERE session_id = ?",
        ["sess-abc"],
      );
      expect(sess?.org_id).toBe(orgId);
      expect(sess?.client_id).toBe(clientId);
      expect(sess?.session_id).toBe("sess-abc");

      const usage = await rawGet<{ session_id: string }>(
        db,
        "SELECT session_id FROM resolved_usage WHERE session_id = ? AND org_id = ?",
        ["sess-abc", orgId],
      );
      expect(usage).toBeDefined();
    } finally {
      await closeRaw(db);
    }
    await store.close();
  });

  test("re-upload from the same client replaces existing rows", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;
    const clientId = newClientId();

    await syncAs(store, orgId, clientId, "bob@example.com", minimalUploadRows("sess-dup"), 1_000_000);
    const { sessionsUpserted } = await store.upsertClientSessions(
      orgId, clientId, minimalUploadRows("sess-dup"), 2_000_000,
    );
    expect(sessionsUpserted).toBe(1);

    const db = await openRaw(join(dataDir, "hub.db"));
    try {
      const count = await rawGet<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM resolved_sessions WHERE session_id = ?",
        ["sess-dup"],
      );
      expect(count?.n).toBe(1);
    } finally {
      await closeRaw(db);
    }
    await store.close();
  });

  test("two different clients can upload sessions with the same session_id", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    await syncAs(store, orgId, newClientId(), "alice@example.com", minimalUploadRows("shared-sess-id"), 1_000_000);
    await syncAs(store, orgId, newClientId(), "bob@example.com", minimalUploadRows("shared-sess-id"), 2_000_000);

    const db = await openRaw(join(dataDir, "hub.db"));
    try {
      const count = await rawGet<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM resolved_sessions WHERE session_id = ?",
        ["shared-sess-id"],
      );
      expect(count?.n).toBe(2);
    } finally {
      await closeRaw(db);
    }
    await store.close();
  });

  test("persists session title/summary and denormalized applied labels", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;
    const clientId = newClientId();

    const rows = minimalUploadRows("sess-lab");
    rows.sessions[0]!.title = "A concise title";
    rows.sessions[0]!.summary = "A few sentences of summary.";
    rows.labels = [
      { session_id: "sess-lab", source: "claude", name: "bug", origin: "user", applied_by: "user", target_kind: "session", task_seq: null, applied_at_ms: 10 },
      { session_id: "sess-lab", source: "claude", name: "auto", origin: "system", applied_by: "system", target_kind: "task", task_seq: 0, applied_at_ms: 11 },
    ];
    await syncAs(store, orgId, clientId, "alice@example.com", rows, 1_000_000);

    const db = await openRaw(join(dataDir, "hub.db"));
    try {
      const sess = await rawGet<{ title: string | null; summary: string | null }>(
        db, "SELECT title, summary FROM resolved_sessions WHERE session_id = ?", ["sess-lab"],
      );
      expect(sess?.title).toBe("A concise title");
      expect(sess?.summary).toBe("A few sentences of summary.");

      const labelCount = await rawGet<{ n: number }>(
        db, "SELECT COUNT(*) AS n FROM resolved_session_labels WHERE org_id = ? AND session_id = ?", [orgId, "sess-lab"],
      );
      expect(labelCount?.n).toBe(2);

      // Re-sync with the session-level label removed → the session replace drops it via CASCADE.
      rows.labels = rows.labels!.filter((l) => l.target_kind === "task");
      await store.upsertClientSessions(orgId, clientId, rows, 2_000_000);
      const after = await rawGet<{ n: number }>(
        db, "SELECT COUNT(*) AS n FROM resolved_session_labels WHERE org_id = ? AND session_id = ?", [orgId, "sess-lab"],
      );
      expect(after?.n).toBe(1);
    } finally {
      await closeRaw(db);
    }
    await store.close();
  });

  test("accepts an old-client payload with no labels field (defaults to none)", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;
    const clientId = newClientId();

    // Simulate an older client whose upload omits `labels` entirely.
    const rows = minimalUploadRows("sess-old");
    delete (rows as { labels?: unknown }).labels;
    await syncAs(store, orgId, clientId, "bob@example.com", rows, 1_000_000);

    const db = await openRaw(join(dataDir, "hub.db"));
    try {
      const count = await rawGet<{ n: number }>(
        db, "SELECT COUNT(*) AS n FROM resolved_session_labels WHERE session_id = ?", ["sess-old"],
      );
      expect(count?.n).toBe(0);
    } finally {
      await closeRaw(db);
    }
    await store.close();
  });

  test("updates client_syncs last_sync_ms on upsert", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;
    const clientId = newClientId();

    await syncAs(store, orgId, clientId, "carol@example.com", minimalUploadRows(), 5_000_000);
    await syncAs(store, orgId, clientId, "carol@example.com", minimalUploadRows(), 9_000_000);

    const db = await openRaw(join(dataDir, "hub.db"));
    try {
      const row = await rawGet<{ last_sync_ms: number }>(
        db,
        "SELECT last_sync_ms FROM client_syncs WHERE org_id = ? AND client_id = ?",
        [orgId, clientId],
      );
      expect(row?.last_sync_ms).toBe(9_000_000);
    } finally {
      await closeRaw(db);
    }
    await store.close();
  });
});

// ---- listUsers / countUsers ------------------------------------------------------------

describe("listUsers / countUsers", () => {
  test("listUsers returns users sorted by last sync desc, rolled up over clients", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    const aliceId = await syncAs(store, orgId, newClientId(), "alice@example.com", minimalUploadRows("s1"), 1_000_000);
    const bobId = await syncAs(store, orgId, newClientId(), "bob@example.com", minimalUploadRows("s2"), 3_000_000);

    const users = await store.listUsers(orgId);
    expect(users).toHaveLength(2);
    expect(users[0]!.userId).toBe(bobId);
    expect(users[0]!.email).toBe("bob@example.com");
    expect(users[0]!.lastSyncMs).toBe(3_000_000);
    expect(users[0]!.sessionCount).toBe(1);
    expect(users[0]!.clientCount).toBe(1);
    expect(users[1]!.userId).toBe(aliceId);
    expect(users[1]!.email).toBe("alice@example.com");
    await store.close();
  });

  test("two clients on the same user count as clientCount=2", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    await syncAs(store, orgId, newClientId(), "alice@example.com", minimalUploadRows("s1"), 1_000_000);
    await syncAs(store, orgId, newClientId(), "alice@example.com", minimalUploadRows("s2"), 2_000_000);

    const users = await store.listUsers(orgId);
    expect(users).toHaveLength(1);
    expect(users[0]!.clientCount).toBe(2);
    expect(users[0]!.sessionCount).toBe(2);
    await store.close();
  });

  test("countUsers returns the number of distinct users for the org", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    await syncAs(store, orgId, newClientId(), "alice@example.com", minimalUploadRows("s1"), 1_000_000);
    await syncAs(store, orgId, newClientId(), "bob@example.com", minimalUploadRows("s2"), 2_000_000);
    await syncAs(store, orgId, newClientId(), "alice@example.com", minimalUploadRows("s3"), 3_000_000);

    expect(await store.countUsers(orgId)).toBe(2);
    await store.close();
  });
});

describe("groups", () => {
  test("createGroup creates a group and listGroups returns it with memberCount=0", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    const group = await store.createGroup(orgId, "Engineering", 1_000_000);
    expect(group.name).toBe("Engineering");
    expect(group.orgId).toBe(orgId);
    expect(group.memberCount).toBe(0);

    const groups = await store.listGroups(orgId);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.groupId).toBe(group.groupId);
    expect(groups[0]!.memberCount).toBe(0);
    await store.close();
  });

  test("createGroup rejects a duplicate name within the same org", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    await store.createGroup(orgId, "Engineering");
    await expect(store.createGroup(orgId, "Engineering")).rejects.toThrow(DuplicateGroupNameError);
    await store.close();
  });

  test("renameGroup renames a group", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    const group = await store.createGroup(orgId, "Engineering");
    await store.renameGroup(orgId, group.groupId, "Platform Engineering");

    const groups = await store.listGroups(orgId);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe("Platform Engineering");
    await store.close();
  });

  test("renameGroup rejects a name already used by another group in the org", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    await store.createGroup(orgId, "Engineering");
    const sales = await store.createGroup(orgId, "Sales");

    await expect(store.renameGroup(orgId, sales.groupId, "Engineering")).rejects.toThrow(DuplicateGroupNameError);
    await store.close();
  });

  test("renameGroup allows renaming a group to its own current name", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    const group = await store.createGroup(orgId, "Engineering");
    await store.renameGroup(orgId, group.groupId, "Engineering");

    const groups = await store.listGroups(orgId);
    expect(groups[0]!.name).toBe("Engineering");
    await store.close();
  });

  test("setUserGroup assigns and reassigns a user's group", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    const userId = await syncAs(store, orgId, newClientId(), "alice@example.com", minimalUploadRows("s1"), 1_000_000);
    const eng = await store.createGroup(orgId, "Engineering");
    const sales = await store.createGroup(orgId, "Sales");

    await store.setUserGroup(orgId, userId, eng.groupId);
    expect((await store.listGroups(orgId)).find((g) => g.groupId === eng.groupId)?.memberCount).toBe(1);

    await store.setUserGroup(orgId, userId, sales.groupId);
    const groups = await store.listGroups(orgId);
    expect(groups.find((g) => g.groupId === eng.groupId)?.memberCount).toBe(0);
    expect(groups.find((g) => g.groupId === sales.groupId)?.memberCount).toBe(1);
    await store.close();
  });

  test("setUserGroup(null) ungroups a user", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    const userId = await syncAs(store, orgId, newClientId(), "alice@example.com", minimalUploadRows("s1"), 1_000_000);
    const eng = await store.createGroup(orgId, "Engineering");
    await store.setUserGroup(orgId, userId, eng.groupId);

    await store.setUserGroup(orgId, userId, null);
    expect((await store.listGroups(orgId)).find((g) => g.groupId === eng.groupId)?.memberCount).toBe(0);
    await store.close();
  });

  test("setUsersGroup bulk-assigns many users at once", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    const alice = await syncAs(store, orgId, newClientId(), "alice@example.com", minimalUploadRows("s1"), 1_000_000);
    const bob = await syncAs(store, orgId, newClientId(), "bob@example.com", minimalUploadRows("s2"), 1_000_000);
    const eng = await store.createGroup(orgId, "Engineering");

    await store.setUsersGroup(orgId, [alice, bob], eng.groupId);

    const groups = await store.listGroups(orgId);
    expect(groups.find((g) => g.groupId === eng.groupId)?.memberCount).toBe(2);
    await store.close();
  });

  test("deleteGroup ungroups members instead of deleting them", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    const userId = await syncAs(store, orgId, newClientId(), "alice@example.com", minimalUploadRows("s1"), 1_000_000);
    const eng = await store.createGroup(orgId, "Engineering");
    await store.setUserGroup(orgId, userId, eng.groupId);

    await store.deleteGroup(orgId, eng.groupId);

    expect(await store.listGroups(orgId)).toHaveLength(0);
    const users = await store.listUsers(orgId);
    expect(users).toHaveLength(1);
    expect(users[0]!.userId).toBe(userId);
    await store.close();
  });

  test("after deleting a group, its name can be reused by a new group", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    const first = await store.createGroup(orgId, "Engineering");
    await store.deleteGroup(orgId, first.groupId);

    const second = await store.createGroup(orgId, "Engineering");
    expect(second.name).toBe("Engineering");
    await store.close();
  });
});

// ---- readResolved ----------------------------------------------------------------------

describe("readResolved", () => {
  test("returns sessions and messages scoped to org", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    await syncAs(store, orgId, newClientId(), "alice@example.com", minimalUploadRows("s-read"), 1_000_000);

    const result = await store.readResolved({ orgId });
    expect(result.sessions.has("s-read")).toBe(true);
    expect(result.messages).toHaveLength(1);
    await store.close();
  });

  test("scopes to a specific user when userId is provided (joining all of the user's clients)", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    const aliceA = await syncAs(store, orgId, newClientId(), "alice@example.com", minimalUploadRows("alice-a"), 1_000_000);
    await syncAs(store, orgId, newClientId(), "alice@example.com", minimalUploadRows("alice-b"), 2_000_000);
    await syncAs(store, orgId, newClientId(), "bob@example.com", minimalUploadRows("bob-only"), 3_000_000);

    const aliceResult = await store.readResolved({ orgId, userId: aliceA });
    expect(aliceResult.sessions.has("alice-a")).toBe(true);
    expect(aliceResult.sessions.has("alice-b")).toBe(true);
    expect(aliceResult.sessions.has("bob-only")).toBe(false);
    await store.close();
  });
});

// ---- readDashboardAggregates -----------------------------------------------------------

describe("readDashboardAggregates", () => {
  test("excludes archived sessions from dashboard counts and usage", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    const rows = minimalUploadRows("active-session");
    addInvocation(rows, "active-session");

    const archived = minimalUploadRows("archived-session");
    archived.sessions[0]!.archived = 1;
    addInvocation(archived, "archived-session");

    rows.sessions.push(...archived.sessions);
    rows.usage.push(...archived.usage);
    rows.invocations.push(...archived.invocations);

    await syncAs(store, orgId, newClientId(), "alice@example.com", rows, 1_000_000);

    const dashboard = await store.readDashboardAggregates({ orgId });
    const sessions = await store.readSessionAggregates({ orgId });
    await store.close();

    expect(sessions).toHaveLength(1);
    expect(dashboard.sessionsBySource).toEqual([{ source: "claude", sessions: 1 }]);
    expect(dashboard.usageBySourceModel).toHaveLength(1);
    expect(dashboard.usageBySourceModel[0]!.usage.input).toBe(100);
    expect(dashboard.usageBySourceModel[0]!.usage.output).toBe(50);
    expect(dashboard.byTool).toEqual([{ tool: "Read", category: "file-io", calls: 1, sessions: 1 }]);
    expect(dashboard.toolResultStats).toEqual([{ tool: "Read", count: 1, approxTokens: 25 }]);
  });
});

describe("readWindowFrictionRollup", () => {
  test("sums friction separately per client when session_ids collide across clients", async () => {
    const dataDir = tempDataDir();
    const store = await openHubStore(dataDir, 1_000_000);
    const orgId = (await store.getDefaultOrgId())!;

    // Session IDs are per-client UUIDs that can collide across different clients/users.
    const collidingSessionId = "collide-1";

    const aliceRows = minimalUploadRows(collidingSessionId);
    aliceRows.sessions[0]!.friction_interruptions = 2;
    aliceRows.sessions[0]!.friction_rejections = 1;
    aliceRows.sessions[0]!.friction_compactions = 0;
    aliceRows.sessions[0]!.friction_turns = 5;
    await syncAs(store, orgId, newClientId(), "alice@example.com", aliceRows, 1_000_000);

    const bobRows = minimalUploadRows(collidingSessionId);
    bobRows.sessions[0]!.friction_interruptions = 3;
    bobRows.sessions[0]!.friction_rejections = 0;
    bobRows.sessions[0]!.friction_compactions = 2;
    bobRows.sessions[0]!.friction_turns = 4;
    await syncAs(store, orgId, newClientId(), "bob@example.com", bobRows, 1_000_000);

    const friction = await store.readWindowFrictionRollup({ orgId }, {});
    await store.close();

    expect(friction.observableSessions).toBe(2);
    expect(friction.interruptions).toBe(5);
    expect(friction.rejections).toBe(1);
    expect(friction.compactions).toBe(2);
    expect(friction.turns).toBe(9);
  });
});
