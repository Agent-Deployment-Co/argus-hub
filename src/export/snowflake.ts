import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { finished } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import sqlite3, { type Database } from "sqlite3";
import { HUB_APPLICATION_ID, HUB_SCHEMA_VERSION } from "../store/hub-store.ts";
import { createZipReadable } from "./zip.ts";
import type { ConnectionOptions } from "snowflake-sdk";

interface ExportColumn {
  name: string;
  snowflakeType: string;
  json?: boolean;
}

interface ExportTable {
  name: string;
  columns: readonly ExportColumn[];
}

const text = (name: string): ExportColumn => ({ name, snowflakeType: "VARCHAR" });
const number = (name: string): ExportColumn => ({ name, snowflakeType: "NUMBER(38, 0)" });
const variant = (name: string): ExportColumn => ({ name, snowflakeType: "VARIANT", json: true });

/**
 * Public reporting data exported from Hub. api_keys is intentionally omitted: a Snowflake
 * reporting role never needs even the hashes of Hub ingestion credentials.
 */
export const SNOWFLAKE_EXPORT_TABLES: readonly ExportTable[] = [
  { name: "organizations", columns: [text("org_id"), text("name"), number("created_at")] },
  { name: "groups", columns: [text("group_id"), text("org_id"), text("name"), number("created_at")] },
  {
    name: "users",
    columns: [text("user_id"), text("org_id"), text("display_name"), text("email"), number("created_at"), text("group_id")],
  },
  {
    name: "clients",
    columns: [text("client_id"), text("org_id"), number("first_seen_ms"), number("last_seen_ms"), text("user_id"), number("user_pinned")],
  },
  { name: "client_fingerprint", columns: [text("client_id"), text("key"), text("value"), number("ts_ms")] },
  { name: "client_syncs", columns: [text("org_id"), text("client_id"), number("last_sync_ms")] },
  {
    name: "resolved_sessions",
    columns: [
      text("org_id"), text("client_id"), text("session_id"), text("source"), text("project"), text("cwd"),
      number("first_ts"), number("last_ts"), number("message_count"), text("first_prompt"), number("archived"),
      number("friction_interruptions"), number("friction_rejections"), number("friction_compactions"),
      number("friction_turns"), number("last_interruption_ms"), variant("meta_json"), text("title"), text("summary"),
    ],
  },
  {
    name: "resolved_usage",
    columns: [
      text("org_id"), text("client_id"), text("session_id"), number("seq"), text("source"), number("ts"), text("date"),
      text("cwd"), text("project"), variant("record_json"), number("input_tokens"), number("output_tokens"),
      number("cache_read"), number("cache_write_5m"), number("cache_write_1h"), text("model"),
      text("attribution_skill"), text("stop_reason"), number("interaction_seq"),
    ],
  },
  {
    name: "resolved_tasks",
    columns: [text("org_id"), text("client_id"), text("session_id"), number("seq"), text("source"), number("ts"), variant("task_json")],
  },
  {
    name: "resolved_interactions",
    columns: [
      text("org_id"), text("client_id"), text("session_id"), number("seq"), text("source"), number("ts"),
      text("initiator"), text("disposition"), number("compaction_count"), number("task_seq"), variant("interaction_json"),
    ],
  },
  {
    name: "resolved_invocations",
    columns: [
      text("org_id"), text("client_id"), text("session_id"), number("seq"), text("source"), number("interaction_seq"),
      text("tool"), text("category"), text("mcp_server"), text("mcp_tool"), text("skill"), text("file_path"),
      text("date"), text("cwd"), text("args"), number("approx_result_tokens"),
    ],
  },
  {
    name: "resolved_session_labels",
    columns: [
      text("org_id"), text("client_id"), text("session_id"), text("name"), text("origin"), text("applied_by"),
      text("target_kind"), number("task_seq"), number("applied_at_ms"),
    ],
  },
] as const;

export interface SnowflakeTarget {
  database?: string;
  schema: string;
}

export interface SnowflakeBundleManifest {
  formatVersion: 1;
  hubSchemaVersion: number;
  exportedAt: string;
  exportId: string;
  rowCounts: Record<string, number>;
  excludedTables: ["api_keys"];
}

export interface SnowflakeBundle {
  outputDir: string;
  manifest: SnowflakeBundleManifest;
  target: SnowflakeTarget;
}

function openReadOnly(path: string): Promise<Database> {
  return new Promise((resolvePromise, reject) => {
    const db = new sqlite3.Database(path, sqlite3.OPEN_READONLY | sqlite3.OPEN_FULLMUTEX, (error) => {
      if (error) reject(error);
      else {
        db.configure("busyTimeout", 5_000);
        resolvePromise(db);
      }
    });
  });
}

function dbExec(db: Database, sql: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    db.exec(sql, (error) => error ? reject(error) : resolvePromise());
  });
}

function dbGet<T>(db: Database, sql: string): Promise<T | undefined> {
  return new Promise((resolvePromise, reject) => {
    db.get<T>(sql, (error, row) => error ? reject(error) : resolvePromise(row));
  });
}

function dbAll<T>(db: Database, sql: string, params: unknown[]): Promise<T[]> {
  return new Promise((resolvePromise, reject) => {
    db.all<T>(sql, params, (error, rows) => error ? reject(error) : resolvePromise(rows));
  });
}

function closeDatabase(db: Database): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    db.close((error) => error ? reject(error) : resolvePromise());
  });
}

async function createPrivateOutputDirectory(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(`Output directory already exists: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

function normalizeRow(row: Record<string, unknown>, table: ExportTable): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const column of table.columns) {
    const value = row[column.name];
    if (column.json && typeof value === "string") {
      try {
        normalized[column.name] = JSON.parse(value) as unknown;
      } catch {
        normalized[column.name] = value;
      }
    } else {
      normalized[column.name] = value ?? null;
    }
  }
  return normalized;
}

async function dumpTable(db: Database, table: ExportTable, path: string): Promise<number> {
  const stream = createWriteStream(path, { flags: "wx", mode: 0o600, encoding: "utf8" });
  const columns = table.columns.map((column) => `"${column.name}"`).join(", ");
  let lastRowId = 0;
  let count = 0;
  try {
    while (true) {
      const rows = await dbAll<Record<string, unknown> & { __rowid: number }>(
        db,
        `SELECT rowid AS __rowid, ${columns} FROM "${table.name}" WHERE rowid > ? ORDER BY rowid LIMIT 1000`,
        [lastRowId],
      );
      if (!rows.length) break;
      for (const row of rows) {
        lastRowId = row.__rowid;
        const line = `${JSON.stringify(normalizeRow(row, table))}\n`;
        if (!stream.write(line)) await new Promise<void>((resolvePromise) => stream.once("drain", resolvePromise));
        count++;
      }
    }
    stream.end();
    await finished(stream);
    return count;
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

function quoteIdentifier(identifier: string): string {
  if (!identifier.trim()) throw new Error("Snowflake identifiers cannot be empty");
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function qualifiedSchema(target: SnowflakeTarget): string {
  const schema = quoteIdentifier(target.schema);
  return target.database ? `${quoteIdentifier(target.database)}.${schema}` : schema;
}

function tableRef(target: SnowflakeTarget, table: ExportTable): string {
  return `${qualifiedSchema(target)}.${quoteIdentifier(table.name.toUpperCase())}`;
}

function stageTableName(exportId: string, table: ExportTable): string {
  return quoteIdentifier(`ARGUS_LOAD_${exportId}_${table.name}`.toUpperCase());
}

export interface SnowflakeLoadPlan {
  setup: string[];
  replace: string[];
  cleanup: string[];
}

/** Build the same SQL plan used by both load.sql and the built-in connector. */
export function buildSnowflakeLoadPlan(bundle: SnowflakeBundle): SnowflakeLoadPlan {
  const schema = qualifiedSchema(bundle.target);
  const setup: string[] = [];
  const replace: string[] = [];
  const cleanup: string[] = [];

  for (const table of SNOWFLAKE_EXPORT_TABLES) {
    const target = tableRef(bundle.target, table);
    const stagingName = stageTableName(bundle.manifest.exportId, table);
    const staging = `${schema}.${stagingName}`;
    const stagingTableStage = `@${schema}.%${stagingName}`;
    const definitions = table.columns
      .map((column) => `${quoteIdentifier(column.name.toUpperCase())} ${column.snowflakeType}`)
      .join(", ");
    const columnList = table.columns.map((column) => quoteIdentifier(column.name.toUpperCase())).join(", ");
    const fileUrl = pathToFileURL(join(bundle.outputDir, `${table.name}.jsonl`)).href;

    setup.push(`CREATE TABLE IF NOT EXISTS ${target} (${definitions})`);
    for (const column of table.columns) {
      setup.push(`ALTER TABLE ${target} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(column.name.toUpperCase())} ${column.snowflakeType}`);
    }
    setup.push(`CREATE OR REPLACE TEMPORARY TABLE ${staging} LIKE ${target}`);
    if ((bundle.manifest.rowCounts[table.name] ?? 0) > 0) {
      setup.push(`PUT ${quoteString(fileUrl)} ${stagingTableStage} AUTO_COMPRESS=TRUE OVERWRITE=TRUE`);
      setup.push(
        `COPY INTO ${staging} FROM ${stagingTableStage} FILE_FORMAT=(TYPE=JSON) ` +
        `MATCH_BY_COLUMN_NAME=CASE_INSENSITIVE ON_ERROR='ABORT_STATEMENT' PURGE=TRUE FORCE=TRUE`,
      );
    }

    replace.push(`DELETE FROM ${target}`);
    replace.push(`INSERT INTO ${target} (${columnList}) SELECT ${columnList} FROM ${staging}`);
    cleanup.push(`DROP TABLE IF EXISTS ${staging}`);
  }

  return { setup, replace, cleanup };
}

function renderLoadSql(bundle: SnowflakeBundle): string {
  const plan = buildSnowflakeLoadPlan(bundle);
  return [
    "-- Generated by argus-hub export snowflake.",
    "-- Run this file in one Snowflake CLI/SnowSQL session from the machine containing these JSONL files.",
    ...plan.setup.map((sql) => `${sql};`),
    "BEGIN;",
    ...plan.replace.map((sql) => `${sql};`),
    "COMMIT;",
    ...plan.cleanup.map((sql) => `${sql};`),
    "",
  ].join("\n");
}

export interface WriteSnowflakeBundleOptions {
  dbPath: string;
  outputDir: string;
  target?: SnowflakeTarget;
  now?: Date;
}

/** Export a transactionally consistent snapshot of the live SQLite/WAL store to JSONL. */
export async function writeSnowflakeBundle(options: WriteSnowflakeBundleOptions): Promise<SnowflakeBundle> {
  const outputDir = resolve(options.outputDir);
  await createPrivateOutputDirectory(outputDir);
  const db = await openReadOnly(resolve(options.dbPath)).catch(async (error) => {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  });
  let transactionOpen = false;
  try {
    await dbExec(db, "PRAGMA query_only = ON; BEGIN");
    transactionOpen = true;
    const appId = await dbGet<{ application_id: number }>(db, "PRAGMA application_id");
    const version = await dbGet<{ user_version: number }>(db, "PRAGMA user_version");
    if (appId?.application_id !== HUB_APPLICATION_ID) {
      throw new Error(`${options.dbPath} is not an Argus Hub store.`);
    }
    if (version?.user_version !== HUB_SCHEMA_VERSION) {
      throw new Error(
        `Hub store at ${options.dbPath} is schema v${version?.user_version ?? 0}; ` +
        `this exporter requires v${HUB_SCHEMA_VERSION}. Start the current Hub build once to migrate it.`,
      );
    }

    const rowCounts: Record<string, number> = {};
    for (const table of SNOWFLAKE_EXPORT_TABLES) {
      rowCounts[table.name] = await dumpTable(db, table, join(outputDir, `${table.name}.jsonl`));
    }
    await dbExec(db, "COMMIT");
    transactionOpen = false;

    const now = options.now ?? new Date();
    const manifest: SnowflakeBundleManifest = {
      formatVersion: 1,
      hubSchemaVersion: HUB_SCHEMA_VERSION,
      exportedAt: now.toISOString(),
      exportId: `${now.toISOString().replace(/[^0-9]/g, "").slice(0, 17)}_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      rowCounts,
      excludedTables: ["api_keys"],
    };
    const bundle: SnowflakeBundle = {
      outputDir,
      manifest,
      target: options.target ?? { schema: "ARGUS_HUB" },
    };
    await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(outputDir, "load.sql"), renderLoadSql(bundle), { mode: 0o600 });
    return bundle;
  } catch (error) {
    if (transactionOpen) await dbExec(db, "ROLLBACK").catch(() => undefined);
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  } finally {
    await closeDatabase(db);
  }
}

export interface SnowflakeZipStream {
  /** Web ReadableStream of the .zip bytes, suitable as an HTTP Response body. */
  stream: ReadableStream<Uint8Array>;
  manifest: SnowflakeBundleManifest;
}

/** Stream the full Snowflake export bundle as a .zip. Writes the bundle to a private temp directory
 *  (reusing writeSnowflakeBundle for the transactionally consistent snapshot), then returns a
 *  ReadableStream that deflates each file on the fly. The temp directory is removed when the stream
 *  finishes, errors, or is cancelled — so nothing but one file's buffers is ever held in memory. */
export async function openSnowflakeZipStream(
  options: { dbPath: string; target?: SnowflakeTarget; now?: Date },
): Promise<SnowflakeZipStream> {
  const outputDir = join(tmpdir(), `argus-hub-export-${randomUUID()}`);
  let manifest: SnowflakeBundleManifest;
  let names: string[];
  try {
    const bundle = await writeSnowflakeBundle({ dbPath: options.dbPath, outputDir, target: options.target, now: options.now });
    manifest = bundle.manifest;
    names = (await readdir(outputDir)).sort();
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }

  const files = names.map((name) => ({ name, path: join(outputDir, name) }));
  const readable = createZipReadable(files, {
    now: options.now,
    onClose: () => rm(outputDir, { recursive: true, force: true }),
  });
  return { stream: Readable.toWeb(readable) as unknown as ReadableStream<Uint8Array>, manifest };
}

export interface SnowflakeConnectionConfig extends SnowflakeTarget {
  account: string;
  username: string;
  warehouse: string;
  role?: string;
  authenticator?: string;
  password?: string;
  token?: string;
  privateKeyPath?: string;
  privateKeyPass?: string;
}

export interface SqlExecutor {
  execute(sql: string): Promise<void>;
  close(): Promise<void>;
}

async function connectSnowflake(config: SnowflakeConnectionConfig): Promise<SqlExecutor> {
  const snowflake = await import("snowflake-sdk");
  const connectionOptions: ConnectionOptions = {
    account: config.account,
    username: config.username,
    warehouse: config.warehouse,
    database: config.database,
    schema: config.schema,
    role: config.role,
    authenticator: config.authenticator,
    password: config.password,
    token: config.token,
    privateKeyPath: config.privateKeyPath,
    privateKeyPass: config.privateKeyPass,
    application: "ARGUS_HUB_EXPORT",
  };
  const connection = snowflake.createConnection(connectionOptions);
  await new Promise<void>((resolvePromise, reject) => {
    connection.connect((error) => error ? reject(error) : resolvePromise());
  });
  return {
    execute(sql: string): Promise<void> {
      return new Promise((resolvePromise, reject) => {
        connection.execute({ sqlText: sql, complete: (error) => error ? reject(error) : resolvePromise() });
      });
    },
    close(): Promise<void> {
      return new Promise((resolvePromise, reject) => {
        connection.destroy((error) => error ? reject(error) : resolvePromise());
      });
    },
  };
}

/** Load a bundle through Snowflake's Node driver, replacing all target tables atomically. */
export async function loadSnowflakeBundle(
  bundle: SnowflakeBundle,
  config: SnowflakeConnectionConfig,
  executorFactory: (config: SnowflakeConnectionConfig) => Promise<SqlExecutor> = connectSnowflake,
): Promise<void> {
  const executor = await executorFactory(config);
  const plan = buildSnowflakeLoadPlan({ ...bundle, target: config });
  let transactionOpen = false;
  try {
    for (const sql of plan.setup) await executor.execute(sql);
    await executor.execute("BEGIN");
    transactionOpen = true;
    for (const sql of plan.replace) await executor.execute(sql);
    await executor.execute("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await executor.execute("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    for (const sql of plan.cleanup) await executor.execute(sql).catch(() => undefined);
    await executor.close();
  }
}
