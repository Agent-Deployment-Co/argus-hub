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
import { parseResolvedQuery, parseUserScope, type QueryGetter } from "./query-params.ts";
import { assembleActivityReport, previousWindow } from "../reporting/activity.ts";

// ---- Shared input schema ------------------------------------------------------------------

const SHARED_PROPERTIES: Record<string, object> = {
  since: { type: "string", description: "ISO date YYYY-MM-DD, inclusive start of the window." },
  until: { type: "string", description: "ISO date YYYY-MM-DD, inclusive end of the window." },
  project: { type: "string", description: "Substring match on project path." },
  source: { type: "string", enum: ["claude", "codex", "gemini", "cowork"], description: "Restrict to one agent source." },
  user: { type: "string", description: "Scope to one userId (omit for the whole org)." },
};

/** Adapt a tool call's JSON args object into the `QueryGetter` the shared parsers expect. */
function argsGetter(args: Record<string, unknown> | undefined): QueryGetter {
  return (key) => {
    const v = args?.[key];
    return typeof v === "string" ? v : undefined;
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

async function callTool(store: HubStore, name: string, args: Record<string, unknown> | undefined) {
  switch (name) {
    case "query_activity":
      return handleQueryActivity(store, args);
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
