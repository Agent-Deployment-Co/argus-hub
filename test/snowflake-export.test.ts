import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sqlite3 from "sqlite3";
import { openHubStore } from "../src/store/hub-store.ts";
import {
  buildSnowflakeLoadPlan,
  loadSnowflakeBundle,
  SNOWFLAKE_EXPORT_TABLES,
  writeSnowflakeBundle,
  type SnowflakeBundle,
  type SqlExecutor,
} from "../src/export/snowflake.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-snowflake-test-"));
  tempDirs.push(dir);
  return dir;
}

function openRaw(path: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, (error) => error ? reject(error) : resolve(db));
  });
}

function get<T>(db: sqlite3.Database, sql: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get<T>(sql, (error, row) => error ? reject(error) : resolve(row));
  });
}

function run(db: sqlite3.Database, sql: string, params: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => error ? reject(error) : resolve());
  });
}

function close(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error) => error ? reject(error) : resolve());
  });
}

async function seedSession(dbPath: string): Promise<void> {
  const db = await openRaw(dbPath);
  try {
    const org = await get<{ org_id: string }>(db, "SELECT org_id FROM organizations LIMIT 1");
    const orgId = org!.org_id;
    await run(db, "INSERT INTO users(user_id, org_id, display_name, email, created_at) VALUES (?, ?, ?, ?, ?)", [
      "user-1", orgId, "Ada", "ada@example.com", 1_000,
    ]);
    await run(
      db,
      "INSERT INTO clients(client_id, org_id, first_seen_ms, last_seen_ms, user_id, user_pinned) VALUES (?, ?, ?, ?, ?, ?)",
      ["client-1", orgId, 1_000, 2_000, "user-1", 0],
    );
    await run(
      db,
      `INSERT INTO resolved_sessions(
        org_id, client_id, session_id, source, project, cwd, first_ts, last_ts,
        message_count, first_prompt, archived, meta_json, title, summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orgId, "client-1", "session-1", "claude", "argus", "/repo", 1_000, 2_000, 2, "hello", 0,
        JSON.stringify({ source: "claude", nested: { ok: true } }), "Example", null],
    );
  } finally {
    await close(db);
  }
}

describe("Snowflake snapshot export", () => {
  test("writes all reporting tables, parses JSON columns, and excludes API key hashes", async () => {
    const root = tempDir();
    const dataDir = join(root, "data");
    const store = await openHubStore(dataDir, 1_000);
    await store.close();
    await seedSession(join(dataDir, "hub.db"));
    const liveStore = await openHubStore(dataDir, 2_000);
    const orgId = await liveStore.getDefaultOrgId();
    await liveStore.createGroup(orgId!, "Platform", 2_000); // leave a committed write in the live WAL

    const bundle = await writeSnowflakeBundle({
      dbPath: join(dataDir, "hub.db"),
      outputDir: join(root, "snapshot"),
      target: { database: "ANALYTICS", schema: "ARGUS_HUB" },
      now: new Date("2026-07-21T12:00:00.000Z"),
    });
    await liveStore.close();

    expect(bundle.manifest.rowCounts.resolved_sessions).toBe(1);
    expect(bundle.manifest.rowCounts.groups).toBe(1);
    expect(bundle.manifest.excludedTables).toEqual(["api_keys"]);
    for (const table of SNOWFLAKE_EXPORT_TABLES) {
      expect(existsSync(join(bundle.outputDir, `${table.name}.jsonl`))).toBe(true);
    }
    expect(existsSync(join(bundle.outputDir, "api_keys.jsonl"))).toBe(false);

    const row = JSON.parse(readFileSync(join(bundle.outputDir, "resolved_sessions.jsonl"), "utf8")) as Record<string, unknown>;
    expect(row.meta_json).toEqual({ source: "claude", nested: { ok: true } });
    expect(row.summary).toBeNull();

    const loadSql = readFileSync(join(bundle.outputDir, "load.sql"), "utf8");
    expect(loadSql).toContain('CREATE TABLE IF NOT EXISTS "ANALYTICS"."ARGUS_HUB"."RESOLVED_SESSIONS"');
    expect(loadSql).toContain('@"ANALYTICS"."ARGUS_HUB".%"ARGUS_LOAD_');
    expect(loadSql).not.toContain("API_KEYS");
  });

  test("refuses to overwrite an existing output directory", async () => {
    const root = tempDir();
    const dataDir = join(root, "data");
    const store = await openHubStore(dataDir, 1_000);
    await store.close();
    const outputDir = join(root, "already-there");
    mkdirSync(outputDir);

    expect(writeSnowflakeBundle({ dbPath: join(dataDir, "hub.db"), outputDir })).rejects.toThrow(
      "Output directory already exists",
    );
  });
});

function fakeBundle(root: string): SnowflakeBundle {
  const rowCounts = Object.fromEntries(SNOWFLAKE_EXPORT_TABLES.map((table) => [table.name, table.name === "organizations" ? 1 : 0]));
  return {
    outputDir: root,
    target: { database: "ANALYTICS", schema: "Argus Hub" },
    manifest: {
      formatVersion: 1,
      hubSchemaVersion: 3,
      exportedAt: "2026-07-21T12:00:00.000Z",
      exportId: "20260721120000000_abcd1234",
      rowCounts,
      excludedTables: ["api_keys"],
    },
  };
}

describe("Snowflake connector", () => {
  test("quotes identifiers and only uploads non-empty table files", () => {
    const plan = buildSnowflakeLoadPlan(fakeBundle("/tmp/argus export"));
    const puts = plan.setup.filter((sql) => sql.startsWith("PUT "));
    expect(puts).toHaveLength(1);
    expect(puts[0]).toContain('@"ANALYTICS"."Argus Hub".%"ARGUS_LOAD_');
    expect(puts[0]).toContain("file:///tmp/argus%20export/organizations.jsonl");
    expect(plan.replace.filter((sql) => sql.startsWith("DELETE FROM"))).toHaveLength(SNOWFLAKE_EXPORT_TABLES.length);
  });

  test("rolls back a failed replacement and always cleans up the connection", async () => {
    const statements: string[] = [];
    let closed = false;
    const executor: SqlExecutor = {
      async execute(sql) {
        statements.push(sql);
        if (sql.startsWith('INSERT INTO "ANALYTICS"."Argus Hub"."ORGANIZATIONS"')) {
          throw new Error("insert failed");
        }
      },
      async close() { closed = true; },
    };
    const config = {
      account: "acct",
      username: "loader",
      database: "ANALYTICS",
      schema: "Argus Hub",
      warehouse: "LOAD_WH",
    };

    expect(loadSnowflakeBundle(fakeBundle(tempDir()), config, async () => executor)).rejects.toThrow("insert failed");
    expect(statements).toContain("BEGIN");
    expect(statements).toContain("ROLLBACK");
    expect(statements.some((sql) => sql.startsWith("DROP TABLE IF EXISTS"))).toBe(true);
    expect(closed).toBe(true);
  });

  test("commits a successful replacement", async () => {
    const statements: string[] = [];
    let closed = false;
    const executor: SqlExecutor = {
      async execute(sql) { statements.push(sql); },
      async close() { closed = true; },
    };
    const config = {
      account: "acct",
      username: "loader",
      database: "ANALYTICS",
      schema: "Argus Hub",
      warehouse: "LOAD_WH",
    };

    await loadSnowflakeBundle(fakeBundle(tempDir()), config, async () => executor);
    expect(statements).toContain("BEGIN");
    expect(statements).toContain("COMMIT");
    expect(statements).not.toContain("ROLLBACK");
    expect(closed).toBe(true);
  });
});
