#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { openHubStore } from "./store/hub-store.ts";
import { startHubServer } from "./api/serve.ts";
import { createAdminAuth } from "./admin-auth.ts";

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

runMain(
  defineCommand({
    meta: { name: "argus-hub", version: "0.1.0", description: "Argus Hub server" },
    subCommands: { serve },
  }),
);
