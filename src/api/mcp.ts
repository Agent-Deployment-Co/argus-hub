// MCP (Model Context Protocol) surface for the Hub — query tools so external clients (Claude
// Code, other agents) can ask the same questions the web dashboard answers, plus a small set of
// hub-label writes, all in-process against the same HubStore + reporting builders. See
// MCP_PLAN.md for the design (the four query_* tools; labels came later, see the note there).

import type { Hono } from "hono";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { DuplicateLabelNameError, LabelNotFoundError, type HubStore } from "../store/hub-store.ts";
import type { AdminAuth } from "../admin-auth.ts";
import { parseBearerToken } from "./sync.ts";
import { VERSION } from "../version.ts";
import {
  parseResolvedQuery, parseUserScope, parseGroupScope, parseGroupIdScope, parseOutcomeFilter,
  parseIntOr, DEFAULT_LIMIT, MAX_LIMIT, VALID_SOURCES, UNGROUPED_SENTINEL, type QueryGetter,
} from "./query-params.ts";
import { buildActivityReport, buildTaskQualityReport, buildUserRoster } from "./reports.ts";
import { assembleDashboard } from "../reporting/snapshot.ts";
import { loadPlugins } from "../reporting/inventory.ts";
import { buildTaskList, type TaskListParams } from "./task-list.ts";
import { attachLabels, parseTaskRef } from "./task-labels.ts";

// ---- Shared input schema ------------------------------------------------------------------

const SHARED_PROPERTIES: Record<string, object> = {
  since: { type: "string", description: "ISO date YYYY-MM-DD, inclusive start of the window." },
  until: { type: "string", description: "ISO date YYYY-MM-DD, inclusive end of the window." },
  project: { type: "string", description: "Substring match on project path." },
  source: { type: "string", enum: [...VALID_SOURCES], description: "Restrict to one agent source." },
  user: { type: "string", description: "Scope to one userId (omit for the whole org)." },
  group: {
    type: "string",
    description:
      `Scope to one groupId, or "${UNGROUPED_SENTINEL}" for users with no group assigned ` +
      "(omit for all groups).",
  },
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

/** Every arg value the query tools read (via `argsGetter`) is a `string` or `number`; the label
 *  write tools additionally accept a `boolean` (`set_task_label`'s `applied`). Anything else
 *  (array, object) would otherwise be silently read back as "filter omitted" instead of the
 *  caller's mistake it actually is. Reject those up front so a dropped filter surfaces as a tool
 *  error rather than a query that quietly ignores it. */
function invalidArgShape(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const [key, v] of Object.entries(args)) {
    if (v !== undefined && v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      return `Invalid value for "${key}": expected a string, number, or boolean.`;
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
      "client counts, groupId/groupName, total tokens, and total cost. Use this to discover valid " +
      "`user` ids before scoping the other tools to one person, or pass `group` to filter the " +
      "roster to one group (matches groupId or groupName).",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "Filter to one group — matches groupId or groupName." },
      },
    },
  },
  {
    name: "list_labels",
    description:
      "List every hub label defined for the org — labelId, name, optional description, and its " +
      "current applied-task count. Use this to discover a labelId before calling create_label or " +
      "set_task_label.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_label",
    description:
      "Create a new hub label that can be applied to tasks via set_task_label. Fails with a tool " +
      "error if a label with the same name (case-insensitive) already exists in the org.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Label name; must be unique within the org (case-insensitive)." },
        description: { type: "string", description: "Optional description of what the label means." },
      },
      required: ["name"],
    },
  },
  {
    name: "set_task_label",
    description:
      "Apply or remove one hub label on one task. Identify the task with the clientId/sessionId/" +
      "taskSeq from a query_tasks row, and the label with a labelId from list_labels or " +
      "create_label. Pass applied:false to remove; omit (or true) to apply.",
    inputSchema: {
      type: "object",
      properties: {
        labelId: { type: "string", description: "The label's id, from list_labels or create_label." },
        clientId: { type: "string", description: "The task's clientId, from a query_tasks row." },
        sessionId: { type: "string", description: "The task's sessionId, from a query_tasks row." },
        taskSeq: { type: "number", description: "The task's taskSeq, from a query_tasks row." },
        applied: { type: "boolean", description: "true to apply the label (default), false to remove it." },
      },
      required: ["labelId", "clientId", "sessionId", "taskSeq"],
    },
  },
];

async function handleQueryActivity(store: HubStore, args: Record<string, unknown> | undefined) {
  const get = argsGetter(args);
  const orgId = await store.getDefaultOrgId();
  if (!orgId) return toolError("No data yet.");

  const query = parseResolvedQuery(get);
  if (typeof query === "string") return toolError(query);

  const userId = parseUserScope(get);
  const groupId = parseGroupIdScope(get);
  const report = await buildActivityReport(store, { orgId, userId, groupId }, query, new Date());
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
  const groupId = parseGroupIdScope(get);
  const taskRows = await store.readTaskFacts({ orgId, userId, groupId }, query);

  const params: TaskListParams = {
    limit: Math.min(MAX_LIMIT, Math.max(1, parseIntOr(get("limit"), DEFAULT_LIMIT))),
    offset: Math.max(0, parseIntOr(get("offset"), 0)),
    q: get("q") || undefined,
    outcomes,
  };
  const result = buildTaskList(taskRows, params);
  const labelsByKey = await store.listLabelsForTasks(
    orgId,
    result.rows.map((r) => ({ clientId: r.clientId, sessionId: r.sessionId, taskSeq: r.taskSeq })),
  );
  attachLabels(result.rows, labelsByKey);
  return toolJson(result);
}

async function handleQueryTaskQuality(store: HubStore, args: Record<string, unknown> | undefined) {
  const get = argsGetter(args);
  const orgId = await store.getDefaultOrgId();
  if (!orgId) return toolError("No data yet.");

  const query = parseResolvedQuery(get);
  if (typeof query === "string") return toolError(query);

  const userId = parseUserScope(get);
  const groupId = parseGroupIdScope(get);
  const report = await buildTaskQualityReport(store, { orgId, userId, groupId }, query, new Date());
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
  const groupId = parseGroupIdScope(get);
  const aggregates = await store.readDashboardAggregates({ orgId, userId, groupId }, query);
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

async function handleListUsers(store: HubStore, args: Record<string, unknown> | undefined) {
  const get = argsGetter(args);
  const group = parseGroupScope(get);

  const orgId = await store.getDefaultOrgId();
  let users = await buildUserRoster(store, orgId);
  if (group) {
    users = users.filter((u) => u.groupId === group || u.groupName?.toLowerCase() === group.toLowerCase());
  }
  return toolJson({ users });
}

async function handleListLabels(store: HubStore) {
  const orgId = await store.getDefaultOrgId();
  if (!orgId) return toolJson({ labels: [] });
  const labels = await store.listLabels(orgId);
  return toolJson({ labels });
}

async function handleCreateLabel(store: HubStore, args: Record<string, unknown> | undefined) {
  const orgId = await store.getDefaultOrgId();
  if (!orgId) return toolError("No org configured.");

  const name = typeof args?.name === "string" ? args.name.trim() : "";
  if (!name) return toolError('Missing required "name".');
  const description = typeof args?.description === "string" && args.description.trim() ? args.description.trim() : null;

  try {
    const label = await store.createLabel(orgId, name, description);
    return toolJson({ label });
  } catch (err) {
    if (err instanceof DuplicateLabelNameError) return toolError(err.message);
    throw err;
  }
}

async function handleSetTaskLabel(store: HubStore, args: Record<string, unknown> | undefined) {
  const orgId = await store.getDefaultOrgId();
  if (!orgId) return toolError("No org configured.");

  const labelId = typeof args?.labelId === "string" ? args.labelId : "";
  if (!labelId) return toolError('Missing required "labelId".');
  const applied = args?.applied !== false;
  const ref = parseTaskRef(args ?? {});
  if (!ref) return toolError('Missing or invalid "clientId"/"sessionId"/"taskSeq".');

  try {
    await store.setTaskLabel(orgId, ref, labelId, applied);
  } catch (err) {
    if (err instanceof LabelNotFoundError) return toolError(err.message);
    throw err;
  }
  return toolJson({ ok: true });
}

/** Tool names that mutate the store — excluded from `tools/list` and rejected by name in
 *  read-only mode, same as the `writes` sub-router does for the HTTP API (see createHubApp in
 *  serve.ts). MCP's query_* / list_labels tools are pure reads and unaffected. */
const WRITE_TOOLS = new Set(["create_label", "set_task_label"]);

async function callTool(
  store: HubStore,
  name: string,
  args: Record<string, unknown> | undefined,
  readOnly: boolean,
) {
  if (readOnly && WRITE_TOOLS.has(name)) {
    return toolError(`Tool "${name}" is unavailable: this Hub instance is read-only.`);
  }

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
      return handleListUsers(store, args);
    case "list_labels":
      return handleListLabels(store);
    case "create_label":
      return handleCreateLabel(store, args);
    case "set_task_label":
      return handleSetTaskLabel(store, args);
    default:
      return toolError(`Unknown tool "${name}".`);
  }
}

// ---- Server + Hono wiring -------------------------------------------------------------------

function buildMcpServer(store: HubStore, readOnly: boolean): Server {
  const server = new Server({ name: "argus-hub", version: VERSION }, { capabilities: { tools: {} } });
  const tools = readOnly ? TOOLS.filter((t) => !WRITE_TOOLS.has(t.name)) : TOOLS;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return callTool(store, name, args as Record<string, unknown> | undefined, readOnly);
  });

  return server;
}

/** Mount the MCP surface at `POST/GET /mcp` — the query_* report tools plus hub-label
 *  reads/writes (list_labels, create_label, set_task_label). Stateless Streamable HTTP transport —
 *  one JSON-RPC exchange per HTTP request, no session id. Auth reuses the admin password as a
 *  bearer token (same secret that unlocks the dashboard); the route is open when `auth` is
 *  omitted, matching how `/api/*` behaves without auth configured.
 *
 *  `readOnly` hides/rejects `create_label` and `set_task_label` (see `WRITE_TOOLS`) — the rest of
 *  MCP's tools are pure reads and stay available, same as read-only mode leaves the rest of the
 *  HTTP API's reads mounted. */
export function mountMcp(app: Hono, store: HubStore, auth?: AdminAuth, readOnly = false): void {
  app.use("/mcp", async (c, next) => {
    if (!auth) return next();
    const token = parseBearerToken(c.req.header("Authorization"));
    if (!token || token !== auth.password) {
      return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized." }, id: null }, 401);
    }
    return next();
  });

  app.all("/mcp", async (c) => {
    const server = buildMcpServer(store, readOnly);
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
