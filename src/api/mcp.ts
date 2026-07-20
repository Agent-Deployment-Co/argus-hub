// MCP (Model Context Protocol) surface for the Hub — read-only query tools so external clients
// (Claude Code, other agents) can ask the same questions the web dashboard answers, in-process
// against the same HubStore + reporting builders. See MCP_PLAN.md for the design.

import type { Hono } from "hono";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { HubStore } from "../store/hub-store.ts";
import type { AdminAuth } from "../admin-auth.ts";
import { parseBearerToken } from "./sync.ts";
import {
  parseResolvedQuery, parseUserScope, parseOutcomeFilter, parseIntOr,
  DEFAULT_LIMIT, MAX_LIMIT, type QueryGetter,
} from "./query-params.ts";
import { assembleActivityReport, previousWindow } from "../reporting/activity.ts";
import { assembleTaskReport } from "../reporting/tasks.ts";
import { assembleDashboard } from "../reporting/snapshot.ts";
import { loadPlugins } from "../reporting/inventory.ts";
import { buildTaskList, type TaskListParams } from "./task-list.ts";
import { cost } from "../pricing.ts";

// ---- Shared input schema ------------------------------------------------------------------

const SHARED_PROPERTIES: Record<string, object> = {
  since: { type: "string", description: "ISO date YYYY-MM-DD, inclusive start of the window." },
  until: { type: "string", description: "ISO date YYYY-MM-DD, inclusive end of the window." },
  project: { type: "string", description: "Substring match on project path." },
  source: { type: "string", enum: ["claude", "codex", "gemini", "cowork"], description: "Restrict to one agent source." },
  user: { type: "string", description: "Scope to one userId (omit for the whole org)." },
};

/** Adapt a tool call's JSON args object into the `QueryGetter` the shared parsers expect.
 *  Numbers (e.g. `limit`/`offset`) are stringified so `parseIntOr` can read them; JSON-RPC
 *  args have no schema-enforced types, so a model may send either shape. */
function argsGetter(args: Record<string, unknown> | undefined): QueryGetter {
  return (key) => {
    const v = args?.[key];
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    return undefined;
  };
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function toolJson(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

// ---- Tool definitions -----------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: "query_activity",
    description:
      "Usage and cost over a time window: totals vs. the previous window, a daily series, and " +
      "per-user / per-source / per-model rollups. Answers 'how much are we using agents, by whom, " +
      "trending how'. Defaults to the last 30 days.",
    inputSchema: { type: "object", properties: SHARED_PROPERTIES },
  },
  {
    name: "query_tasks",
    description:
      "Flat, paged list of extracted tasks (description, outcome, frustration, signals) plus " +
      "outcome counts. Answers 'show me the failed tasks last week' / 'what did people ask agents " +
      "to do'.",
    inputSchema: {
      type: "object",
      properties: {
        ...SHARED_PROPERTIES,
        q: { type: "string", description: "Search over task description/project." },
        outcome: { type: "string", description: "Comma list of success|failure|unknown to filter to." },
        limit: { type: "number", description: `Max rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        offset: { type: "number", description: "Row offset for paging (default 0)." },
      },
    },
  },
  {
    name: "query_task_quality",
    description:
      "Outcomes and friction rolled up for a window: success/frustration/interrupted rates, an " +
      "outcomes-over-time daily series, quality by user/source/project, and top failure signals. " +
      "Answers 'how *well* is agent work going'. Defaults to the last 30 days.",
    inputSchema: { type: "object", properties: SHARED_PROPERTIES },
  },
  {
    name: "query_tool_usage",
    description:
      "Which tools and MCP servers are actually being used, by how many people: per-tool and " +
      "per-tool-category call stats, underused tools, shared-vs-solo reach, and source comparison.",
    inputSchema: { type: "object", properties: SHARED_PROPERTIES },
  },
  {
    name: "query_users",
    description:
      "Roster of known users in the org — userId, display name, email, last-sync time, session/" +
      "client counts, total tokens, and total cost. Use this to discover valid `user` ids before " +
      "scoping the other tools to one person.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function handleQueryActivity(store: HubStore, args: Record<string, unknown> | undefined) {
  const orgId = await store.getDefaultOrgId();
  if (!orgId) return toolError("No data yet.");

  const query = parseResolvedQuery(argsGetter(args));
  if (typeof query === "string") return toolError(query);

  const now = new Date();
  const isoDaysAgo = (n: number) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const since = query.since ?? isoDaysAgo(30);
  const until = query.until ?? isoDaysAgo(0);
  const currentQuery = { ...query, since, until };
  const { since: previousSince, until: previousUntil } = previousWindow(since, until);
  const previousQuery = { ...query, since: previousSince, until: previousUntil };

  const scope = { orgId };
  const [currentTotals, previousTotals, daily, byUser, bySource, currentTasks, previousTasks] =
    await Promise.all([
      store.readActivityTotals(scope, currentQuery),
      store.readActivityTotals(scope, previousQuery),
      store.readActivityDaily(scope, currentQuery),
      store.readActivityUserRollup(scope, currentQuery),
      store.readActivitySourceRollup(scope, currentQuery),
      store.readTaskFacts(scope, currentQuery),
      store.readTaskFacts(scope, previousQuery),
    ]);

  if (currentTotals.sessions === 0 && previousTotals.sessions === 0 && byUser.length === 0) {
    return toolError("No data yet.");
  }

  const report = assembleActivityReport({
    since, until, previousSince, previousUntil,
    currentTotals, previousTotals, daily, byUser, bySource,
    currentTasks: currentTasks.map((r) => ({ task: r.task, userId: r.userId })),
    previousTasks: previousTasks.map((r) => ({ task: r.task })),
    nowMs: now.getTime(),
  });
  return toolJson(report);
}

async function handleQueryTasks(store: HubStore, args: Record<string, unknown> | undefined) {
  const get = argsGetter(args);
  const orgId = await store.getDefaultOrgId();
  if (!orgId) {
    return toolJson({
      rows: [], total: 0, offset: 0, limit: DEFAULT_LIMIT,
      counts: { success: 0, failure: 0, unknown: 0 },
    });
  }

  const query = parseResolvedQuery(get);
  if (typeof query === "string") return toolError(query);

  const outcomes = parseOutcomeFilter(get);
  if (typeof outcomes === "string") return toolError(outcomes);

  const userId = parseUserScope(get);
  const taskRows = await store.readTaskFacts({ orgId, userId }, query);

  const params: TaskListParams = {
    limit: Math.min(MAX_LIMIT, Math.max(1, parseIntOr(get("limit"), DEFAULT_LIMIT))),
    offset: Math.max(0, parseIntOr(get("offset"), 0)),
    q: get("q") || undefined,
    outcomes,
  };
  return toolJson(buildTaskList(taskRows, params));
}

async function handleQueryTaskQuality(store: HubStore, args: Record<string, unknown> | undefined) {
  const get = argsGetter(args);
  const orgId = await store.getDefaultOrgId();
  if (!orgId) return toolError("No data yet.");

  const query = parseResolvedQuery(get);
  if (typeof query === "string") return toolError(query);

  const now = new Date();
  const isoDaysAgo = (n: number) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const since = query.since ?? isoDaysAgo(30);
  const until = query.until ?? isoDaysAgo(0);
  const currentQuery = { ...query, since, until };

  const userId = parseUserScope(get);
  const scope = { orgId, userId };
  const [rows, friction, totals] = await Promise.all([
    store.readTaskFacts(scope, currentQuery),
    store.readWindowFrictionRollup(scope, currentQuery),
    store.readActivityTotals(scope, currentQuery),
  ]);

  if (totals.sessions === 0) return toolError("No data yet.");

  const report = assembleTaskReport({ since, until, rows, friction, nowMs: now.getTime() });
  return toolJson(report);
}

async function handleQueryToolUsage(store: HubStore, args: Record<string, unknown> | undefined) {
  const get = argsGetter(args);
  const orgId = await store.getDefaultOrgId();
  if (!orgId) return toolError("No data yet.");

  const query = parseResolvedQuery(get);
  if (typeof query === "string") return toolError(query);

  const userId = parseUserScope(get);
  const aggregates = await store.readDashboardAggregates({ orgId, userId }, query);
  if (aggregates.sessionsBySource.length === 0) return toolError("No data yet.");

  const dashboard = assembleDashboard(aggregates, loadPlugins());
  return toolJson({
    byTool: dashboard.byTool,
    byToolCategory: dashboard.byToolCategory,
    underused: dashboard.underused,
    sharedVsSolo: dashboard.sharedVsSolo,
    sourceComparison: dashboard.sourceComparison,
  });
}

async function handleListUsers(store: HubStore) {
  const orgId = await store.getDefaultOrgId();
  if (!orgId) return toolJson({ users: [] });

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
  return toolJson({ users });
}

async function callTool(store: HubStore, name: string, args: Record<string, unknown> | undefined) {
  switch (name) {
    case "query_activity":
      return handleQueryActivity(store, args);
    case "query_tasks":
      return handleQueryTasks(store, args);
    case "query_task_quality":
      return handleQueryTaskQuality(store, args);
    case "query_tool_usage":
      return handleQueryToolUsage(store, args);
    case "query_users":
      return handleListUsers(store);
    default:
      return toolError(`Unknown tool "${name}".`);
  }
}

// ---- Server + Hono wiring -------------------------------------------------------------------

function buildMcpServer(store: HubStore): Server {
  const server = new Server({ name: "argus-hub", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return callTool(store, name, args as Record<string, unknown> | undefined);
  });

  return server;
}

/** Mount the read-only MCP surface at `POST/GET /mcp`. Stateless Streamable HTTP transport — one
 *  JSON-RPC exchange per HTTP request, no session id. Auth reuses the admin password as a bearer
 *  token (same secret that unlocks the dashboard); the route is open when `auth` is omitted,
 *  matching how `/api/*` behaves without auth configured. */
export function mountMcp(app: Hono, store: HubStore, auth?: AdminAuth): void {
  app.use("/mcp", async (c, next) => {
    if (!auth) return next();
    const token = parseBearerToken(c.req.header("Authorization"));
    if (!token || token !== auth.password) {
      return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized." }, id: null }, 401);
    }
    return next();
  });

  app.all("/mcp", async (c) => {
    const server = buildMcpServer(store);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(c.req.raw);
    await server.close();
    return response;
  });
}
