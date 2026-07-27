---
name: argus-hub-query
description: Query an Argus Hub instance's pooled agent-usage data over MCP — usage/cost trends, task lists, task quality, tool/MCP usage, the user roster, and hub task labels. Use whenever the user asks about team or org-wide agent usage, adoption, cost, task outcomes/frustration, or tool/MCP-server usage that an Argus Hub could answer, or asks to connect Claude Code to an Argus Hub, or wants to list/create/apply hub labels on tasks. Also trigger for "how much are we spending on Claude/Codex", "who's using agents the most", "what are people asking agents to do", "how well is agent work going", "which tools/MCP servers are underused", "label this task", "what labels exist".
allowed-tools: Bash(claude mcp*)
---

# Argus Hub query

Argus Hub pools every developer's `argus sync` data into one org-wide store. This skill queries
that store — and manages hub task labels — via its `/mcp` surface, instead of scraping the
dashboard UI. Every tool here is read-only except `create_label` and `set_task_label`.

## Connecting

Check first whether an `argus-hub` MCP server is already connected — its tools show up directly
as `query_activity`, `query_tasks`, `query_task_quality`, `query_tool_usage`, `query_users`,
`list_labels`, `create_label`, `set_task_label`. If not, ask the user for their Hub URL and admin
password, then:

```bash
claude mcp add --transport http argus-hub <hub-url>/mcp \
  --header "Authorization: Bearer <admin password>"
```

A `401` means a missing or wrong bearer token — the token is the Hub's **admin password**, the
same one that gates the dashboard login. The route is only open with no auth at all when the Hub
itself was started without `ADMIN_PASSWORD` set.

## Tool reference

Four of the five tools share filters: `since`/`until` (ISO date, inclusive), `project` (substring
match), `source` (`claude`/`codex`/`gemini`/`cowork`), `user` (a `userId` — resolve one with
`query_users` first). `since`/`until` default to the last 30 days when omitted.

- **`query_users`** — no args. Returns `{ users: [{ userId, displayName, email, lastSyncMs,
  sessionCount, clientCount, totalTokens, cost }] }`. Always run this first to look up a person's
  `userId` before scoping the other tools to them.
- **`query_activity`** — usage/cost for a window vs. the previous window: totals, a daily series,
  per-user/per-source/per-model rollups. The only tool whose `user` filter has no dashboard-page
  equivalent (the Activity page is always team-wide), so it's the way to get a per-user cost view
  the UI itself doesn't offer.
- **`query_tasks`** — plus `q` (search over description/project), `outcome` (comma list of
  `success|failure|unknown`), `limit`/`offset` (default 50, max 200). Returns a paged
  `{ rows: [{ id, source, sessionId, project, timestampMs, description, outcome, outcomeReason,
  frustration, signals, labels: [{ labelId, name }] }], total, offset, limit,
  counts: { success, failure, unknown } }`.
- **`query_task_quality`** — success/frustration/interrupted rates for a window, an
  outcomes-over-time daily series, quality broken down by user/source/project, and top failure
  signals.
- **`query_tool_usage`** — which tools and MCP servers are actually used, and by how many people:
  `{ byTool, byToolCategory, underused, sharedVsSolo, sourceComparison }`.

Empty-data responses come back as a tool error `"No data yet."` for `query_activity`,
`query_task_quality`, and `query_tool_usage`. `query_tasks` and `query_users` instead return an
empty-shaped payload (`{ rows: [], total: 0, ... }` / `{ users: [] }`) — check for that instead of
an error.

### Hub labels (list / create / apply)

- **`list_labels`** — no args. Returns `{ labels: [{ labelId, name, description, createdAt,
  taskCount }] }`. Call this first to find a `labelId`, or to check whether a label already exists
  before creating one.
- **`create_label`** — `name` (required, unique in the org, case-insensitive), `description`
  (optional). Returns `{ label }`. A duplicate name comes back as a tool error, not a silent
  no-op — check for one before assuming the label was created.
- **`set_task_label`** — `labelId`, `clientId`/`sessionId`/`taskSeq` (from a `query_tasks` row),
  and `applied` (`true` to apply, `false` to remove; defaults to `true`). Returns `{ ok: true }`.
  An unknown `labelId` comes back as a tool error.

## Query recipes

- **"How much is `<name>` using agents?"** → `query_users` to resolve their `userId` → then
  `query_activity` scoped with `user`.
- **"What failed or frustrated people this week?"** → `query_tasks` with `outcome=failure`,
  `since` set to 7 days ago.
- **"Compare Claude vs. Codex adoption/quality"** → call `query_activity` (or
  `query_task_quality`/`query_tool_usage`) once per `source` value and diff the totals.
- **"Which tools or MCP servers are underused?"** → `query_tool_usage`, read `underused` and
  `sharedVsSolo`.
- **"Label this task as `<x>`"** → `list_labels` to check for an existing match; if none,
  `create_label`; then `set_task_label` with the task's `clientId`/`sessionId`/`taskSeq` from the
  `query_tasks` row the user meant.

## Gotchas

Treat the admin password as a shared credential once it's been handed out this way — anyone
holding it can query everyone's activity, tasks, and tool usage, and create labels or relabel
tasks. Don't paste it into chat or logs beyond what's needed to configure the MCP connection.
