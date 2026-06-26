import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { HubStore } from "../store/hub-store.ts";
import { syncHandler, unknownSessionsHandler } from "./sync.ts";
import { assembleDashboard } from "../reporting/snapshot.ts";
import { loadPlugins } from "../reporting/inventory.ts";
import { computeRecommendations } from "./recommendations.ts";
import { buildSessionList, buildSessionDetail, type SessionListParams } from "./session-list.ts";
import type { ResolvedQuery } from "../types.ts";
import type { SessionSort } from "./session-list.ts";
import { cost } from "../pricing.ts";
import type { AdminAuth } from "../admin-auth.ts";
import { verifySession, makeSessionCookie, clearSessionCookie } from "../admin-auth.ts";
import { LOGIN_PAGE, orgDetailPage, type OrgDetail } from "./pages.ts";

// ---- Query param parsing ----------------------------------------------------------------

const VALID_SOURCES = new Set(["claude", "codex", "gemini", "cowork"]);
const VALID_SORTS = new Set<string>(["recent", "tokens", "cost"]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseIntOr(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse since/until/project/source into a ResolvedQuery. Returns an error string on bad input. */
function parseResolvedQuery(c: Context): ResolvedQuery | string {
  const source = c.req.query("source");
  if (source && !VALID_SOURCES.has(source)) return `Unknown source "${source}".`;
  const q: ResolvedQuery = {};
  const since = c.req.query("since");
  const until = c.req.query("until");
  const project = c.req.query("project");
  if (since) q.since = since;
  if (until) q.until = until;
  if (project) q.projectSubstring = project;
  if (source) q.sources = [source as "claude" | "codex" | "gemini" | "cowork"];
  return q;
}

/** Parse the ?user= query param. Returns undefined (all users) or the specific userId. */
function parseUserScope(c: Context): string | undefined {
  return c.req.query("user")?.trim() || undefined;
}

function requestHost(c: Context): string | undefined {
  return c.req.header("Host") ?? new URL(c.req.url).host;
}

// ---- App factory (pure wiring, no networking) -------------------------------------------

/** Build the Hub Hono app. Pure wiring — no listening, no I/O — so tests can call
 *  `app.request(...)` directly without starting a real server.
 *  `auth` is required in production (passed by cli.ts); omit in tests that don't
 *  exercise the login flow — routes are open when auth is undefined. */
export function createHubApp(store: HubStore, auth?: AdminAuth): Hono {
  const app = new Hono();

  // ---- Health check (no auth) ---------------------------------------------------

  app.get("/healthz", (c) => c.text("ok"));

  // ---- Auth (login / logout / dashboard) — only wired when auth is configured ----

  if (auth) {
    app.get("/login", (c) => c.html(LOGIN_PAGE.replace("{{ERROR}}", "")));

    app.post("/login", async (c) => {
      const body = await c.req.parseBody();
      const entered = typeof body["password"] === "string" ? body["password"] : "";
      if (entered !== auth.password) {
        return c.html(
          LOGIN_PAGE.replace("{{ERROR}}", '<div class="error">Incorrect password.</div>'),
          401,
        );
      }
      return new Response(null, {
        status: 302,
        headers: { Location: "/", "Set-Cookie": makeSessionCookie(auth, requestHost(c)) },
      });
    });

    app.get("/logout", (c) =>
      new Response(null, {
        status: 302,
        headers: { Location: "/login", "Set-Cookie": clearSessionCookie() },
      }),
    );

    // Root — the single org's user list; redirect to login if unauthenticated.
    app.get("/", async (c) => {
      if (!verifySession(c.req.header("Cookie"), auth)) {
        return new Response(null, { status: 302, headers: { Location: "/login" } });
      }
      const orgs = await store.listOrgs();
      const org = orgs[0];
      if (!org) return c.html("<h1>No data yet. Run <code>argus sync</code> from a client to ingest data.</h1>", 404);
      const orgId = org.orgId;
      const userStats = await store.readUserStats(orgId);
      const users = userStats.map(({ userId, displayName, email, lastSyncMs, sessionCount, clientCount, byModel }) => ({
        userId,
        displayName,
        email,
        lastSyncMs,
        sessionCount,
        clientCount,
        totalTokens: byModel.reduce((s, m) => s + m.input + m.output + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h, 0),
        cost: byModel.reduce(
          (s, m) => s + cost({ input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite5m: m.cacheWrite5m, cacheWrite1h: m.cacheWrite1h }, m.model),
          0,
        ),
      }));
      const detail: OrgDetail = {
        orgId: org.orgId,
        name: org.name,
        createdAt: org.createdAt,
        userCount: org.userCount,
        sessionCount: org.sessionCount,
        totalTokens: org.totalTokens,
        totalCost: users.reduce((s, u) => s + u.cost, 0),
        users,
      };
      return c.html(orgDetailPage(detail));
    });

    // Auth middleware for all /api/* routes; the sync endpoints are exempt (they use their
    // own API-key auth).
    app.use("/api/*", async (c, next) => {
      if (
        c.req.method === "POST" &&
        (c.req.path === "/api/sync" || c.req.path === "/api/sync/unknown-sessions")
      ) {
        await next();
        return;
      }
      if (!verifySession(c.req.header("Cookie"), auth)) {
        return c.json({ error: "Unauthorized." }, 401);
      }
      await next();
    });
  }

  // ---- Ingest (API-key auth handled inside syncHandler) -------------------------

  app.post("/api/sync", syncHandler(store));
  app.post("/api/sync/unknown-sessions", unknownSessionsHandler(store));

  // ---- Users --------------------------------------------------------------------

  // List known users with last-sync timestamps, session counts, and token/cost totals.
  // The frontend uses this for the user picker and the /users tab.
  app.get("/api/users", async (c) => {
    const orgId = await store.getDefaultOrgId();
    if (!orgId) return c.json({ users: [] });
    const stats = await store.readUserStats(orgId);
    const users = stats.map(({ userId, displayName, email, lastSyncMs, sessionCount, clientCount, byModel }) => {
      const totalTokens = byModel.reduce(
        (s, m) => s + m.input + m.output + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h, 0,
      );
      const totalCost = byModel.reduce(
        (s, m) => s + cost({ input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite5m: m.cacheWrite5m, cacheWrite1h: m.cacheWrite1h }, m.model),
        0,
      );
      return { userId, displayName, email, lastSyncMs, sessionCount, clientCount, totalTokens, cost: totalCost };
    });
    return c.json({ users });
  });

  // Single-user metadata for the SPA header (display name + email + org name). 404 if unknown.
  app.get("/api/user/:userId", async (c) => {
    const orgId = await store.getDefaultOrgId();
    const userId = c.req.param("userId").trim();
    if (!orgId || !userId) return c.json({ error: "User not found." }, 404);
    const display = await store.lookupUserDisplay(orgId, userId);
    if (!display) return c.json({ error: "User not found." }, 404);
    const orgs = await store.listOrgs();
    const orgName = orgs.find((o) => o.orgId === orgId)?.name ?? orgId;
    return c.json({ userId, displayName: display.displayName, email: display.email, orgId, orgName });
  });

  // Clients in the org with their fingerprint snapshot + current user mapping.
  app.get("/api/clients", async (c) => {
    const orgId = await store.getDefaultOrgId();
    if (!orgId) return c.json({ clients: [] });
    const clients = await store.listClients(orgId);
    return c.json({ clients });
  });

  // ---- Snapshot (aggregate dashboard) -------------------------------------------

  app.get("/api/snapshot", async (c) => {
    const orgId = await store.getDefaultOrgId();
    if (!orgId) return c.json({ error: "No data yet." }, 503);

    const query = parseResolvedQuery(c);
    if (typeof query === "string") return c.json({ error: query }, 400);

    const userId = parseUserScope(c);
    const aggregates = await store.readDashboardAggregates({ orgId, userId }, query);
    if (aggregates.sessionsBySource.length === 0) return c.json({ error: "No data yet." }, 503);
    const dashboard = assembleDashboard(aggregates, loadPlugins());
    const generatedAtMs = Date.now();
    dashboard.generatedAtMs = generatedAtMs;
    const recommendations = computeRecommendations(dashboard);
    return c.json({ dashboard, recommendations, generatedAtMs });
  });

  // ---- Session list -------------------------------------------------------------

  app.get("/api/sessions", async (c) => {
    const orgId = await store.getDefaultOrgId();
    if (!orgId) return c.json({ rows: [], total: 0, offset: 0, limit: DEFAULT_LIMIT });

    const query = parseResolvedQuery(c);
    if (typeof query === "string") return c.json({ error: query }, 400);

    const sort = c.req.query("sort") ?? "recent";
    if (!VALID_SORTS.has(sort)) return c.json({ error: `Unknown sort "${sort}".` }, 400);

    const userId = parseUserScope(c);
    const aggregates = await store.readSessionAggregates({ orgId, userId }, query);

    const params: SessionListParams = {
      sort: sort as SessionSort,
      limit: Math.min(MAX_LIMIT, Math.max(1, parseIntOr(c.req.query("limit"), DEFAULT_LIMIT))),
      offset: Math.max(0, parseIntOr(c.req.query("offset"), 0)),
      project: c.req.query("project") || undefined,
      q: c.req.query("q") || undefined,
      includeGenerated: c.req.query("includeGenerated") === "true",
    };
    return c.json(buildSessionList(aggregates, params));
  });

  // ---- Session detail -----------------------------------------------------------

  // Requires ?user= because session IDs are per-user UUIDs that may collide across users.
  app.get("/api/session/:id", async (c) => {
    const userId = parseUserScope(c);
    if (!userId) return c.json({ error: "Missing required ?user= parameter." }, 400);

    const orgId = await store.getDefaultOrgId();
    if (!orgId) return c.json({ error: "Session not found." }, 404);

    const sessionId = c.req.param("id").trim();
    if (!sessionId) return c.json({ error: "Missing session id." }, 400);

    const scope = { orgId, userId };
    const [meta, messages, tasks] = await Promise.all([
      store.readHubSessionMeta(scope, sessionId),
      store.readHubSessionMessages(scope, sessionId),
      store.readHubSessionTasks(scope, sessionId),
    ]);

    if (!meta || !messages.length) return c.json({ error: "Session not found." }, 404);

    const session = buildSessionDetail(sessionId, messages, meta, tasks);
    return c.json({ session });
  });

  // ---- Per-user SPA -------------------------------------------------------------
  //
  // The React SPA built from hub/web lives under /users/:userId/. It reads userId from the URL at
  // startup and calls /api/snapshot?user=<id> for its data. The SPA's own assets are emitted with
  // relative URLs (vite base "./"), so they resolve under any prefix.

  const webRoot = findWebRoot();

  app.get("/users/:userId/*", async (c) => {
    if (auth && !verifySession(c.req.header("Cookie"), auth)) {
      return new Response(null, { status: 302, headers: { Location: "/login" } });
    }
    if (!webRoot) return c.html(spaPlaceholderHtml());
    // Strip the per-user prefix to find the asset request, if any. Use the raw (still-encoded)
    // pathname so the prefix match isn't thrown off by %-encoded characters in the user id
    // (e.g. `jerry%40apache.org`).
    const url = new URL(c.req.url);
    const m = url.pathname.match(/^\/users\/[^/]+\/(.*)$/);
    const rel = m ? decodeURIComponent(m[1]!) : "";
    const asset = rel ? resolveAsset(webRoot, rel) : null;
    if (asset) {
      return c.body(readFileSync(asset), 200, {
        "Content-Type": MIME[extname(asset).toLowerCase()] ?? "application/octet-stream",
      });
    }
    return c.body(readFileSync(join(webRoot, "index.html")), 200, { "Content-Type": MIME[".html"]! });
  });
  // Trailing slash with no further path: serve index.html.
  app.get("/users/:userId/", async (c) => {
    if (auth && !verifySession(c.req.header("Cookie"), auth)) {
      return new Response(null, { status: 302, headers: { Location: "/login" } });
    }
    if (!webRoot) return c.html(spaPlaceholderHtml());
    return c.body(readFileSync(join(webRoot, "index.html")), 200, { "Content-Type": MIME[".html"]! });
  });

  return app;
}

// ---- SPA helpers --------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

/** Locate the compiled hub web SPA: hub/dist/web next to the compiled CLI, or relative to source. */
function findWebRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "web"), // bundled: hub/dist/cli.js → hub/dist/web
    join(here, "..", "..", "dist", "web"), // from source: hub/src/api/serve.ts → hub/dist/web
  ];
  return candidates.find((p) => existsSync(join(p, "index.html"))) ?? null;
}

/** Map a URL-relative path to a file inside the web root, refusing anything that escapes it. */
function resolveAsset(root: string, rel: string): string | null {
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const full = join(root, safe);
  if (full !== root && !full.startsWith(root + (process.platform === "win32" ? "\\" : "/"))) return null;
  return existsSync(full) && statSync(full).isFile() ? full : null;
}

function spaPlaceholderHtml(): string {
  return `<!doctype html><meta charset="utf-8"><title>Argus Hub</title>
<body style="font:16px/1.5 system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem">
<h1>Hub is running</h1>
<p>The web app hasn't been built yet. Build it with <code>bun run build:web</code> from the
<code>hub/</code> directory.</p>
<p>The data API is live at <a href="/api/snapshot">/api/snapshot</a>.</p></body>`;
}

// ---- Server lifecycle -------------------------------------------------------------------

export interface HubServeOptions {
  port: number;
  store: HubStore;
  auth: AdminAuth;
  /** Aborting this signal stops the server gracefully. */
  signal?: AbortSignal;
}

/** Start listening. Resolves once the server has fully shut down (after `signal` fires or
 *  the process exits). Call site is responsible for opening and closing the store. */
export function startHubServer(opts: HubServeOptions): Promise<void> {
  const app = createHubApp(opts.store, opts.auth);

  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, port: opts.port },
      () => {
        process.stdout.write(`Hub listening on port ${opts.port}\n`);
        if (opts.signal?.aborted) {
          server.close();
          return;
        }
        opts.signal?.addEventListener("abort", () => server.close(), { once: true });
      },
    );

    server.on("close", resolve);
    server.on("error", reject);
  });
}
