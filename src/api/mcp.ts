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
  DEFAULT_LIMIT, MAX_LIMIT, VALID_SOURCES, type QueryGetter,
} from "./query-params.ts";
import { buildActivityReport, buildTaskQualityReport, buildUserRoster } from "./reports.ts";
import { assembleDashboard } from "../reporting/snapshot.ts";
import { loadPlugins } from "../reporting/inventory.ts";
import { buildTaskList, type TaskListParams } from "./task-list.ts";

// ---- Shared input schema ------------------------------------------------------------------

const SHARED_PROPERTIES: Record<string, object> = {
  since: { type: "string", description: "ISO date YYYY-MM-DD, inclusive start of the window." },
  until: { type: "string", description: "ISO date YYYY-MM-DD, inclusive end of the window." },
  project: { type: "string", description: "Substring match on project path." },
  source: { type: "string", enum: [...VALID_SOURCES], description: "Restrict to one agent source." },
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

/** Every arg value `argsGetter` can actually read is a `string` or `number`; anything else
 *  (array, boolean, object) would otherwise be silently read back as "filter omitted" instead
 *  of the caller's mistake it actually is. Reject those up front so a dropped filter surfaces
 *  as a tool error rather than a query that quietly ignores it. */
function invalidArgShape(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const [key, v] of Object.entries(args)) {
    if (v !== undefined && v !== null && typeof v !== "string" && typeof v !== "number") {
      return `Invalid value for "${key}": expected a string or number.`;
    }
  }
  return undefined;
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
  const get = argsGetter(args);
  const orgId = await store.getDefaultOrgId();
  if (!orgId) return toolError("No data yet.");

  const query = parseResolvedQuery(get);
  if (typeof query === "string") return toolError(query);

  const userId = parseUserScope(get);
  const report = await buildActivityReport(store, { orgId, userId }, query, new Date());
  if (!report) return toolError("No data yet.");
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

  const userId = parseUserScope(get);
  const report = await buildTaskQualityReport(store, { orgId, userId }, query, new Date());
  if (!report) return toolError("No data yet.");
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
  const users = await buildUserRoster(store, orgId);
  return toolJson({ users });
}

async function callTool(store: HubStore, name: string, args: Record<string, unknown> | undefined) {
  const invalid = invalidArgShape(args);
  if (invalid) return toolError(invalid);

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
