import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sqlite3, { type Database, type RunResult } from "sqlite3";
import type {
  DashboardAggregates,
  FrictionTotals,
  MessageRecord,
  ParseResult,
  ResolvedQuery,
  SessionAggregate,
  SessionMeta,
  TaskFact,
  ToolCategory,
  ToolResultStat,
  Usage,
} from "../types.ts";
import { emptyFrictionTotals, foldFriction, HIGH_TOKEN_GROWTH_RATIO } from "../health.ts";

export const HUB_SCHEMA_VERSION = 2;
export const HUB_APPLICATION_ID = 0x48554200; // "HUB\0"

// ---- Raw row types (mirrors client argus.db resolved_* column shapes) -------------------

export interface UploadedSession {
  session_id: string;
  source: string;
  project: string;
  cwd: string;
  first_ts: number | null;
  last_ts: number | null;
  message_count: number;
  first_prompt: string | null;
  archived: number;
  friction_interruptions: number | null;
  friction_rejections: number | null;
  friction_compactions: number | null;
  friction_turns: number | null;
  last_interruption_ms: number | null;
  title: string | null;
  summary: string | null;
  meta_json: string;
}

export interface UploadedUsage {
  session_id: string;
  seq: number;
  source: string;
  ts: number;
  date: string;
  cwd: string;
  project: string;
  record_json: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read: number | null;
  cache_write_5m: number | null;
  cache_write_1h: number | null;
  model: string | null;
  attribution_skill: string | null;
  stop_reason: string | null;
  interaction_seq: number | null;
}

export interface UploadedTask {
  session_id: string;
  seq: number;
  source: string;
  ts: number | null;
  task_json: string;
}

export interface UploadedInteraction {
  session_id: string;
  seq: number;
  source: string;
  ts: number | null;
  initiator: string;
  disposition: string;
  compaction_count: number;
  task_seq: number | null;
  interaction_json: string;
}

export interface UploadedInvocation {
  session_id: string;
  seq: number;
  source: string;
  interaction_seq: number | null;
  tool: string;
  category: string;
  mcp_server: string | null;
  mcp_tool: string | null;
  skill: string | null;
  file_path: string | null;
  date: string | null;
  cwd: string | null;
  args: string | null;
  approx_result_tokens: number;
}

/** One label applied to a session or one of its tasks, denormalized (name/origin inline). The
 *  client sends applied labels only — there is no separate label-definition sync. Optional on the
 *  wire: older clients omit it. */
export interface UploadedLabel {
  session_id: string;
  source: string;
  name: string;
  origin: string;
  applied_by: string;
  target_kind: string;
  task_seq: number | null;
  applied_at_ms: number;
}

export interface HubUploadRows {
  sessions: UploadedSession[];
  usage: UploadedUsage[];
  tasks: UploadedTask[];
  interactions: UploadedInteraction[];
  invocations: UploadedInvocation[];
  labels: UploadedLabel[];
}

/** One fingerprint observation as it arrives from the client. The client de-dupes repeats
 *  locally, so the hub just appends what it receives. */
export interface UploadedFingerprintEntry {
  key: string;
  value: string;
  tsMs: number;
}

export interface HubUploadPayload {
  schemaVersion: number;
  rows: HubUploadRows;
}

export interface UserInfo {
  userId: string;
  displayName: string;
  email: string | null;
  lastSyncMs: number;
  sessionCount: number;
  clientCount: number;
}

export interface ClientInfo {
  clientId: string;
  orgId: string;
  userId: string | null;
  userPinned: boolean;
  firstSeenMs: number;
  lastSeenMs: number;
  fingerprint: Record<string, string>;
}

// ---- SQL helpers (same patterns as store.ts) --------------------------------------------

function run(db: Database, sql: string, params: unknown[] = []): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function callback(error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function exec(db: Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function get<T>(db: Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get<T>(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function all<T>(db: Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all<T>(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function closeDatabase(db: Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function transaction<T>(db: Database, operation: () => Promise<T>): Promise<T> {
  await exec(db, "BEGIN IMMEDIATE");
  try {
    const value = await operation();
    await exec(db, "COMMIT");
    return value;
  } catch (error) {
    await exec(db, "ROLLBACK").catch(() => undefined);
    throw error;
  }
}

const MAX_BOUND_PARAMS = 900;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function insertRows(
  db: Database,
  table: string,
  columns: readonly string[],
  rows: unknown[][],
): Promise<void> {
  if (!rows.length) return;
  const perRowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
  const rowsPerStatement = Math.max(1, Math.floor(MAX_BOUND_PARAMS / columns.length));
  for (const part of chunk(rows, rowsPerStatement)) {
    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${part
      .map(() => perRowPlaceholder)
      .join(", ")}`;
    await run(db, sql, part.flat());
  }
}

// ---- Schema DDL -------------------------------------------------------------------------
//
// The hub is client-centric: every install identifies itself with a stable `client-<uuid>`
// (minted client-side, see #141) and sends its fingerprint observations on each sync. Users
// are a reporting bucket: multiple clients can map to one user via clients.user_id, set by
// the auto-mapper at ingest time (unless user_pinned = 1, in which case the operator's
// mapping wins). All resolved_* rows are scoped by client_id; user-scoped reads JOIN clients.

// The applied-labels table (added in schema v2). Kept as its own constant so the fresh-install
// schema and the v1→v2 in-place migration create it from a single source of truth.
const RESOLVED_SESSION_LABELS_DDL = `
  CREATE TABLE resolved_session_labels (
    org_id        TEXT NOT NULL,
    client_id     TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    name          TEXT NOT NULL,
    origin        TEXT NOT NULL,
    applied_by    TEXT NOT NULL,
    target_kind   TEXT NOT NULL,
    task_seq      INTEGER,
    applied_at_ms INTEGER NOT NULL,
    FOREIGN KEY (org_id, client_id, session_id) REFERENCES resolved_sessions(org_id, client_id, session_id) ON DELETE CASCADE
  );
  CREATE INDEX resolved_session_labels_scope ON resolved_session_labels(org_id, session_id);
  CREATE INDEX resolved_session_labels_name  ON resolved_session_labels(org_id, name);
`;

const CREATE_HUB_SCHEMA_SQL = `
  CREATE TABLE organizations (
    org_id     TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE api_keys (
    key_hash   TEXT PRIMARY KEY,
    org_id     TEXT NOT NULL REFERENCES organizations(org_id),
    is_enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX api_keys_org ON api_keys(org_id);

  -- Reporting bucket: 1..N clients map onto one user via clients.user_id.
  CREATE TABLE users (
    user_id      TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES organizations(org_id),
    display_name TEXT NOT NULL,
    email        TEXT,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX users_org   ON users(org_id);
  CREATE INDEX users_email ON users(org_id, email);

  -- Every distinct Argus install we've heard from. user_pinned = 1 means the operator owns
  -- the user mapping and the auto-mapper must not overwrite it.
  CREATE TABLE clients (
    client_id     TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL REFERENCES organizations(org_id),
    first_seen_ms INTEGER NOT NULL,
    last_seen_ms  INTEGER NOT NULL,
    user_id       TEXT,
    user_pinned   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX clients_org  ON clients(org_id);
  CREATE INDEX clients_user ON clients(org_id, user_id);

  -- Append-only fingerprint observations (key/value/ts). Client de-dupes repeat-same-value
  -- writes locally, so the log we receive is already changes-only.
  CREATE TABLE client_fingerprint (
    client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    ts_ms     INTEGER NOT NULL,
    PRIMARY KEY (client_id, key, ts_ms)
  );
  CREATE INDEX client_fingerprint_key ON client_fingerprint(key, value);

  CREATE TABLE client_syncs (
    org_id       TEXT NOT NULL REFERENCES organizations(org_id),
    client_id    TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
    last_sync_ms INTEGER NOT NULL,
    PRIMARY KEY (org_id, client_id)
  );

  CREATE TABLE resolved_sessions (
    org_id                 TEXT NOT NULL,
    client_id              TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
    session_id             TEXT NOT NULL,
    source                 TEXT NOT NULL,
    project                TEXT NOT NULL,
    cwd                    TEXT NOT NULL,
    first_ts               INTEGER,
    last_ts                INTEGER,
    message_count          INTEGER NOT NULL,
    first_prompt           TEXT,
    archived               INTEGER NOT NULL DEFAULT 0,
    friction_interruptions INTEGER,
    friction_rejections    INTEGER,
    friction_compactions   INTEGER,
    friction_turns         INTEGER,
    last_interruption_ms   INTEGER,
    meta_json              TEXT NOT NULL,
    -- title/summary come last so this matches the v1->v2 ALTER TABLE ... ADD COLUMN order
    -- (fresh installs and upgraded stores must have identical column layout).
    title                  TEXT,
    summary                TEXT,
    PRIMARY KEY (org_id, client_id, session_id)
  );
  CREATE INDEX resolved_sessions_client  ON resolved_sessions(org_id, client_id);
  CREATE INDEX resolved_sessions_source  ON resolved_sessions(org_id, source);
  CREATE INDEX resolved_sessions_project ON resolved_sessions(org_id, project);
  CREATE INDEX resolved_sessions_last_ts ON resolved_sessions(org_id, last_ts);

  CREATE TABLE resolved_usage (
    org_id           TEXT NOT NULL,
    client_id        TEXT NOT NULL,
    session_id       TEXT NOT NULL,
    seq              INTEGER NOT NULL,
    source           TEXT NOT NULL,
    ts               INTEGER NOT NULL,
    date             TEXT NOT NULL,
    cwd              TEXT NOT NULL,
    project          TEXT NOT NULL,
    record_json      TEXT NOT NULL,
    input_tokens     INTEGER,
    output_tokens    INTEGER,
    cache_read       INTEGER,
    cache_write_5m   INTEGER,
    cache_write_1h   INTEGER,
    model            TEXT,
    attribution_skill TEXT,
    stop_reason      TEXT,
    interaction_seq  INTEGER,
    PRIMARY KEY (org_id, client_id, session_id, seq),
    FOREIGN KEY (org_id, client_id, session_id) REFERENCES resolved_sessions(org_id, client_id, session_id) ON DELETE CASCADE
  );
  CREATE INDEX resolved_usage_date       ON resolved_usage(org_id, date);
  CREATE INDEX resolved_usage_date_model ON resolved_usage(org_id, date, model);
  CREATE INDEX resolved_usage_source     ON resolved_usage(org_id, source);
  CREATE INDEX resolved_usage_ts         ON resolved_usage(org_id, ts);
  CREATE INDEX resolved_usage_client_session_date ON resolved_usage(org_id, client_id, session_id, date);

  CREATE TABLE resolved_tasks (
    org_id     TEXT NOT NULL,
    client_id  TEXT NOT NULL,
    session_id TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    source     TEXT NOT NULL,
    ts         INTEGER,
    task_json  TEXT NOT NULL,
    PRIMARY KEY (org_id, client_id, session_id, seq),
    FOREIGN KEY (org_id, client_id, session_id) REFERENCES resolved_sessions(org_id, client_id, session_id) ON DELETE CASCADE
  );
  CREATE INDEX resolved_tasks_source ON resolved_tasks(org_id, source);
  CREATE INDEX resolved_tasks_ts     ON resolved_tasks(org_id, ts);

  CREATE TABLE resolved_interactions (
    org_id           TEXT NOT NULL,
    client_id        TEXT NOT NULL,
    session_id       TEXT NOT NULL,
    seq              INTEGER NOT NULL,
    source           TEXT NOT NULL,
    ts               INTEGER,
    initiator        TEXT NOT NULL,
    disposition      TEXT NOT NULL,
    compaction_count INTEGER NOT NULL DEFAULT 0,
    task_seq         INTEGER,
    interaction_json TEXT NOT NULL,
    PRIMARY KEY (org_id, client_id, session_id, seq),
    FOREIGN KEY (org_id, client_id, session_id) REFERENCES resolved_sessions(org_id, client_id, session_id) ON DELETE CASCADE
  );
  CREATE INDEX resolved_interactions_task ON resolved_interactions(org_id, client_id, session_id, task_seq);

  CREATE TABLE resolved_invocations (
    org_id               TEXT NOT NULL,
    client_id            TEXT NOT NULL,
    session_id           TEXT NOT NULL,
    seq                  INTEGER NOT NULL,
    source               TEXT NOT NULL,
    interaction_seq      INTEGER,
    tool                 TEXT NOT NULL,
    category             TEXT NOT NULL,
    mcp_server           TEXT,
    mcp_tool             TEXT,
    skill                TEXT,
    file_path            TEXT,
    date                 TEXT,
    cwd                  TEXT,
    args                 TEXT,
    approx_result_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, client_id, session_id, seq),
    FOREIGN KEY (org_id, client_id, session_id) REFERENCES resolved_sessions(org_id, client_id, session_id) ON DELETE CASCADE
  );
  CREATE INDEX resolved_invocations_tool ON resolved_invocations(org_id, tool);
  CREATE INDEX resolved_invocations_date ON resolved_invocations(org_id, date);
  CREATE INDEX resolved_invocations_mcp_server ON resolved_invocations(mcp_server) WHERE mcp_server IS NOT NULL;
  CREATE INDEX resolved_invocations_skill      ON resolved_invocations(skill) WHERE skill IS NOT NULL;
  ${RESOLVED_SESSION_LABELS_DDL}
`;

// Forward-only, in-place migrations keyed by the version they upgrade FROM. Each step is purely
// additive (ADD COLUMN / CREATE TABLE), so existing rows are preserved and clients need not
// re-sync. A version with no entry here can't be upgraded in place (fatal — delete hub.db).
const HUB_MIGRATIONS: Record<number, string> = {
  // v1 → v2: session title/summary (#234) + applied labels.
  1: `
    ALTER TABLE resolved_sessions ADD COLUMN title TEXT;
    ALTER TABLE resolved_sessions ADD COLUMN summary TEXT;
    ${RESOLVED_SESSION_LABELS_DDL}
  `,
};

// ---- DB open / init ---------------------------------------------------------------------

function ensureDirectory(path: string): void {
  try {
    lstatSync(path);
  } catch {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== "win32") {
    try { chmodSync(path, 0o700); } catch { /* ignore */ }
  }
}

function openDatabase(path: string): Promise<Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(
      path,
      sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX,
      (error) => {
        if (error) { reject(error); return; }
        db.configure("busyTimeout", 5_000);
        resolve(db);
      },
    );
  });
}

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

async function initHubDatabase(db: Database, path: string): Promise<void> {
  await exec(db, "PRAGMA foreign_keys = ON");

  const appIdRow = await get<{ application_id: number }>(db, "PRAGMA application_id");
  const userVersionRow = await get<{ user_version: number }>(db, "PRAGMA user_version");
  const appId = appIdRow?.application_id ?? 0;
  const userVersion = userVersionRow?.user_version ?? 0;

  const tables = await all<{ name: string }>(
    db,
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );

  if (appId === 0 && userVersion === 0 && tables.length === 0) {
    // Fresh database — create schema.
    await transaction(db, async () => {
      await exec(db, CREATE_HUB_SCHEMA_SQL);
      await exec(db, `PRAGMA application_id = ${HUB_APPLICATION_ID}`);
      await exec(db, `PRAGMA user_version = ${HUB_SCHEMA_VERSION}`);
    });
  } else if (appId !== HUB_APPLICATION_ID) {
    throw new Error(`${path} is not an Argus Hub store.`);
  } else if (userVersion > HUB_SCHEMA_VERSION) {
    // The store was written by a newer Hub build than this one — we can't safely downgrade.
    throw new Error(
      `Hub store at ${path} is version ${userVersion}, newer than this build (v${HUB_SCHEMA_VERSION}). ` +
        `Update Argus Hub, or delete hub.db (and hub.db-wal / hub.db-shm) to start fresh.`,
    );
  } else if (userVersion < HUB_SCHEMA_VERSION) {
    // Upgrade in place by applying additive migrations sequentially. Existing rows are preserved,
    // so clients keep their sync cursors and don't need to re-upload everything.
    await transaction(db, async () => {
      for (let v = userVersion; v < HUB_SCHEMA_VERSION; v++) {
        const sql = HUB_MIGRATIONS[v];
        if (!sql) {
          throw new Error(
            `No in-place migration from Hub store v${v} to v${v + 1} at ${path}. ` +
              `Delete hub.db (and hub.db-wal / hub.db-shm) to start fresh — clients will then re-sync.`,
          );
        }
        await exec(db, sql);
        await exec(db, `PRAGMA user_version = ${v + 1}`);
      }
    });
  }

  await exec(db, "PRAGMA journal_mode = WAL");
  await exec(db, "PRAGMA synchronous = NORMAL");
  await exec(db, "PRAGMA trusted_schema = OFF");

  // Self-healing index for pre-existing databases created before this index was added to
  // CREATE_HUB_SCHEMA_SQL. Without it, readTaskFacts' per-row EXISTS(...) subquery against
  // resolved_usage falls back to scanning the whole date range instead of seeking straight to
  // the (client_id, session_id) pair, which made GET /api/activity take 10+ seconds on modest
  // data volumes.
  await exec(
    db,
    "CREATE INDEX IF NOT EXISTS resolved_usage_client_session_date " +
      "ON resolved_usage(org_id, client_id, session_id, date)",
  );

  // Secure WAL files too.
  if (process.platform !== "win32") {
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      try { chmodSync(candidate, 0o600); } catch { /* file may not exist yet */ }
    }
  }
}

// ---- Bootstrap: create Default org + print key if tables are empty ----------------------

async function bootstrap(db: Database, now: number): Promise<void> {
  const orgRow = await get<{ org_id: string }>(db, "SELECT org_id FROM organizations LIMIT 1");
  let defaultOrgId: string;
  if (!orgRow) {
    defaultOrgId = `org-${randomUUID()}`;
    await run(db, "INSERT INTO organizations(org_id, name, created_at) VALUES (?, 'Default', ?)", [
      defaultOrgId,
      now,
    ]);
  } else {
    defaultOrgId = orgRow.org_id;
  }

  const keyRow = await get<{ key_hash: string }>(db, "SELECT key_hash FROM api_keys LIMIT 1");
  if (!keyRow) {
    const key = `hub-${randomUUID()}`;
    await run(db, "INSERT INTO api_keys(key_hash, org_id, is_enabled) VALUES (?, ?, 1)", [
      hashApiKey(key),
      defaultOrgId,
    ]);
    process.stdout.write(`Hub API key (Default): ${key}\n`);
  }
}

// ---- Public factory + class -------------------------------------------------------------

export async function openHubStore(dataDir: string, now = Date.now()): Promise<HubStore> {
  ensureDirectory(dataDir);
  const dbPath = join(dataDir, "hub.db");

  if (process.platform !== "win32") {
    try {
      const fd = openSync(dbPath, constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      closeSync(fd);
      chmodSync(dbPath, 0o600);
    } catch { /* file already exists */ }
  }

  const db = await openDatabase(dbPath);
  await initHubDatabase(db, dbPath);
  await bootstrap(db, now);

  return new HubStore(db, dbPath);
}

// ---- HubStore ---------------------------------------------------------------------------

/** Scoping context applied to every query: org_id is required; userId narrows to the
 *  union of clients mapped to that user. clientId is also accepted for client-specific
 *  views (admin/debug). */
export interface HubScope {
  orgId: string;
  userId?: string;
  clientId?: string;
}

export interface HubTaskRow {
  task: TaskFact;
  project: string;
  sessionId: string;
  userId: string | null;
  displayName: string | null;
  /** The disposition of the interaction this task opened ("completed" | "interrupted" |
   *  "incomplete" | "error"), or null when no matching interaction was found. */
  disposition: string | null;
}

export class HubStore {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly db: Database,
    readonly path: string,
  ) {}

  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Hub store is closed"));
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ---- Access control -------------------------------------------------------------------

  lookupApiKey(key: string): Promise<{ orgId: string; isEnabled: boolean } | undefined> {
    return this.schedule(async () => {
      const row = await get<{ org_id: string; is_enabled: number }>(
        this.db,
        "SELECT org_id, is_enabled FROM api_keys WHERE key_hash = ?",
        [hashApiKey(key)],
      );
      if (!row) return undefined;
      return { orgId: row.org_id, isEnabled: row.is_enabled === 1 };
    });
  }

  // ---- Clients --------------------------------------------------------------------------

  /** Register a client (idempotent). On first sight we record `first_seen_ms`; every call
   *  bumps `last_seen_ms`. Throws if `clientId` doesn't match the `client-<uuid>` shape. */
  upsertClient(orgId: string, clientId: string, now = Date.now()): Promise<void> {
    return this.schedule(async () => {
      assertClientId(clientId);
      await run(
        this.db,
        `INSERT INTO clients(client_id, org_id, first_seen_ms, last_seen_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET last_seen_ms = excluded.last_seen_ms`,
        [clientId, orgId, now, now],
      );
    });
  }

  /** Append fingerprint observations to the log. Same-value writes are not de-duped here
   *  (the client already does it); we silently ignore PK collisions on (client_id, key, ts). */
  recordFingerprintObservations(
    clientId: string,
    entries: UploadedFingerprintEntry[],
  ): Promise<void> {
    return this.schedule(async () => {
      if (!entries.length) return;
      await transaction(this.db, async () => {
        for (const e of entries) {
          await run(
            this.db,
            "INSERT OR IGNORE INTO client_fingerprint(client_id, key, value, ts_ms) VALUES (?, ?, ?, ?)",
            [clientId, e.key, e.value, e.tsMs],
          );
        }
      });
    });
  }

  /** Read the most-recent value for each fingerprint key on a client. */
  latestFingerprint(clientId: string): Promise<Record<string, string>> {
    return this.schedule(async () => {
      const rows = await all<{ key: string; value: string }>(
        this.db,
        `SELECT key, value FROM client_fingerprint
         WHERE client_id = ?
           AND ts_ms = (SELECT MAX(ts_ms) FROM client_fingerprint cf2
                        WHERE cf2.client_id = client_fingerprint.client_id
                          AND cf2.key = client_fingerprint.key)`,
        [clientId],
      );
      const out: Record<string, string> = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    });
  }

  /** Auto-map a client to a user using its latest fingerprint. Skips clients with
   *  `user_pinned = 1`. Returns the resolved user_id (existing or newly minted), or the
   *  pinned user_id when the row is locked. */
  resolveUserForClient(orgId: string, clientId: string, now = Date.now()): Promise<string> {
    return this.schedule(async () => {
      const clientRow = await get<{ user_id: string | null; user_pinned: number }>(
        this.db,
        "SELECT user_id, user_pinned FROM clients WHERE client_id = ?",
        [clientId],
      );
      if (!clientRow) throw new Error(`Unknown clientId: ${clientId}`);
      if (clientRow.user_pinned === 1 && clientRow.user_id) return clientRow.user_id;

      const fp = await this.latestFingerprintInternal(clientId);
      const email = fp["claude.oauth.email"] ?? fp["codex.oauth.email"] ?? null;
      const name = fp["git.user.name"] ?? null;
      const display = email ?? name ?? clientId;

      // Look for an existing user to fold into.
      let userId: string | undefined;
      if (email) {
        const byEmail = await get<{ user_id: string }>(
          this.db,
          "SELECT user_id FROM users WHERE org_id = ? AND email = ?",
          [orgId, email],
        );
        userId = byEmail?.user_id;
      }
      if (!userId && name) {
        const byName = await get<{ user_id: string }>(
          this.db,
          "SELECT user_id FROM users WHERE org_id = ? AND email IS NULL AND display_name = ?",
          [orgId, name],
        );
        userId = byName?.user_id;
      }
      if (!userId) {
        userId = `user-${randomUUID()}`;
        await run(
          this.db,
          "INSERT INTO users(user_id, org_id, display_name, email, created_at) VALUES (?, ?, ?, ?, ?)",
          [userId, orgId, display, email, now],
        );
      } else if (email) {
        // Keep the display_name fresh on the existing user when a real email is present.
        await run(
          this.db,
          "UPDATE users SET display_name = ?, email = ? WHERE user_id = ?",
          [display, email, userId],
        );
      }

      await run(this.db, "UPDATE clients SET user_id = ? WHERE client_id = ?", [userId, clientId]);
      return userId;
    });
  }

  /** Pin (or unpin) a client to a user. Pinning prevents the auto-mapper from overwriting
   *  the mapping on subsequent syncs. */
  pinClientToUser(clientId: string, userId: string | null, pinned: boolean): Promise<void> {
    return this.schedule(async () => {
      await run(
        this.db,
        "UPDATE clients SET user_id = ?, user_pinned = ? WHERE client_id = ?",
        [userId, pinned ? 1 : 0, clientId],
      );
    });
  }

  /** Every client in an org with its current user mapping + latest fingerprint snapshot. */
  listClients(orgId: string): Promise<ClientInfo[]> {
    return this.schedule(async () => {
      const rows = await all<{
        client_id: string; user_id: string | null; user_pinned: number;
        first_seen_ms: number; last_seen_ms: number;
      }>(
        this.db,
        `SELECT client_id, user_id, user_pinned, first_seen_ms, last_seen_ms
         FROM clients WHERE org_id = ? ORDER BY last_seen_ms DESC, client_id`,
        [orgId],
      );
      const out: ClientInfo[] = [];
      for (const r of rows) {
        out.push({
          clientId: r.client_id,
          orgId,
          userId: r.user_id,
          userPinned: r.user_pinned === 1,
          firstSeenMs: r.first_seen_ms,
          lastSeenMs: r.last_seen_ms,
          fingerprint: await this.latestFingerprintInternal(r.client_id),
        });
      }
      return out;
    });
  }

  /** Resolve clientIds for a user inside an org. Used internally to translate a user-scoped
   *  read into a `client_id IN (...)` clause. */
  private async clientIdsForUser(orgId: string, userId: string): Promise<string[]> {
    const rows = await all<{ client_id: string }>(
      this.db,
      "SELECT client_id FROM clients WHERE org_id = ? AND user_id = ?",
      [orgId, userId],
    );
    return rows.map((r) => r.client_id);
  }

  private async latestFingerprintInternal(clientId: string): Promise<Record<string, string>> {
    const rows = await all<{ key: string; value: string }>(
      this.db,
      `SELECT key, value FROM client_fingerprint
       WHERE client_id = ?
         AND ts_ms = (SELECT MAX(ts_ms) FROM client_fingerprint cf2
                      WHERE cf2.client_id = client_fingerprint.client_id
                        AND cf2.key = client_fingerprint.key)`,
      [clientId],
    );
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  // ---- Ingest ---------------------------------------------------------------------------

  upsertClientSessions(
    orgId: string,
    clientId: string,
    rows: HubUploadRows,
    now = Date.now(),
  ): Promise<{ sessionsUpserted: number }> {
    return this.schedule(async () => {
      await transaction(this.db, async () => {
        for (const session of rows.sessions) {
          const sid = session.session_id;
          await run(
            this.db,
            "DELETE FROM resolved_sessions WHERE org_id = ? AND client_id = ? AND session_id = ?",
            [orgId, clientId, sid],
          );
          await run(
            this.db,
            `INSERT INTO resolved_sessions(
               org_id, client_id, session_id,
               source, project, cwd, first_ts, last_ts, message_count, first_prompt, archived,
               friction_interruptions, friction_rejections, friction_compactions,
               friction_turns, last_interruption_ms, title, summary, meta_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              orgId, clientId, sid,
              session.source, session.project, session.cwd,
              session.first_ts, session.last_ts, session.message_count,
              session.first_prompt, session.archived,
              session.friction_interruptions, session.friction_rejections,
              session.friction_compactions, session.friction_turns,
              session.last_interruption_ms, session.title ?? null, session.summary ?? null,
              session.meta_json,
            ],
          );
        }

        const sessionIds = new Set(rows.sessions.map((s) => s.session_id));
        const usageForSessions = rows.usage.filter((u) => sessionIds.has(u.session_id));
        await insertRows(
          this.db,
          "resolved_usage",
          [
            "org_id", "client_id", "session_id", "seq", "source", "ts", "date", "cwd", "project",
            "record_json", "input_tokens", "output_tokens", "cache_read", "cache_write_5m",
            "cache_write_1h", "model", "attribution_skill", "stop_reason", "interaction_seq",
          ],
          usageForSessions.map((u) => [
            orgId, clientId, u.session_id, u.seq, u.source, u.ts, u.date, u.cwd, u.project,
            u.record_json, u.input_tokens, u.output_tokens, u.cache_read, u.cache_write_5m,
            u.cache_write_1h, u.model, u.attribution_skill, u.stop_reason, u.interaction_seq,
          ]),
        );

        await insertRows(
          this.db,
          "resolved_tasks",
          ["org_id", "client_id", "session_id", "seq", "source", "ts", "task_json"],
          rows.tasks.filter((t) => sessionIds.has(t.session_id)).map((t) => [
            orgId, clientId, t.session_id, t.seq, t.source, t.ts, t.task_json,
          ]),
        );

        await insertRows(
          this.db,
          "resolved_interactions",
          [
            "org_id", "client_id", "session_id", "seq", "source", "ts",
            "initiator", "disposition", "compaction_count", "task_seq", "interaction_json",
          ],
          rows.interactions.filter((i) => sessionIds.has(i.session_id)).map((i) => [
            orgId, clientId, i.session_id, i.seq, i.source, i.ts,
            i.initiator, i.disposition, i.compaction_count, i.task_seq, i.interaction_json,
          ]),
        );

        await insertRows(
          this.db,
          "resolved_invocations",
          [
            "org_id", "client_id", "session_id", "seq", "source", "interaction_seq",
            "tool", "category", "mcp_server", "mcp_tool", "skill", "file_path",
            "date", "cwd", "args", "approx_result_tokens",
          ],
          rows.invocations.filter((v) => sessionIds.has(v.session_id)).map((v) => [
            orgId, clientId, v.session_id, v.seq, v.source, v.interaction_seq,
            v.tool, v.category, v.mcp_server, v.mcp_tool, v.skill, v.file_path,
            v.date, v.cwd, v.args, v.approx_result_tokens,
          ]),
        );

        // Applied labels (optional on the wire — older clients omit them). Session-scoped, so the
        // delete-then-insert of the session above already cleared any prior labels via CASCADE.
        await insertRows(
          this.db,
          "resolved_session_labels",
          [
            "org_id", "client_id", "session_id", "name", "origin",
            "applied_by", "target_kind", "task_seq", "applied_at_ms",
          ],
          (rows.labels ?? []).filter((l) => sessionIds.has(l.session_id)).map((l) => [
            orgId, clientId, l.session_id, l.name, l.origin,
            l.applied_by, l.target_kind, l.task_seq, l.applied_at_ms,
          ]),
        );

        await run(
          this.db,
          `INSERT INTO client_syncs(org_id, client_id, last_sync_ms)
           VALUES (?, ?, ?)
           ON CONFLICT(org_id, client_id) DO UPDATE SET last_sync_ms = excluded.last_sync_ms`,
          [orgId, clientId, now],
        );
      });

      return { sessionsUpserted: rows.sessions.length };
    });
  }

  /**
   * Return the subset of `candidateSessionIds` that are NOT already stored in
   * resolved_sessions for (orgId, clientId). Lets a client skip re-uploading
   * sessions the Hub already has from this install.
   */
  findUnknownSessionIds(
    orgId: string,
    clientId: string,
    candidateSessionIds: string[],
  ): Promise<string[]> {
    return this.schedule(async () => {
      const deduped: string[] = [];
      const seen = new Set<string>();
      for (const id of candidateSessionIds) {
        if (!seen.has(id)) { seen.add(id); deduped.push(id); }
      }
      if (!deduped.length) return [];

      const known = new Set<string>();
      for (const part of chunk(deduped, 500)) {
        const placeholders = part.map(() => "?").join(", ");
        const rows = await all<{ session_id: string }>(
          this.db,
          `SELECT session_id FROM resolved_sessions
           WHERE org_id = ? AND client_id = ? AND session_id IN (${placeholders})`,
          [orgId, clientId, ...part],
        );
        for (const r of rows) known.add(r.session_id);
      }
      return deduped.filter((id) => !known.has(id));
    });
  }

  // ---- User list (GET /api/users) -------------------------------------------------------

  listUsers(orgId: string): Promise<UserInfo[]> {
    return this.schedule(async () => {
      const rows = await all<{
        user_id: string; display_name: string; email: string | null;
        last_sync_ms: number; session_count: number; client_count: number;
      }>(
        this.db,
        `SELECT u.user_id, u.display_name, u.email,
                MAX(cs.last_sync_ms)                       AS last_sync_ms,
                COUNT(DISTINCT rs.client_id || ':' || rs.session_id) AS session_count,
                COUNT(DISTINCT c.client_id)                AS client_count
         FROM users u
         JOIN clients c ON c.org_id = u.org_id AND c.user_id = u.user_id
         LEFT JOIN client_syncs cs ON cs.org_id = c.org_id AND cs.client_id = c.client_id
         LEFT JOIN resolved_sessions rs ON rs.org_id = c.org_id AND rs.client_id = c.client_id
         WHERE u.org_id = ?
         GROUP BY u.user_id
         ORDER BY last_sync_ms DESC, u.created_at DESC, u.user_id`,
        [orgId],
      );
      return rows.map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        email: r.email,
        lastSyncMs: r.last_sync_ms ?? 0,
        sessionCount: r.session_count,
        clientCount: r.client_count,
      }));
    });
  }

  countUsers(orgId: string): Promise<number> {
    return this.schedule(async () => {
      const row = await get<{ n: number }>(
        this.db,
        "SELECT COUNT(*) AS n FROM users WHERE org_id = ?",
        [orgId],
      );
      return row?.n ?? 0;
    });
  }

  // ---- Dashboard read queries -----------------------------------------------------------
  //
  // All resolved_* queries are scoped by (org_id [, client_id IN (...)]). For user-scoped
  // reads we expand userId to its set of clientIds before building the WHERE clause.

  async readResolved(scope: HubScope, query?: ResolvedQuery): Promise<ParseResult> {
    const expanded = await this.expandScope(scope);
    return this.schedule(() => this.readResolvedCore(expanded, query));
  }

  private async readResolvedCore(scope: ExpandedScope, query?: ResolvedQuery): Promise<ParseResult> {
    const filters = buildHubFilters(scope, query);

    const messageRows = await all<{ session_id: string; record_json: string }>(
      this.db,
      `SELECT session_id, record_json FROM resolved_usage ${filters.messageWhere}
       ORDER BY ts, source, session_id, seq`,
      filters.messageParams,
    );
    const messages = messageRows.map((row) => JSON.parse(row.record_json) as MessageRecord);

    const sessionRows = await all<{ session_id: string; meta_json: string }>(
      this.db,
      `SELECT session_id, meta_json FROM resolved_sessions WHERE ${filters.scopeAndSource}
       ORDER BY rowid`,
      filters.scopeAndSourceParams,
    );
    const sessions = new Map<string, SessionMeta>();
    if (filters.active) {
      const keep = new Set(messageRows.map((row) => row.session_id));
      for (const row of sessionRows) {
        if (keep.has(row.session_id)) sessions.set(row.session_id, JSON.parse(row.meta_json) as SessionMeta);
      }
    } else {
      for (const row of sessionRows) sessions.set(row.session_id, JSON.parse(row.meta_json) as SessionMeta);
    }

    const taskRows = await all<{ session_id: string; task_json: string }>(
      this.db,
      `SELECT session_id, task_json FROM resolved_tasks WHERE ${filters.scopeAndSource}
       ORDER BY session_id, ts IS NULL, ts, seq`,
      filters.scopeAndSourceParams,
    );
    const tasksBySession = new Map<string, TaskFact[]>();
    for (const row of taskRows) {
      if (!sessions.has(row.session_id)) continue;
      const tasks = tasksBySession.get(row.session_id) ?? [];
      tasks.push(JSON.parse(row.task_json) as TaskFact);
      tasksBySession.set(row.session_id, tasks);
    }

    const toolRows = await all<{ name: string; count: number; approx_tokens: number }>(
      this.db,
      `SELECT tool AS name, COUNT(*) AS count, SUM(approx_result_tokens) AS approx_tokens
       FROM resolved_invocations WHERE ${filters.scopeAndSource}
       GROUP BY tool`,
      filters.scopeAndSourceParams,
    );
    const toolResults = new Map<string, ToolResultStat>();
    for (const row of toolRows) toolResults.set(row.name, { count: row.count, approxTokens: row.approx_tokens ?? 0 });

    return { messages, sessions, toolResults, tasksBySession };
  }

  async readSessionAggregates(scope: HubScope, query?: ResolvedQuery): Promise<SessionAggregate[]> {
    const expanded = await this.expandScope(scope);
    return this.schedule(async () => {
      const sessionConds = [scopeWhereSql(expanded, "s")];
      const sessionParams: unknown[] = [...scopeParams(expanded)];
      sessionConds.push("s.archived = 0");

      if (query?.sources?.length) {
        sessionConds.push(`s.source IN (${query.sources.map(() => "?").join(", ")})`);
        sessionParams.push(...query.sources);
      }
      if (query?.projectSubstring) {
        sessionConds.push("instr(s.cwd, ?) > 0");
        sessionParams.push(query.projectSubstring);
      }

      const dateConds: string[] = [];
      const dateParams: unknown[] = [];
      if (query?.since) { dateConds.push("m.date >= ?"); dateParams.push(query.since); }
      if (query?.until) { dateConds.push("m.date <= ?"); dateParams.push(query.until); }
      if (dateConds.length) {
        sessionConds.push(
          `EXISTS (SELECT 1 FROM resolved_usage m WHERE m.org_id = s.org_id AND m.client_id = s.client_id AND m.session_id = s.session_id AND ${dateConds.join(" AND ")})`,
        );
        sessionParams.push(...dateParams);
      }

      const sessionRows = await all<{
        session_id: string; first_ts: number | null; last_ts: number | null;
        message_count: number; meta_json: string;
      }>(
        this.db,
        `SELECT session_id, first_ts, last_ts, message_count, meta_json FROM resolved_sessions s WHERE ${sessionConds.join(" AND ")}`,
        sessionParams,
      );

      const srcConds = [scopeWhereSql(expanded)];
      const srcParams = [...scopeParams(expanded)];
      if (query?.sources?.length) {
        srcConds.push(`source IN (${query.sources.map(() => "?").join(", ")})`);
        srcParams.push(...query.sources);
      }
      const usageRows = await all<{
        session_id: string; model: string | null;
        input: number; output: number; cache_read: number; cache_write_5m: number; cache_write_1h: number;
      }>(
        this.db,
        `SELECT session_id, model,
            SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read) AS cache_read,
            SUM(cache_write_5m) AS cache_write_5m, SUM(cache_write_1h) AS cache_write_1h
         FROM resolved_usage WHERE ${srcConds.join(" AND ")}
         GROUP BY session_id, model`,
        srcParams,
      );
      const byModelBySession = new Map<string, { model: string; usage: Usage }[]>();
      for (const row of usageRows) {
        const list = byModelBySession.get(row.session_id) ?? byModelBySession.set(row.session_id, []).get(row.session_id)!;
        list.push({
          model: row.model ?? "",
          usage: {
            input: row.input ?? 0,
            output: row.output ?? 0,
            cacheRead: row.cache_read ?? 0,
            cacheWrite5m: row.cache_write_5m ?? 0,
            cacheWrite1h: row.cache_write_1h ?? 0,
          },
        });
      }

      return sessionRows.map((row) => ({
        meta: JSON.parse(row.meta_json) as SessionMeta,
        byModel: byModelBySession.get(row.session_id) ?? [],
        firstTs: row.first_ts,
        lastTs: row.last_ts,
        messageCount: row.message_count,
      }));
    });
  }

  async readDashboardAggregates(scope: HubScope, query?: ResolvedQuery): Promise<DashboardAggregates> {
    const expanded = await this.expandScope(scope);
    return this.schedule(() => this.readDashboardAggregatesCore(expanded, query));
  }

  private async readDashboardAggregatesCore(
    scope: ExpandedScope,
    query?: ResolvedQuery,
  ): Promise<DashboardAggregates> {
    const filters = buildHubFilters(scope, query, {
      sourceColumn: "u.source", dateColumn: "u.date", cwdColumn: "u.cwd", tableAlias: "u",
    }, { excludeArchived: true });
    const SUMS =
      "SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read) AS cache_read, " +
      "SUM(cache_write_5m) AS cw5, SUM(cache_write_1h) AS cw1, COUNT(*) AS messages";
    interface SumRow {
      input: number | null; output: number | null; cache_read: number | null;
      cw5: number | null; cw1: number | null; messages: number;
    }
    const toUsage = (r: SumRow): Usage => ({
      input: r.input ?? 0, output: r.output ?? 0, cacheRead: r.cache_read ?? 0,
      cacheWrite5m: r.cw5 ?? 0, cacheWrite1h: r.cw1 ?? 0,
    });

    const usageByDateModel = (
      await all<SumRow & { date: string; model: string | null }>(
        this.db,
        `SELECT date, model, ${SUMS} FROM resolved_usage u ${filters.messageWhere} GROUP BY date, model`,
        filters.messageParams,
      )
    ).map((r) => ({ date: r.date, model: r.model ?? "", usage: toUsage(r), messages: r.messages }));

    const usageBySourceModel = (
      await all<SumRow & { source: string; model: string | null }>(
        this.db,
        `SELECT source, model, ${SUMS} FROM resolved_usage u ${filters.messageWhere} GROUP BY source, model`,
        filters.messageParams,
      )
    ).map((r) => ({ source: r.source, model: r.model ?? "", usage: toUsage(r), messages: r.messages }));

    const usageByProjectModel = (
      await all<SumRow & { project: string; model: string | null }>(
        this.db,
        `SELECT project, model, ${SUMS} FROM resolved_usage u ${filters.messageWhere} GROUP BY project, model`,
        filters.messageParams,
      )
    ).map((r) => ({ project: r.project, model: r.model ?? "", usage: toUsage(r), messages: r.messages }));

    const usageBySkillModel = (
      await all<SumRow & { attribution_skill: string | null; model: string | null }>(
        this.db,
        `SELECT attribution_skill, model, ${SUMS} FROM resolved_usage u ${filters.messageWhere} GROUP BY attribution_skill, model`,
        filters.messageParams,
      )
    ).map((r) => ({ skill: r.attribution_skill ?? "", model: r.model ?? "", usage: toUsage(r), messages: r.messages }));

    const TOTAL = "(input_tokens + output_tokens + cache_read + cache_write_5m + cache_write_1h)";
    const skillDateWhere = filters.messageWhere
      ? `${filters.messageWhere} AND attribution_skill IS NOT NULL`
      : "WHERE attribution_skill IS NOT NULL";
    const skillTokensByDate = (
      await all<{ date: string; skill: string; total: number }>(
        this.db,
        `SELECT date, attribution_skill AS skill, SUM(${TOTAL}) AS total
         FROM resolved_usage u ${skillDateWhere} GROUP BY date, attribution_skill`,
        filters.messageParams,
      )
    ).map((r) => ({ date: r.date, skill: r.skill, total: r.total ?? 0 }));

    const sessionsBySource = await all<{ source: string; sessions: number }>(
      this.db,
      `SELECT source, COUNT(DISTINCT session_id) AS sessions FROM resolved_usage u ${filters.messageWhere} GROUP BY source`,
      filters.messageParams,
    );
    const sessionsByProject = await all<{ project: string; sessions: number }>(
      this.db,
      `SELECT project, COUNT(DISTINCT session_id) AS sessions FROM resolved_usage u ${filters.messageWhere} GROUP BY project`,
      filters.messageParams,
    );

    const invFilters = buildHubFilters(scope, query, {
      sourceColumn: "i.source", dateColumn: "i.date", cwdColumn: "i.cwd", tableAlias: "i",
    }, { excludeArchived: true });
    const invSourceFilters = buildHubFilters(
      scope,
      query?.sources?.length ? { sources: query.sources } : undefined,
      { sourceColumn: "i.source", dateColumn: "i.date", cwdColumn: "i.cwd", tableAlias: "i" },
      { excludeArchived: true },
    );

    const toolResultStats = (
      await all<{ tool: string; count: number; approx: number | null }>(
        this.db,
        `SELECT tool, COUNT(*) AS count, SUM(approx_result_tokens) AS approx
         FROM resolved_invocations i ${invSourceFilters.messageWhere} GROUP BY tool`,
        invSourceFilters.messageParams,
      )
    ).map((r) => ({ tool: r.tool, count: r.count, approxTokens: r.approx ?? 0 }));

    const byTool = (
      await all<{ tool: string; category: string; calls: number; sessions: number }>(
        this.db,
        `SELECT tool, MIN(category) AS category, COUNT(*) AS calls, COUNT(DISTINCT session_id) AS sessions
         FROM resolved_invocations i ${invFilters.messageWhere} GROUP BY tool`,
        invFilters.messageParams,
      )
    ).map((r) => ({ tool: r.tool, category: r.category as ToolCategory, calls: r.calls, sessions: r.sessions }));

    const byToolCategory = (
      await all<{ category: string; calls: number; tools: number; sessions: number }>(
        this.db,
        `SELECT category, COUNT(*) AS calls, COUNT(DISTINCT tool) AS tools, COUNT(DISTINCT session_id) AS sessions
         FROM resolved_invocations i ${invFilters.messageWhere} GROUP BY category`,
        invFilters.messageParams,
      )
    ).map((r) => ({ category: r.category as ToolCategory, calls: r.calls, tools: r.tools, sessions: r.sessions }));

    const mcpFilter = invFilters.messageWhere
      ? `${invFilters.messageWhere} AND i.mcp_server IS NOT NULL`
      : "WHERE i.mcp_server IS NOT NULL";
    const mcpServers = await all<{ server: string; calls: number }>(
      this.db,
      `SELECT mcp_server AS server, COUNT(*) AS calls FROM resolved_invocations i ${mcpFilter} GROUP BY mcp_server`,
      invFilters.messageParams,
    );
    const mcpServerTools = await all<{ server: string; tool: string; count: number }>(
      this.db,
      `SELECT mcp_server AS server, tool, COUNT(*) AS count FROM resolved_invocations i ${mcpFilter} GROUP BY mcp_server, tool`,
      invFilters.messageParams,
    );

    const skillFilter = invFilters.messageWhere
      ? `${invFilters.messageWhere} AND i.tool IN ('Skill', 'activate_skill') AND i.skill IS NOT NULL`
      : "WHERE i.tool IN ('Skill', 'activate_skill') AND i.skill IS NOT NULL";
    const skillCounts = await all<{ skill: string; count: number }>(
      this.db,
      `SELECT skill, COUNT(*) AS count FROM resolved_invocations i ${skillFilter} GROUP BY skill`,
      invFilters.messageParams,
    );
    const skillArgsRows = await all<{ skill: string; args: string | null }>(
      this.db,
      `SELECT skill, args FROM (
         SELECT skill, args, ROW_NUMBER() OVER (
           PARTITION BY skill ORDER BY (args IS NULL), session_id, seq
         ) AS rn
         FROM resolved_invocations i ${skillFilter}
       ) WHERE rn = 1`,
      invFilters.messageParams,
    );
    const sampleArgsBySkill = new Map(skillArgsRows.map((r) => [r.skill, r.args ?? ""]));
    const skillInvocations = skillCounts.map((r) => ({
      skill: r.skill, count: r.count, sampleArgs: sampleArgsBySkill.get(r.skill) ?? "",
    }));

    const { friction, growth } = await this.readHealthRollups(scope, filters);

    return {
      usageByDateModel, usageBySourceModel, usageByProjectModel, usageBySkillModel,
      skillTokensByDate, sessionsBySource, sessionsByProject,
      toolResultStats, byTool, byToolCategory, mcpServers, mcpServerTools,
      skillInvocations, frictionTotals: friction.totals, projectFriction: friction.byProject,
      highTokenGrowthSessions: growth,
    };
  }

  private async readHealthRollups(
    scope: ExpandedScope,
    filters: ReturnType<typeof buildHubFilters>,
  ): Promise<{
    friction: { totals: FrictionTotals; byProject: Array<{ project: string; friction: FrictionTotals }> };
    growth: number;
  }> {
    const joinFilters = buildHubFilters(scope, undefined, {
      sourceColumn: "m.source", dateColumn: "m.date", cwdColumn: "m.cwd", tableAlias: "m",
    }, { excludeArchived: true });
    const sessions = await all<{
      session_id: string; project: string;
      fi: number | null; fr: number | null; fc: number | null; ft: number | null;
    }>(
      this.db,
      `SELECT m.session_id AS session_id, s.project AS project,
              s.friction_interruptions AS fi, s.friction_rejections AS fr,
              s.friction_compactions AS fc, s.friction_turns AS ft
       FROM resolved_usage m JOIN resolved_sessions s
         ON s.org_id = m.org_id AND s.client_id = m.client_id AND s.session_id = m.session_id
       ${joinFilters.messageWhere}
       GROUP BY m.session_id`,
      joinFilters.messageParams,
    );

    const growthRows = await all<{ first_mean: number | null; last_mean: number | null }>(
      this.db,
      `SELECT AVG(CASE WHEN rn <= n / 10 THEN total END) AS first_mean,
              AVG(CASE WHEN rn > n - n / 10 THEN total END) AS last_mean
       FROM (
         SELECT session_id,
                (input_tokens + output_tokens + cache_read + cache_write_5m + cache_write_1h) AS total,
                ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq) AS rn,
                COUNT(*) OVER (PARTITION BY session_id) AS n
         FROM resolved_usage u ${filters.messageWhere}
       )
       WHERE n >= 10
       GROUP BY session_id`,
      filters.messageParams,
    );
    let highTokenGrowthSessions = 0;
    for (const r of growthRows) {
      const first = r.first_mean ?? 0;
      const last = r.last_mean ?? 0;
      if (first > 0 && last / first >= HIGH_TOKEN_GROWTH_RATIO) highTokenGrowthSessions += 1;
    }

    const totals = emptyFrictionTotals();
    const byProjectMap = new Map<string, FrictionTotals>();
    for (const row of sessions) {
      if (row.fi != null) {
        const pf = byProjectMap.get(row.project) ?? emptyFrictionTotals();
        if (!byProjectMap.has(row.project)) byProjectMap.set(row.project, pf);
        const contribution = { interruptions: row.fi, rejections: row.fr ?? 0, compactions: row.fc ?? 0, turns: row.ft ?? 0 };
        for (const bucket of [totals, pf]) foldFriction(bucket, contribution);
      }
    }
    return {
      friction: { totals, byProject: [...byProjectMap.entries()].map(([project, friction]) => ({ project, friction })) },
      growth: highTokenGrowthSessions,
    };
  }

  // ---- User stats (for GET /api/users enriched response) --------------------------------

  /** Per-user token sums by model, rolled up across all clients mapped to the user. */
  readUserStats(orgId: string): Promise<
    Array<{
      userId: string;
      displayName: string;
      email: string | null;
      lastSyncMs: number;
      sessionCount: number;
      clientCount: number;
      byModel: Array<{ model: string; input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }>;
    }>
  > {
    return this.schedule(async () => {
      const users = await all<{
        user_id: string; display_name: string; email: string | null;
        last_sync_ms: number | null; session_count: number; client_count: number;
      }>(
        this.db,
        `SELECT u.user_id, u.display_name, u.email,
                MAX(cs.last_sync_ms)                       AS last_sync_ms,
                COUNT(DISTINCT rs.client_id || ':' || rs.session_id) AS session_count,
                COUNT(DISTINCT c.client_id)                AS client_count
         FROM users u
         JOIN clients c ON c.org_id = u.org_id AND c.user_id = u.user_id
         LEFT JOIN client_syncs cs ON cs.org_id = c.org_id AND cs.client_id = c.client_id
         LEFT JOIN resolved_sessions rs ON rs.org_id = c.org_id AND rs.client_id = c.client_id
         WHERE u.org_id = ?
         GROUP BY u.user_id
         ORDER BY last_sync_ms DESC, u.user_id`,
        [orgId],
      );
      if (!users.length) return [];

      const usageRows = await all<{
        user_id: string; model: string;
        input: number; output: number; cache_read: number; cache_write_5m: number; cache_write_1h: number;
      }>(
        this.db,
        `SELECT c.user_id AS user_id, ru.model,
                SUM(COALESCE(ru.input_tokens, 0)) AS input,
                SUM(COALESCE(ru.output_tokens, 0)) AS output,
                SUM(COALESCE(ru.cache_read, 0)) AS cache_read,
                SUM(COALESCE(ru.cache_write_5m, 0)) AS cache_write_5m,
                SUM(COALESCE(ru.cache_write_1h, 0)) AS cache_write_1h
         FROM resolved_usage ru
         JOIN clients c ON c.client_id = ru.client_id
         WHERE c.org_id = ? AND c.user_id IS NOT NULL AND ru.model IS NOT NULL
         GROUP BY c.user_id, ru.model`,
        [orgId],
      );
      const byUser = new Map<string, Array<{ model: string; input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }>>();
      for (const r of usageRows) {
        const list = byUser.get(r.user_id) ?? [];
        byUser.set(r.user_id, list);
        list.push({
          model: r.model,
          input: r.input, output: r.output,
          cacheRead: r.cache_read, cacheWrite5m: r.cache_write_5m, cacheWrite1h: r.cache_write_1h,
        });
      }

      return users.map((u) => ({
        userId: u.user_id,
        displayName: u.display_name,
        email: u.email,
        lastSyncMs: u.last_sync_ms ?? 0,
        sessionCount: u.session_count,
        clientCount: u.client_count,
        byModel: byUser.get(u.user_id) ?? [],
      }));
    });
  }

  /** All organizations with aggregate stats: user count, session count, total tokens. */
  listOrgs(): Promise<
    Array<{
      orgId: string;
      name: string;
      createdAt: number;
      userCount: number;
      sessionCount: number;
      totalTokens: number;
      byModel: Array<{ model: string; input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }>;
    }>
  > {
    return this.schedule(async () => {
      const orgs = await all<{ org_id: string; name: string; created_at: number }>(
        this.db,
        "SELECT org_id, name, created_at FROM organizations ORDER BY created_at",
      );
      return Promise.all(
        orgs.map(async (org) => {
          const counts = await get<{ user_count: number; session_count: number }>(
            this.db,
            `SELECT (SELECT COUNT(*) FROM users WHERE org_id = ?) AS user_count,
                    (SELECT COUNT(*) FROM resolved_sessions WHERE org_id = ?) AS session_count`,
            [org.org_id, org.org_id],
          );
          const modelRows = await all<{
            model: string;
            input: number; output: number;
            cache_read: number; cache_write_5m: number; cache_write_1h: number;
          }>(
            this.db,
            `SELECT model,
                    SUM(input_tokens) AS input, SUM(output_tokens) AS output,
                    SUM(cache_read) AS cache_read, SUM(cache_write_5m) AS cache_write_5m,
                    SUM(cache_write_1h) AS cache_write_1h
             FROM resolved_usage WHERE org_id = ? GROUP BY model`,
            [org.org_id],
          );
          const byModel = modelRows.map((r) => ({
            model: r.model,
            input: r.input, output: r.output,
            cacheRead: r.cache_read, cacheWrite5m: r.cache_write_5m, cacheWrite1h: r.cache_write_1h,
          }));
          const totalTokens = byModel.reduce(
            (s, m) => s + m.input + m.output + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h, 0,
          );
          return {
            orgId: org.org_id,
            name: org.name,
            createdAt: org.created_at,
            userCount: counts?.user_count ?? 0,
            sessionCount: counts?.session_count ?? 0,
            totalTokens,
            byModel,
          };
        }),
      );
    });
  }

  /** The ID of the first org in the database (the Default org created on bootstrap). */
  getDefaultOrgId(): Promise<string | undefined> {
    return this.schedule(async () => {
      const row = await get<{ org_id: string }>(this.db, "SELECT org_id FROM organizations LIMIT 1");
      return row?.org_id;
    });
  }

  /** Display info for the user-detail header: display name + best-known email. */
  lookupUserDisplay(orgId: string, userId: string): Promise<{ displayName: string; email: string | null } | undefined> {
    return this.schedule(async () => {
      const row = await get<{ display_name: string; email: string | null }>(
        this.db,
        "SELECT display_name, email FROM users WHERE org_id = ? AND user_id = ?",
        [orgId, userId],
      );
      return row ? { displayName: row.display_name, email: row.email } : undefined;
    });
  }

  // ---- Targeted session reads (single-session detail) -----------------------------------

  async readHubSessionMeta(scope: HubScope, sessionId: string): Promise<SessionMeta | undefined> {
    const expanded = await this.expandScope(scope);
    if (expanded.empty) return undefined;
    return this.schedule(async () => {
      const cond = scopeWhereSql(expanded);
      const row = await get<{ meta_json: string }>(
        this.db,
        `SELECT meta_json FROM resolved_sessions WHERE ${cond} AND session_id = ? LIMIT 1`,
        [...scopeParams(expanded), sessionId],
      );
      return row ? (JSON.parse(row.meta_json) as SessionMeta) : undefined;
    });
  }

  async readHubSessionMessages(scope: HubScope, sessionId: string): Promise<MessageRecord[]> {
    const expanded = await this.expandScope(scope);
    if (expanded.empty) return [];
    return this.schedule(async () => {
      const cond = scopeWhereSql(expanded);
      const rows = await all<{ record_json: string }>(
        this.db,
        `SELECT record_json FROM resolved_usage WHERE ${cond} AND session_id = ? ORDER BY seq`,
        [...scopeParams(expanded), sessionId],
      );
      return rows.map((r) => JSON.parse(r.record_json) as MessageRecord);
    });
  }

  async readHubSessionTasks(scope: HubScope, sessionId: string): Promise<TaskFact[]> {
    const expanded = await this.expandScope(scope);
    if (expanded.empty) return [];
    return this.schedule(async () => {
      const cond = scopeWhereSql(expanded);
      const rows = await all<{ task_json: string }>(
        this.db,
        `SELECT task_json FROM resolved_tasks WHERE ${cond} AND session_id = ? ORDER BY ts IS NULL, ts, seq`,
        [...scopeParams(expanded), sessionId],
      );
      return rows.map((r) => JSON.parse(r.task_json) as TaskFact);
    });
  }

  /** Every extracted task across the scope, newest first, with the owning session's project
   *  attached. Backs the /tasks tab — a flat feed rather than a per-session drill-down. */
  async readTaskFacts(scope: HubScope, query?: ResolvedQuery): Promise<HubTaskRow[]> {
    const expanded = await this.expandScope(scope);
    if (expanded.empty) return [];
    return this.schedule(async () => {
      const conds = [scopeWhereSql(expanded, "t"), "s.archived = 0"];
      const params: unknown[] = [...scopeParams(expanded)];

      if (query?.sources?.length) {
        conds.push(`t.source IN (${query.sources.map(() => "?").join(", ")})`);
        params.push(...query.sources);
      }
      if (query?.projectSubstring) {
        conds.push("instr(s.cwd, ?) > 0");
        params.push(query.projectSubstring);
      }
      const dateConds: string[] = [];
      const dateParams: unknown[] = [];
      if (query?.since) { dateConds.push("m.date >= ?"); dateParams.push(query.since); }
      if (query?.until) { dateConds.push("m.date <= ?"); dateParams.push(query.until); }
      if (dateConds.length) {
        conds.push(
          `EXISTS (SELECT 1 FROM resolved_usage m WHERE m.org_id = s.org_id AND m.client_id = s.client_id AND m.session_id = s.session_id AND ${dateConds.join(" AND ")})`,
        );
        params.push(...dateParams);
      }

      const rows = await all<{
        task_json: string; project: string; session_id: string; user_id: string | null;
        display_name: string | null; disposition: string | null;
      }>(
        this.db,
        `SELECT t.task_json AS task_json, s.project AS project, t.session_id AS session_id,
                c.user_id AS user_id, u.display_name AS display_name, i.disposition AS disposition
         FROM resolved_tasks t
         JOIN resolved_sessions s ON s.org_id = t.org_id AND s.client_id = t.client_id AND s.session_id = t.session_id
         LEFT JOIN clients c ON c.client_id = t.client_id
         LEFT JOIN users u ON u.user_id = c.user_id
         LEFT JOIN (
           SELECT org_id, client_id, session_id, task_seq, disposition,
                  ROW_NUMBER() OVER (
                    PARTITION BY org_id, client_id, session_id, task_seq ORDER BY seq DESC
                  ) AS rn
           FROM resolved_interactions
           WHERE task_seq IS NOT NULL
         ) i
           ON i.org_id = t.org_id AND i.client_id = t.client_id AND i.session_id = t.session_id
              AND i.task_seq = t.seq AND i.rn = 1
         WHERE ${conds.join(" AND ")}
         ORDER BY t.ts IS NULL, t.ts DESC, t.seq DESC`,
        params,
      );
      return rows.map((r) => ({
        task: JSON.parse(r.task_json) as TaskFact,
        project: r.project,
        sessionId: r.session_id,
        userId: r.user_id,
        displayName: r.display_name,
        disposition: r.disposition,
      }));
    });
  }

  // ---- Activity report (GET /api/activity) -----------------------------------------------
  //
  // Sessions/tokens/users rolled up for a single window (current or the prior equal-length
  // window used for deltas). Tasks are read separately via readTaskFacts + classifyOutcome
  // (JS-side, so the same outcome-text heuristic backs both /api/tasks and this report).

  async readActivityTotals(scope: HubScope, query: ResolvedQuery): Promise<{ sessions: number; activeUsers: number; byModel: Array<{ model: string; usage: Usage }> }> {
    const expanded = await this.expandScope(scope);
    if (expanded.empty) return { sessions: 0, activeUsers: 0, byModel: [] };
    return this.schedule(async () => {
      const filters = buildHubFilters(expanded, query, {
        sourceColumn: "ru.source", dateColumn: "ru.date", cwdColumn: "ru.cwd", tableAlias: "ru",
      }, { excludeArchived: true });

      const countRow = await get<{ sessions: number; active_users: number }>(
        this.db,
        `SELECT COUNT(DISTINCT ru.client_id || ':' || ru.session_id) AS sessions,
                COUNT(DISTINCT c.user_id) AS active_users
         FROM resolved_usage ru LEFT JOIN clients c ON c.client_id = ru.client_id
         ${filters.messageWhere}`,
        filters.messageParams,
      );

      const modelRows = await all<{
        model: string | null; input: number | null; output: number | null;
        cache_read: number | null; cw5: number | null; cw1: number | null;
      }>(
        this.db,
        `SELECT model, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
                SUM(cache_read) AS cache_read, SUM(cache_write_5m) AS cw5, SUM(cache_write_1h) AS cw1
         FROM resolved_usage ru ${filters.messageWhere} GROUP BY model`,
        filters.messageParams,
      );

      return {
        sessions: countRow?.sessions ?? 0,
        activeUsers: countRow?.active_users ?? 0,
        byModel: modelRows.map((r) => ({
          model: r.model ?? "",
          usage: {
            input: r.input ?? 0, output: r.output ?? 0, cacheRead: r.cache_read ?? 0,
            cacheWrite5m: r.cw5 ?? 0, cacheWrite1h: r.cw1 ?? 0,
          },
        })),
      };
    });
  }

  async readActivityDaily(scope: HubScope, query: ResolvedQuery): Promise<Array<{ date: string; sessions: number; activeUsers: number; tokens: number }>> {
    const expanded = await this.expandScope(scope);
    if (expanded.empty) return [];
    return this.schedule(async () => {
      const filters = buildHubFilters(expanded, query, {
        sourceColumn: "ru.source", dateColumn: "ru.date", cwdColumn: "ru.cwd", tableAlias: "ru",
      }, { excludeArchived: true });
      const rows = await all<{ date: string; sessions: number; active_users: number; tokens: number | null }>(
        this.db,
        `SELECT ru.date AS date,
                COUNT(DISTINCT ru.client_id || ':' || ru.session_id) AS sessions,
                COUNT(DISTINCT c.user_id) AS active_users,
                SUM(COALESCE(ru.input_tokens,0) + COALESCE(ru.output_tokens,0) + COALESCE(ru.cache_read,0)
                    + COALESCE(ru.cache_write_5m,0) + COALESCE(ru.cache_write_1h,0)) AS tokens
         FROM resolved_usage ru LEFT JOIN clients c ON c.client_id = ru.client_id
         ${filters.messageWhere}
         GROUP BY ru.date`,
        filters.messageParams,
      );
      return rows.map((r) => ({ date: r.date, sessions: r.sessions, activeUsers: r.active_users, tokens: r.tokens ?? 0 }));
    });
  }

  async readActivityUserRollup(scope: HubScope, query: ResolvedQuery): Promise<
    Array<{
      userId: string;
      displayName: string;
      sessions: number;
      activeDays: number;
      lastActiveMs: number | null;
      lastSyncMs: number;
      byModel: Array<{ model: string; usage: Usage }>;
    }>
  > {
    const expanded = await this.expandScope(scope);
    if (expanded.empty) return [];
    return this.schedule(async () => {
      const filters = buildHubFilters(expanded, query, {
        sourceColumn: "ru.source", dateColumn: "ru.date", cwdColumn: "ru.cwd", tableAlias: "ru",
      }, { excludeArchived: true });
      const extra = filters.messageWhere ? `${filters.messageWhere} AND c.user_id IS NOT NULL` : "WHERE c.user_id IS NOT NULL";

      const rollupRows = await all<{
        user_id: string; display_name: string; sessions: number; active_days: number; last_active_ms: number | null;
      }>(
        this.db,
        `SELECT c.user_id AS user_id, u.display_name AS display_name,
                COUNT(DISTINCT ru.client_id || ':' || ru.session_id) AS sessions,
                COUNT(DISTINCT ru.date) AS active_days,
                MAX(ru.ts) AS last_active_ms
         FROM resolved_usage ru
         JOIN clients c ON c.client_id = ru.client_id
         JOIN users u ON u.user_id = c.user_id
         ${extra}
         GROUP BY c.user_id`,
        filters.messageParams,
      );
      if (!rollupRows.length) return [];

      const modelRows = await all<{
        user_id: string; model: string | null; input: number | null; output: number | null;
        cache_read: number | null; cw5: number | null; cw1: number | null;
      }>(
        this.db,
        `SELECT c.user_id AS user_id, ru.model AS model,
                SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read) AS cache_read,
                SUM(cache_write_5m) AS cw5, SUM(cache_write_1h) AS cw1
         FROM resolved_usage ru JOIN clients c ON c.client_id = ru.client_id
         ${extra} AND ru.model IS NOT NULL
         GROUP BY c.user_id, ru.model`,
        filters.messageParams,
      );
      const byModelByUser = new Map<string, Array<{ model: string; usage: Usage }>>();
      for (const r of modelRows) {
        const list = byModelByUser.get(r.user_id) ?? [];
        byModelByUser.set(r.user_id, list);
        list.push({
          model: r.model ?? "",
          usage: {
            input: r.input ?? 0, output: r.output ?? 0, cacheRead: r.cache_read ?? 0,
            cacheWrite5m: r.cw5 ?? 0, cacheWrite1h: r.cw1 ?? 0,
          },
        });
      }

      const syncRows = await all<{ user_id: string; last_sync_ms: number | null }>(
        this.db,
        `SELECT c.user_id AS user_id, MAX(cs.last_sync_ms) AS last_sync_ms
         FROM clients c LEFT JOIN client_syncs cs ON cs.client_id = c.client_id
         WHERE c.org_id = ? AND c.user_id IS NOT NULL GROUP BY c.user_id`,
        [expanded.orgId],
      );
      const lastSyncByUser = new Map(syncRows.map((r) => [r.user_id, r.last_sync_ms ?? 0]));

      return rollupRows.map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        sessions: r.sessions,
        activeDays: r.active_days,
        lastActiveMs: r.last_active_ms,
        lastSyncMs: lastSyncByUser.get(r.user_id) ?? 0,
        byModel: byModelByUser.get(r.user_id) ?? [],
      }));
    });
  }

  async readActivitySourceRollup(scope: HubScope, query: ResolvedQuery): Promise<
    Array<{ source: string; sessions: number; distinctUsers: number; byModel: Array<{ model: string; usage: Usage }> }>
  > {
    const expanded = await this.expandScope(scope);
    if (expanded.empty) return [];
    return this.schedule(async () => {
      const filters = buildHubFilters(expanded, query, {
        sourceColumn: "ru.source", dateColumn: "ru.date", cwdColumn: "ru.cwd", tableAlias: "ru",
      }, { excludeArchived: true });

      const countRows = await all<{ source: string; sessions: number; distinct_users: number }>(
        this.db,
        `SELECT ru.source AS source,
                COUNT(DISTINCT ru.client_id || ':' || ru.session_id) AS sessions,
                COUNT(DISTINCT c.user_id) AS distinct_users
         FROM resolved_usage ru LEFT JOIN clients c ON c.client_id = ru.client_id
         ${filters.messageWhere}
         GROUP BY ru.source`,
        filters.messageParams,
      );

      const modelRows = await all<{
        source: string; model: string | null; input: number | null; output: number | null;
        cache_read: number | null; cw5: number | null; cw1: number | null;
      }>(
        this.db,
        `SELECT ru.source AS source, ru.model AS model,
                SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read) AS cache_read,
                SUM(cache_write_5m) AS cw5, SUM(cache_write_1h) AS cw1
         FROM resolved_usage ru
         ${filters.messageWhere ? `${filters.messageWhere} AND ru.model IS NOT NULL` : "WHERE ru.model IS NOT NULL"}
         GROUP BY ru.source, ru.model`,
        filters.messageParams,
      );
      const byModelBySource = new Map<string, Array<{ model: string; usage: Usage }>>();
      for (const r of modelRows) {
        const list = byModelBySource.get(r.source) ?? [];
        byModelBySource.set(r.source, list);
        list.push({
          model: r.model ?? "",
          usage: {
            input: r.input ?? 0, output: r.output ?? 0, cacheRead: r.cache_read ?? 0,
            cacheWrite5m: r.cw5 ?? 0, cacheWrite1h: r.cw1 ?? 0,
          },
        });
      }

      return countRows.map((r) => ({
        source: r.source,
        sessions: r.sessions,
        distinctUsers: r.distinct_users,
        byModel: byModelBySource.get(r.source) ?? [],
      }));
    });
  }

  // ---- Task report friction rollup (GET /api/tasks/report) ------------------------------
  //
  // Session-level interruptions/rejections/compactions, summed over sessions active in the
  // window. Mirrors the friction half of readHealthRollups but public and without the
  // per-project breakdown / token-growth pass that dashboard reporting also needs.

  async readWindowFrictionRollup(scope: HubScope, query: ResolvedQuery): Promise<FrictionTotals> {
    const expanded = await this.expandScope(scope);
    if (expanded.empty) return emptyFrictionTotals();
    return this.schedule(async () => {
      const filters = buildHubFilters(expanded, query, {
        sourceColumn: "m.source", dateColumn: "m.date", cwdColumn: "m.cwd", tableAlias: "m",
      }, { excludeArchived: true });
      const sessions = await all<{
        org_id: string; client_id: string; session_id: string;
        fi: number | null; fr: number | null; fc: number | null; ft: number | null;
      }>(
        this.db,
        `SELECT m.org_id AS org_id, m.client_id AS client_id, m.session_id AS session_id,
                s.friction_interruptions AS fi, s.friction_rejections AS fr,
                s.friction_compactions AS fc, s.friction_turns AS ft
         FROM resolved_usage m JOIN resolved_sessions s
           ON s.org_id = m.org_id AND s.client_id = m.client_id AND s.session_id = m.session_id
         ${filters.messageWhere}
         GROUP BY m.org_id, m.client_id, m.session_id`,
        filters.messageParams,
      );
      const totals = emptyFrictionTotals();
      for (const row of sessions) {
        if (row.fi == null) continue;
        foldFriction(totals, { interruptions: row.fi, rejections: row.fr ?? 0, compactions: row.fc ?? 0, turns: row.ft ?? 0 });
      }
      return totals;
    });
  }

  // ---- Scope expansion ------------------------------------------------------------------

  /** Resolve a user-scoped or client-scoped HubScope into a concrete (org_id, clientIds[])
   *  bundle. Public reads call this once up front so SQL clauses can be assembled outside
   *  the scheduled work item (avoids nested schedule()). */
  private async expandScope(scope: HubScope): Promise<ExpandedScope> {
    if (scope.clientId) {
      return { orgId: scope.orgId, clientIds: [scope.clientId], empty: false };
    }
    if (scope.userId) {
      return this.schedule(async () => {
        const ids = await this.clientIdsForUser(scope.orgId, scope.userId!);
        return { orgId: scope.orgId, clientIds: ids, empty: ids.length === 0 };
      });
    }
    return { orgId: scope.orgId, clientIds: null, empty: false };
  }

  // ---- Close ----------------------------------------------------------------------------

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return this.queue.then(() => closeDatabase(this.db), () => closeDatabase(this.db));
  }
}

// ---- Scope helpers ----------------------------------------------------------------------

interface ExpandedScope {
  orgId: string;
  /** null = "no client filter" (org-wide). [] = "user has no clients" → empty result set. */
  clientIds: string[] | null;
  /** Set when the user resolves to zero clients — callers short-circuit before querying. */
  empty: boolean;
}

function scopeWhereSql(scope: ExpandedScope, tableAlias = ""): string {
  const col = (name: string) => (tableAlias ? `${tableAlias}.${name}` : name);
  if (scope.clientIds === null) return `${col("org_id")} = ?`;
  if (scope.clientIds.length === 0) return `${col("org_id")} = ? AND 1 = 0`;
  const placeholders = scope.clientIds.map(() => "?").join(", ");
  return `${col("org_id")} = ? AND ${col("client_id")} IN (${placeholders})`;
}

function scopeParams(scope: ExpandedScope): unknown[] {
  if (scope.clientIds === null) return [scope.orgId];
  return [scope.orgId, ...scope.clientIds];
}

// ---- Query filter builder ---------------------------------------------------------------

interface HubFilterColumns {
  sourceColumn?: string;
  dateColumn?: string;
  cwdColumn?: string | null;
  tableAlias?: string;
}

/** Builds WHERE / param arrays for hub queries, prepending scope (org_id [+ client_id IN ...])
 *  before the content filters (source / date / project). */
function buildHubFilters(
  scope: ExpandedScope,
  query?: ResolvedQuery,
  columns: HubFilterColumns = {},
  opts: { excludeArchived?: boolean } = {},
): {
  messageWhere: string;
  messageParams: unknown[];
  scopeAndSource: string;
  scopeAndSourceParams: unknown[];
  active: boolean;
} {
  const sourceColumn = columns.sourceColumn ?? "source";
  const dateColumn = columns.dateColumn ?? "date";
  const cwdColumn = columns.cwdColumn === undefined ? "cwd" : columns.cwdColumn;
  const alias = columns.tableAlias ?? "";
  const qualify = alias ? `${alias}.` : "";

  const scopeW = scopeWhereSql(scope, alias);
  const scopeP = scopeParams(scope);

  const conditions: string[] = [scopeW];
  const params: unknown[] = [...scopeP];

  if (opts.excludeArchived) {
    const notArchived =
      `EXISTS (SELECT 1 FROM resolved_sessions __ars ` +
      `WHERE __ars.org_id = ${qualify}org_id ` +
      `AND __ars.client_id = ${qualify}client_id ` +
      `AND __ars.session_id = ${qualify}session_id ` +
      `AND __ars.archived = 0)`;
    conditions.push(notArchived);
  }

  const sourceConditions: string[] = [...conditions];
  const sourceParams: unknown[] = [...params];

  if (query?.sources?.length) {
    const clause = `${sourceColumn} IN (${query.sources.map(() => "?").join(", ")})`;
    conditions.push(clause);
    sourceConditions.push(clause);
    params.push(...query.sources);
    sourceParams.push(...query.sources);
  }

  const contentConditions: string[] = [];
  const contentParams: unknown[] = [];
  if (query?.since) { contentConditions.push(`${dateColumn} >= ?`); contentParams.push(query.since); }
  if (query?.until) { contentConditions.push(`${dateColumn} <= ?`); contentParams.push(query.until); }
  if (query?.projectSubstring && cwdColumn) {
    contentConditions.push(`instr(${cwdColumn}, ?) > 0`);
    contentParams.push(query.projectSubstring);
  }

  const allConditions = [...conditions, ...contentConditions];
  const allParams = [...params, ...contentParams];

  return {
    messageWhere: allConditions.length ? `WHERE ${allConditions.join(" AND ")}` : "",
    messageParams: allParams,
    scopeAndSource: sourceConditions.join(" AND "),
    scopeAndSourceParams: sourceParams,
    active: contentConditions.length > 0,
  };
}

// ---- Validators -------------------------------------------------------------------------

const CLIENT_ID_RE = /^client-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertClientId(clientId: string): void {
  if (!CLIENT_ID_RE.test(clientId)) {
    throw new Error(`Invalid client id: ${clientId}`);
  }
}
