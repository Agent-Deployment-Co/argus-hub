import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { DuplicateGroupNameError, type HubStore } from "../store/hub-store.ts";
import { syncHandler, unknownSessionsHandler } from "./sync.ts";
import { mountMcp } from "./mcp.ts";
import { assembleDashboard } from "../reporting/snapshot.ts";
import { loadPlugins } from "../reporting/inventory.ts";
import { buildActivityReport, buildTaskQualityReport, buildUserRoster } from "./reports.ts";
import { computeRecommendations } from "./recommendations.ts";
import { buildSessionList, buildSessionDetail, type SessionListParams } from "./session-list.ts";
import { buildTaskList, type TaskListParams } from "./task-list.ts";
import type { SessionSort } from "./session-list.ts";
import {
  parseResolvedQuery as parseResolvedQueryFrom,
  parseUserScope as parseUserScopeFrom,
  parseOutcomeFilter as parseOutcomeFilterFrom,
  parseIntOr,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  VALID_SORTS,
} from "./query-params.ts";
import type { AdminAuth } from "../admin-auth.ts";
import { verifySession, makeSessionCookie, clearSessionCookie } from "../admin-auth.ts";
import { LOGIN_PAGE } from "./pages.ts";

// ---- Query param parsing ----------------------------------------------------------------
//
// The parsers live in ./query-params.ts (shared with the MCP tools so the two surfaces can't
// diverge); here they're adapted to read from a Hono Context's query string.

const parseResolvedQuery = (c: Context) => parseResolvedQueryFrom((k) => c.req.query(k));
const parseUserScope = (c: Context) => parseUserScopeFrom((k) => c.req.query(k));
const parseOutcomeFilter = (c: Context) => parseOutcomeFilterFrom((k) => c.req.query(k));

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

  // ---- MCP (read-only query tools for external agents) --------------------------

  mountMcp(app, store, auth);

  // ---- Users --------------------------------------------------------------------

  // List known users with last-sync timestamps, session counts, and token/cost totals.
  // The frontend uses this for the user picker and the /users tab.
  app.get("/api/users", async (c) => {
    const orgId = await store.getDefaultOrgId();
    const users = await buildUserRoster(store, orgId);
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

  // Set (or clear, with `groupId: null`) a single user's group.
  app.patch("/api/users/:userId", async (c) => {
    const orgId = await store.getDefaultOrgId();
    if (!orgId) return c.json({ error: "No org configured." }, 503);
    const userId = c.req.param("userId").trim();

    const body = await c.req.json().catch(() => null) as { groupId?: unknown } | null;
    if (!body || !("groupId" in body)) return c.json({ error: 'Missing required "groupId".' }, 400);
    const groupId = body.groupId;
    if (groupId !== null && typeof groupId !== "string") {
      return c.json({ error: '"groupId" must be a string or null.' }, 400);
    }

    if (groupId !== null) {
      const groups = await store.listGroups(orgId);
      if (!groups.some((g) => g.groupId === groupId)) return c.json({ error: "Group not found." }, 404);
    }

    await store.setUserGroup(orgId, userId, groupId);
    return c.json({ ok: true });
  });

  // ---- Groups ---------------------------------------------------------------------

  // Groups with member counts. Backs group management + the grouped /users view.
  app.get("/api/groups", async (c) => {
    const orgId = await store.getDefaultOrgId();
    if (!orgId) return c.json({ groups: [] });
    const groups = await store.listGroups(orgId);
    return c.json({ groups });
  });

  app.post("/api/groups", async (c) => {
    const orgId = await store.getDefaultOrgId();
    if (!orgId) return c.json({ error: "No org configured." }, 503);

    const body = await c.req.json().catch(() => null) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: 'Missing required "name".' }, 400);

    try {
      const group = await store.createGroup(orgId, name);
      return c.json({ group }, 201);
    } catch (err) {
      if (err instanceof DuplicateGroupNameError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  app.patch("/api/groups/:groupId", async (c) => {
    const orgId = await store.getDefaultOrgId();
    if (!orgId) return c.json({ error: "No org configured." }, 503);
    const groupId = c.req.param("groupId").trim();

    const body = await c.req.json().catch(() => null) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: 'Missing required "name".' }, 400);

    const groups = await store.listGroups(orgId);
    if (!groups.some((g) => g.groupId === groupId)) return c.json({ error: "Group not found." }, 404);

    try {
      await store.renameGroup(orgId, groupId, name);
    } catch (err) {
      if (err instanceof DuplicateGroupNameError) return c.json({ error: err.message }, 409);
      throw err;
    }
    return c.json({ ok: true });
  });

  app.delete("/api/groups/:groupId", async (c) => {
    const orgId = await store.getDefaultOrgId();
    if (!orgId) return c.json({ error: "No org configured." }, 503);
    const groupId = c.req.param("groupId").trim();

    const groups = await store.listGroups(orgId);
    if (!groups.some((g) => g.groupId === groupId)) return c.json({ error: "Group not found." }, 404);

    // Ungroups members rather than deleting them (store.deleteGroup nulls their group_id).
    await store.deleteGroup(orgId, groupId);
    return c.json({ ok: true });
  });

  // Bulk membership changes for the row-selection toolbar in the UI.
  app.post("/api/groups/:groupId/members", async (c) => {
    const orgId = await store.getDefaultOrgId();
    if (!orgId) return c.json({ error: "No org configured." }, 503);
    const groupId = c.req.param("groupId").trim();

    const body = await c.req.json().catch(() => null) as { userIds?: unknown } | null;
    const userIds = Array.isArray(body?.userIds) ? body.userIds.filter((id): id is string => typeof id === "string") : null;
    if (!userIds || !userIds.length) return c.json({ error: 'Missing required "userIds" array.' }, 400);

    const groups = await store.listGroups(orgId);
    if (!groups.some((g) => g.groupId === groupId)) return c.json({ error: "Group not found." }, 404);

    await store.setUsersGroup(orgId, userIds, groupId);
    return c.json({ ok: true });
  });

  app.delete("/api/groups/:groupId/members", async (c) => {
    const orgId = await store.getDefaultOrgId();
    if (!orgId) return c.json({ error: "No org configured." }, 503);
    const groupId = c.req.param("groupId").trim();

    const body = await c.req.json().catch(() => null) as { userIds?: unknown } | null;
    const userIds = Array.isArray(body?.userIds) ? body.userIds.filter((id): id is string => typeof id === "string") : null;
    if (!userIds || !userIds.length) return c.json({ error: 'Missing required "userIds" array.' }, 400);

    const groups = await store.listGroups(orgId);
    if (!groups.some((g) => g.groupId === groupId)) return c.json({ error: "Group not found." }, 404);

    await store.setUsersGroup(orgId, userIds, null);
    return c.json({ ok: true });
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

  // ---- Activity report (org-wide Page 1) -----------------------------------------

  app.get("/api/activity", async (c) => {
    const orgId = await store.getDefaultOrgId();
    if (!orgId) return c.json({ error: "No data yet." }, 503);

    const query = parseResolvedQuery(c);
    if (typeof query === "string") return c.json({ error: query }, 400);

    const report = await buildActivityReport(store, { orgId }, query, new Date());
    if (!report) return c.json({ error: "No data yet." }, 503);
    return c.json(report);
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

  // ---- Task list ------------------------------------------------------------------
  //
  // Flat, cross-session feed of extracted tasks (what the client's task-extraction pass
  // inferred the user asked for, plus outcome/frustration signals). Backs the /tasks tab.
  app.get("/api/tasks", async (c) => {
    const orgId = await store.getDefaultOrgId();
    if (!orgId) {
      return c.json({
        rows: [],
        total: 0,
        offset: 0,
        limit: DEFAULT_LIMIT,
        counts: { success: 0, failure: 0, unknown: 0 },
      });
    }

    const query = parseResolvedQuery(c);
    if (typeof query === "string") return c.json({ error: query }, 400);

    const outcomes = parseOutcomeFilter(c);
    if (typeof outcomes === "string") return c.json({ error: outcomes }, 400);

    const userId = parseUserScope(c);
    const taskRows = await store.readTaskFacts({ orgId, userId }, query);

    const params: TaskListParams = {
      limit: Math.min(MAX_LIMIT, Math.max(1, parseIntOr(c.req.query("limit"), DEFAULT_LIMIT))),
      offset: Math.max(0, parseIntOr(c.req.query("offset"), 0)),
      q: c.req.query("q") || undefined,
      outcomes,
    };
    return c.json(buildTaskList(taskRows, params));
  });

  // ---- Task report (Page 2 — Tasks) ----------------------------------------------
  //
  // Outcomes, frustration, and friction rolled up for the window — how *well* the org's agent
  // work is going, built on the same readTaskFacts spine as /api/tasks so the two views always
  // agree on totals (SPEC.md 5).
  app.get("/api/tasks/report", async (c) => {
    const orgId = await store.getDefaultOrgId();
    if (!orgId) return c.json({ error: "No data yet." }, 503);

    const query = parseResolvedQuery(c);
    if (typeof query === "string") return c.json({ error: query }, 400);

    const userId = parseUserScope(c);
    const report = await buildTaskQualityReport(store, { orgId, userId }, query, new Date());
    if (!report) return c.json({ error: "No data yet." }, 503);
    return c.json(report);
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

  // ---- SPA ------------------------------------------------------------------------
  //
  // The React SPA built from hub/web is a client-routed app (side nav: team-wide Activity at
  // "/", per-user activity at "/users/$userId"). It's served at the root with absolute asset
  // URLs (vite base "/"), so every unmatched GET either resolves to a static asset in the web
  // root or falls back to index.html for the client-side router to handle.

  const webRoot = findWebRoot();

  app.get("*", async (c) => {
    if (!webRoot) return c.html(spaPlaceholderHtml());
    const url = new URL(c.req.url);
    const rel = decodeURIComponent(url.pathname.replace(/^\//, ""));
    // Static assets are served unauthenticated (they're just app code, not data) and checked
    // before the session redirect below, so an expired/missing cookie can't turn a CSS/JS
    // request into a redirect to /login — the browser would then refuse to apply the HTML
    // response as a stylesheet/script ("non CSS MIME types are not allowed").
    const asset = rel ? resolveAsset(webRoot, rel) : null;
    if (asset) {
      return c.body(readFileSync(asset), 200, {
        "Content-Type": MIME[extname(asset).toLowerCase()] ?? "application/octet-stream",
      });
    }
    // A path that looks like a static asset (has a file extension) but doesn't resolve to a
    // real file — usually a stale reference to something removed by a rebuild — must 404 rather
    // than fall through to the SPA shell or login page, for the same reason as above.
    if (rel && extname(rel)) return c.notFound();
    if (auth && !verifySession(c.req.header("Cookie"), auth)) {
      return new Response(null, { status: 302, headers: { Location: "/login" } });
    }
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
