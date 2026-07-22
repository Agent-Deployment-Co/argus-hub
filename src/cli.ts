#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { openHubStore } from "./store/hub-store.ts";
import { startHubServer } from "./api/serve.ts";
import { createAdminAuth } from "./admin-auth.ts";
import { randomUUID } from "node:crypto";
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
    "data-dir": {
      type: "string",
      description: "Directory for hub.db",
      default: process.env.HUB_DATA_DIR ?? "./data",
    },
  },
  async run({ args }) {
    const port = Number(args.port);
    const insecureCookieHosts = process.env.HUB_INSECURE_COOKIE_HOSTS
      ?.split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    const auth = createAdminAuth(process.env.ADMIN_PASSWORD, insecureCookieHosts);
    const store = await openHubStore(args["data-dir"]);

    if (!process.env.ADMIN_PASSWORD) {
      process.stdout.write(`Admin password: ${auth.password}\n`);
    }

    const ac = new AbortController();
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => ac.abort());
    }

    await startHubServer({ port, store, auth, signal: ac.signal });
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
    meta: { name: "argus-hub", version: "0.1.0", description: "Argus Hub server" },
    subCommands: { serve, export: exportCommand },
  }),
);
