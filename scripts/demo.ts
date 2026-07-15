#!/usr/bin/env bun
// Stand up a realistic, reproducible Hub demo in a sandbox and (optionally) open the dashboard on it.
// Exists for live demos and stable screenshots. This is orchestration only — the reviewable data lives
// in scripts/demo/scenarios.ts and the deterministic expansion in scripts/demo/generate.ts.
//
// It seeds directly through the HubStore client seams (the same calls /api/sync makes), NOT over HTTP:
//   for each synthetic person -> upsertClient, recordFingerprintObservations, resolveUserForClient,
//   upsertClientSessions. Direct seeding is deterministic, needs no running server, and fails
//   typecheck/tests on any store-contract drift. It never touches the real store (data/hub.db).
//
//   bun run demo                                   # seed into .demo/ and open the dashboard
//   bun run scripts/demo.ts --no-serve             # seed only, print the serve command
//   bun run scripts/demo.ts --as-of 2026-07-01 --seed 42   # pin date + seed for reproducible screenshots
//
// Flags: --out <dir> (default .demo/, gitignored), --as-of <YYYY-MM-DD> (default today),
// --seed <n> (default 42), --serve/--no-serve, --port <n> (default 4343).

import { defineCommand, runMain } from "citty";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { openHubStore } from "../src/store/hub-store.ts";
import { createAdminAuth } from "../src/admin-auth.ts";
import { generateDemoData } from "./demo/generate.ts";

/** Parse a `YYYY-MM-DD` as UTC midnight (matches the generator's UTC date handling). */
function parseAsOf(value: string): number {
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid --as-of date: ${value} (expected YYYY-MM-DD)`);
  return ms;
}

/** Today in UTC as `YYYY-MM-DD`, the default anchor. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

const demo = defineCommand({
  meta: { name: "demo", description: "Seed a reproducible Hub demo store and optionally serve it" },
  args: {
    out: { type: "string", description: "Sandbox data dir for hub.db", default: ".demo" },
    "as-of": { type: "string", description: "Anchor date YYYY-MM-DD", default: todayUtc() },
    seed: { type: "string", description: "PRNG seed", default: "42" },
    serve: { type: "boolean", description: "Serve the dashboard after seeding", default: true },
    port: { type: "string", description: "Port for --serve", default: process.env.HUB_PORT ?? "4343" },
  },
  async run({ args }) {
    const out = args.out;
    const asOfMs = parseAsOf(args["as-of"]);
    const seed = Number(args.seed);
    if (Number.isNaN(seed)) throw new Error(`Invalid --seed: ${args.seed}`);

    // Fresh sandbox every run: reproducible, and guarantees the API key below is (re)printed.
    for (const suffix of ["hub.db", "hub.db-wal", "hub.db-shm"]) {
      await rm(join(out, suffix), { force: true });
    }

    process.stdout.write(`Seeding Hub demo into ${out}/ (as-of ${args["as-of"]}, seed ${seed})…\n`);
    const data = generateDemoData({ asOfMs, seed });

    // openHubStore bootstraps the "Default" org and prints a fresh API key (fresh db per above).
    const store = await openHubStore(out, asOfMs);
    const orgId = await store.getDefaultOrgId();
    if (!orgId) throw new Error("Bootstrap did not create a default org");

    // Seed each person the way /api/sync would: one client -> one user.
    for (const dm of data.members) {
      await store.upsertClient(orgId, dm.clientId, asOfMs);
      await store.recordFingerprintObservations(dm.clientId, dm.fingerprint);
      await store.resolveUserForClient(orgId, dm.clientId, asOfMs);
      await store.upsertClientSessions(orgId, dm.clientId, dm.rows, asOfMs);
    }

    const users = await store.listUsers(orgId);
    await store.close();

    process.stdout.write(
      `\nSeeded ${data.stats.sessions} sessions, ${data.stats.messages} messages, ` +
        `${data.stats.tasks} tasks across ${users.length} users:\n`,
    );
    for (const u of users) {
      const email = u.email && u.email !== u.displayName ? ` <${u.email}>` : "";
      process.stdout.write(`  • ${u.displayName}${email} — ${u.sessionCount} sessions\n`);
    }
    process.stdout.write(`Sessions by source: ${JSON.stringify(data.stats.bySource)}\n`);

    const cliPath = join(import.meta.dir, "../src/cli.ts");
    if (!args.serve) {
      process.stdout.write(
        `\nDone. Serve it with:\n  bun run ${cliPath} serve --data-dir ${out} --port ${args.port}\n` +
          `(the server prints its own admin password on start)\n`,
      );
      return;
    }

    // Serving: mint the admin password here, print it, and hand it to the serve child via
    // ADMIN_PASSWORD so the printed password is the one that actually works (serve stays silent when
    // ADMIN_PASSWORD is set — see src/cli.ts).
    const auth = createAdminAuth(process.env.ADMIN_PASSWORD);
    process.stdout.write(`\nAdmin password: ${auth.password}\n`);

    // The dashboard is a prebuilt SPA; build it once so serve has assets to hand out (mirrors dev.ts).
    process.stdout.write(`Building dashboard…\n`);
    const build = Bun.spawn({ cmd: ["bun", "run", "build:web"], stdout: "inherit", stderr: "inherit" });
    if (await build.exited) throw new Error("build:web failed");

    process.stdout.write(`\nHub → http://localhost:${args.port}/\n`);
    const server = Bun.spawn({
      cmd: ["bun", cliPath, "serve", "--data-dir", out, "--port", args.port],
      env: { ...process.env, ADMIN_PASSWORD: auth.password },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => server.kill());
    process.exitCode = (await server.exited) === 0 ? 0 : 1;
  },
});

runMain(demo);
