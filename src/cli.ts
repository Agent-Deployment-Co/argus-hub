#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { openHubStore } from "./store/hub-store.ts";
import { startHubServer } from "./api/serve.ts";
import { createAdminAuth } from "./admin-auth.ts";
import { VERSION } from "./version.ts";
import { randomUUID } from "node:crypto";
import { createSecretCipher, parseHubSecretKey } from "./secrets.ts";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadSnowflakeBundle,
  writeSnowflakeBundle,
  type SnowflakeConnectionConfig,
} from "./export/snowflake.ts";

const serve = defineCommand({
  meta: { name: "serve", description: "Start the Hub server" },
  args: {
    port: {
      type: "string",
      description: "Port to listen on",
      default: process.env.HUB_PORT ?? "4343",
    },
    bind: {
      type: "string",
      description:
        "Address to bind to, e.g. 127.0.0.1 to listen on loopback only (env HUB_BIND). Default: all interfaces",
      default: process.env.HUB_BIND,
    },
    "data-dir": {
      type: "string",
      description: "Directory for hub.db",
      default: process.env.HUB_DATA_DIR ?? "./data",
    },
    "read-only": {
      type: "boolean",
      description: "Read-only mode: disables all writes and hides editing UI (env HUB_READ_ONLY)",
      default: process.env.HUB_READ_ONLY === "true",
    },
    // These are boolean flags in their *positive* form (default true), toggled off with
    // citty's built-in `--no-<name>` negation — citty's parser treats any `--no-X` argument as
    // setting `X` to false before option resolution even runs, so a flag actually *named*
    // `no-password` (etc.) can never be set from the command line: `--no-password` would just
    // set a nonexistent `password` key to false and leave `no-password` untouched.
    password: {
      type: "boolean",
      description: "Require the admin password (disable with --no-password: every route is open, no login/logout; env HUB_NO_PASSWORD)",
      default: process.env.HUB_NO_PASSWORD !== "true",
    },
    mcp: {
      type: "boolean",
      description: "Mount the MCP server (disable with --no-mcp: /mcp is not mounted; env HUB_NO_MCP)",
      default: process.env.HUB_NO_MCP !== "true",
    },
    export: {
      type: "boolean",
      description: "Mount the dataset export surface (disable with --no-export: /api/export is not mounted and the Export nav item is hidden; env HUB_NO_EXPORT)",
      default: process.env.HUB_NO_EXPORT !== "true",
    },
  },
  async run({ args }) {
    const secretKey = parseHubSecretKey(process.env.HUB_SECRET_KEY);
    const secretCipher = secretKey ? createSecretCipher(secretKey) : undefined;
    if (!secretCipher) {
      process.stderr.write(
        "Warning: HUB_SECRET_KEY is not set. API-key-based LLM providers are disabled.\n",
      );
    }
    const port = Number(args.port);
    const insecureCookieHosts = process.env.HUB_INSECURE_COOKIE_HOSTS
      ?.split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    const noPassword = !args.password;
    const auth = noPassword ? undefined : createAdminAuth(process.env.ADMIN_PASSWORD, insecureCookieHosts);
    const store = await openHubStore(args["data-dir"]);

    if (noPassword) {
      process.stderr.write(
        "WARNING: --no-password is set. The Hub is running with no login required — anyone who can " +
          "reach this server can view and change all data. Only use this on a network you trust.\n",
      );
    } else if (!process.env.ADMIN_PASSWORD) {
      process.stdout.write(`Admin password: ${auth!.password}\n`);
    }

    const ac = new AbortController();
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => ac.abort());
    }

    await startHubServer({
      port,
      hostname: args.bind || undefined,
      store,
      auth,
      secretCipher,
      readOnly: args["read-only"],
      noMcp: !args.mcp,
      noExport: !args.export,
      signal: ac.signal,
    });
    store.close();
  },
});

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required with --load`);
  return value;
}

const exportSnowflake = defineCommand({
  meta: { name: "snowflake", description: "Export hub.db to Snowflake-ready JSONL, optionally loading it" },
  args: {
    "data-dir": {
      type: "string",
      description: "Directory containing hub.db",
      default: process.env.HUB_DATA_DIR ?? "./data",
    },
    "output-dir": {
      type: "string",
      description: "New directory for JSONL, manifest.json, and load.sql (files are temporary with --load if omitted)",
    },
    load: {
      type: "boolean",
      description: "Upload the snapshot and atomically replace the target Snowflake tables",
      default: false,
    },
    account: {
      type: "string",
      description: "Snowflake account identifier (or SNOWFLAKE_ACCOUNT)",
    },
    username: {
      type: "string",
      description: "Snowflake user (or SNOWFLAKE_USER)",
    },
    database: {
      type: "string",
      description: "Snowflake database (or SNOWFLAKE_DATABASE; required with --load)",
    },
    schema: {
      type: "string",
      description: "Snowflake schema",
      default: process.env.SNOWFLAKE_SCHEMA ?? "ARGUS_HUB",
    },
    warehouse: {
      type: "string",
      description: "Snowflake warehouse (or SNOWFLAKE_WAREHOUSE; required with --load)",
    },
    role: {
      type: "string",
      description: "Snowflake role (or SNOWFLAKE_ROLE)",
    },
    authenticator: {
      type: "string",
      description: "SNOWFLAKE, SNOWFLAKE_JWT, EXTERNALBROWSER, or PROGRAMMATIC_ACCESS_TOKEN",
    },
    "private-key-path": {
      type: "string",
      description: "PKCS #8 key path for SNOWFLAKE_JWT (or SNOWFLAKE_PRIVATE_KEY_PATH)",
    },
  },
  async run({ args }) {
    const explicitOutputDir = args["output-dir"];
    const outputDir = explicitOutputDir
      ? resolve(explicitOutputDir)
      : args.load
        ? join(tmpdir(), `argus-hub-snowflake-${randomUUID()}`)
        : resolve(`argus-hub-snowflake-${new Date().toISOString().replace(/[:.]/g, "-")}`);

    const database = args.database ?? process.env.SNOWFLAKE_DATABASE;
    const target = { database, schema: args.schema };
    const bundle = await writeSnowflakeBundle({
      dbPath: join(resolve(args["data-dir"]), "hub.db"),
      outputDir,
      target,
    });
    const totalRows = Object.values(bundle.manifest.rowCounts).reduce((sum, count) => sum + count, 0);

    try {
      if (!args.load) {
        process.stdout.write(`Exported ${totalRows} rows to ${bundle.outputDir}\n`);
        process.stdout.write(`Run ${join(bundle.outputDir, "load.sql")} in Snowflake to load the snapshot.\n`);
        return;
      }

      const privateKeyPath = args["private-key-path"] ?? process.env.SNOWFLAKE_PRIVATE_KEY_PATH;
      const authenticator = args.authenticator ?? process.env.SNOWFLAKE_AUTHENTICATOR ?? (privateKeyPath ? "SNOWFLAKE_JWT" : "SNOWFLAKE");
      const config: SnowflakeConnectionConfig = {
        account: required(args.account ?? process.env.SNOWFLAKE_ACCOUNT, "--account or SNOWFLAKE_ACCOUNT"),
        username: required(args.username ?? process.env.SNOWFLAKE_USER, "--username or SNOWFLAKE_USER"),
        database: required(database, "--database or SNOWFLAKE_DATABASE"),
        schema: args.schema,
        warehouse: required(args.warehouse ?? process.env.SNOWFLAKE_WAREHOUSE, "--warehouse or SNOWFLAKE_WAREHOUSE"),
        role: args.role ?? process.env.SNOWFLAKE_ROLE,
        authenticator,
        password: process.env.SNOWFLAKE_PASSWORD,
        token: process.env.SNOWFLAKE_TOKEN,
        privateKeyPath,
        privateKeyPass: process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE,
      };
      if (authenticator === "SNOWFLAKE" && !config.password) {
        throw new Error("SNOWFLAKE_PASSWORD is required for password authentication");
      }
      if (authenticator === "SNOWFLAKE_JWT" && !config.privateKeyPath) {
        throw new Error("--private-key-path or SNOWFLAKE_PRIVATE_KEY_PATH is required for SNOWFLAKE_JWT");
      }
      if (authenticator === "PROGRAMMATIC_ACCESS_TOKEN" && !config.token) {
        throw new Error("SNOWFLAKE_TOKEN is required for PROGRAMMATIC_ACCESS_TOKEN");
      }
      await loadSnowflakeBundle(bundle, config);
      process.stdout.write(`Loaded ${totalRows} rows into ${config.database}.${config.schema}.\n`);
    } finally {
      if (args.load && !explicitOutputDir) await rm(bundle.outputDir, { recursive: true, force: true });
    }
  },
});

const exportCommand = defineCommand({
  meta: { name: "export", description: "Export Hub data" },
  subCommands: { snowflake: exportSnowflake },
});

runMain(
  defineCommand({
    meta: { name: "argus-hub", version: VERSION, description: "Argus Hub server" },
    subCommands: { serve, export: exportCommand },
  }),
);
