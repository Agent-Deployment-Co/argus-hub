# Query Argus Hub from an agent (MCP)

Argus Hub exposes a small [MCP](https://modelcontextprotocol.io) surface at `POST /mcp` — the same
stateless Streamable HTTP transport as any other MCP server — so an agent can query an org's
pooled Argus data directly instead of scraping the dashboard, and manage hub labels on tasks.

| Tool | Answers |
|------|---------|
| `query_activity` | How much are we using agents, by whom, trending how (usage/cost over a window, vs. the previous window) |
| `query_tasks` | What did people ask agents to do — a paged, filterable list of extracted tasks, each with its applied hub labels |
| `query_task_quality` | How *well* is agent work going — success/frustration/interrupted rates, outcomes over time, top failure signals |
| `query_tool_usage` | Which tools and MCP servers are actually being used, and by how many people |
| `query_users` | The org's user roster — userId, display name, email, last-sync, sessions, tokens, cost |
| `list_labels` | Every hub label defined for the org — labelId, name, description, applied-task count |
| `create_label` | Create a new hub label (name + optional description) |
| `set_task_label` | Apply or remove one hub label on one task (by clientId/sessionId/taskSeq from a `query_tasks` row) |

The first four share one optional filter set: `since`/`until` (ISO dates), `project`
(substring), `source` (`claude`/`codex`/`gemini`/`cowork`), `user` (scope to one userId), and
`group` (scope to one groupId, or `__none__` for users with no group). It's the same filter
parsing the REST API uses, so an agent's answers can't disagree with the dashboard for filters
the UI itself exposes. `query_task_quality` and `query_tool_usage`'s `user` filter mirrors the
per-user dashboard page; `query_activity`'s `user` filter has no dashboard equivalent (Activity
is always team-wide there), so it's the only way to get a per-user usage/cost view.

`query_tasks` adds `q` (search over task description/project), `outcome` (comma list of
`success`/`failure`/`unknown`), `limit` (default 50, max 200), and `offset`.

`query_users` takes an optional `group` filter (matches groupId or groupName) instead of the
shared filter set — use it to look up a `userId` before scoping other tools to one person.

`list_labels`, `create_label`, and `set_task_label` skip the shared filter set: `create_label`
takes `name` (required, unique per org) and an optional `description`; `set_task_label` takes
`labelId`, `clientId`/`sessionId`/`taskSeq` (from a `query_tasks` row), and `applied` (default
`true`).

**Auth** reuses Argus Hub's existing admin password — no new credential to issue or rotate:

```
Authorization: Bearer <admin password>
```

**Add it to Claude Code:**

```bash
claude mcp add --transport http argus-hub https://hub.internal:4343/mcp \
  --header "Authorization: Bearer <admin password>"
```

A Claude Code skill packaging this reference — connecting, the tools' filters/response shapes,
and common query recipes — lives at `.claude/skills/argus-hub-query/` in this repo.

Treat the admin password as a shared read credential for the org's pooled data once it's
handed out this way — anyone holding it can query everyone's activity, tasks, and tool usage. The
route is open (no auth required) only when Argus Hub itself is run without `ADMIN_PASSWORD` configured,
matching how `/api/*` behaves in that case.
