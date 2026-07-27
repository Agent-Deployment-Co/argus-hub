# Argus Hub

Self-hosted server that collects usage data from multiple Argus clients and presents an
org-wide dashboard. It is the on-premises alternative to the hosted `argus-dash` backend.

Each developer runs `argus sync` as usual. Instead of uploading to `argus.agentdeployment.co`,
they point their client at a Hub instance. The client first calls `POST /api/sync/unknown-sessions`
to learn which session IDs Hub is already missing (capped at 10,000 IDs per request), then Hub
receives the usage snapshot — a JSON payload of resolved rows, not the raw `argus.db` file — at
`POST /api/sync`, merges it into one central database tagged by user, and serves the same
dashboard UI as `argus serve` — extended with a user dimension so you can view the full org at
once or scope any view to a specific person.

Nothing is forwarded anywhere else. Hub runs entirely on your network.

**Documentation:** the canonical user-facing docs live at
[argus.agentdeployment.co/argus-hub](https://argus.agentdeployment.co/argus-hub). This README
covers self-hosting Hub itself (deployment, config, security); the hosted page covers connecting
a client to it day-to-day.

---

## Quick start

**Requirements:** Node.js ≥ 20.17 (or Bun ≥ 1.0).

```bash
npx @agentdeploymentco/argus-hub serve --port 4343
```

On first startup, Hub creates `data/hub.db`, generates an API key and a random admin password, and prints them once:

```
Admin password: 4f2c8a91b7e3d6502a1c9f48de07b3a5
Hub API key (Default): hub-550e8400-e29b-41d4-a716-446655440000
```

Both are only shown at this moment — copy them somewhere safe before scrolling past. The
**API key** authenticates `argus sync` uploads. The **admin password** gates the dashboard
login at `http://localhost:4343/login`. Set `ADMIN_PASSWORD` in the environment to pin it
across restarts; otherwise a fresh random password is generated each launch.

---

## Connecting clients

On each developer's machine, point the client at Hub and store the API key in the OS secret
store (never in plaintext config):

```bash
npx @agentdeploymentco/argus config set hub.url http://hub.internal:4343
npx @agentdeploymentco/argus secret set ARGUS_HUB_KEY   # prompts for the key, never touches argus.json
```

To configure a single process instead (e.g. CI, a container), use the environment variable pair:

```bash
export ARGUS_HUB_URL=http://hub.internal:4343
export ARGUS_HUB_KEY=hub-550e8400-e29b-41d4-a716-446655440000
```

Key resolution order is `ARGUS_HUB_KEY` env var → OS secret store → unset. Putting `hub.key`
directly in `argus.json` also still works, but it's a legacy path the client actively migrates
users off of — `hub.key` is marked `secret: true`, and a one-time migration moves any plaintext
key it finds out of `argus.json` and into the secret store. Prefer `secret set` above.

With Hub configured, `argus sync` posts a JSON payload of resolved session rows to Hub
instead of the hosted service. No `argus login` / OAuth flow is needed. Hub identifies each
user from the client's latest identity signal — Claude/Codex OAuth email when present, falling
back to `git.user.name` — and folds repeat clients from the same person into a single user
(the underlying table is named `fingerprint`, but that's an implementation detail).

The desktop app (macOS/Windows) offers the same connection under Settings → Hub URL + key, and
uploads on a schedule automatically. From the CLI, `argus run` also syncs on a built-in five-minute
schedule; use `--sync-interval N` to change it or `--no-sync` to disable it and rely on manual
`argus sync` calls.

---

## Configuration

Hub reads config from `hub.json` in the current directory, then environment variables, then
CLI flags — highest precedence last.

| CLI flag | Env var | Config key | Default | Description |
|----------|---------|-----------|---------|-------------|
| `--port` | `HUB_PORT` | `port` | `4343` | Port to listen on |
| `--data-dir` | `HUB_DATA_DIR` | `dataDir` | `./data` | Directory for `hub.db` |
| —        | `ADMIN_PASSWORD` | —     | _(random)_ | Dashboard login password (pinned across restarts when set) |
| —        | `HUB_INSECURE_COOKIE_HOSTS` | — | _(none)_ | Comma-separated hostnames (no port) that get a non-`Secure` session cookie, for plain-HTTP-only deployments (e.g. a cluster-internal address reachable only via a private network). **Never** list a host reachable from the public internet. |

`GET /healthz` is always unauthenticated and returns `200 ok` — the one route that intentionally
bypasses both API-key and admin-password auth, for load balancer / orchestrator health checks.

**Client compatibility:** Hub ingests client store schema versions v10–v23
(`HUB_MIN_CLIENT_SCHEMA_VERSION` / `HUB_MAX_CLIENT_SCHEMA_VERSION`). A client outside that range
gets a `422` with an actionable message — update Hub if the client is newer than Hub supports, or
run `argus index` to migrate if the client's store is older than Hub's minimum.

Example `hub.json`:

```json
{
  "port": 4343,
  "dataDir": "/var/lib/argus-hub"
}
```

There is no `HUB_KEY` setting. API keys are stored in `hub.db` and managed there. On first
startup, if the `api_keys` table is empty, Hub generates a `hub-{UUID}` key linked to the
Default org and prints it to stdout.

---

## API keys

Keys are stored in `hub.db` **hashed** (`key_hash`, via `hashApiKey()`) — the printed key is the
only time the plaintext value exists anywhere.

To rotate a key: delete the old row from `api_keys` directly in `hub.db`, then restart Hub. A
new key will be generated and printed on startup if the table is now empty. Disabling a key
(below) instead of deleting it does **not** trigger a new key on restart — Hub only mints one
when the `api_keys` table has no rows at all.

To disable a key without deleting it (e.g. while rotating), set `is_enabled = 0` in `hub.db`.
Hub rejects disabled keys with `401` before reading the request body.

---

## Running as a service

### systemd (Linux)

Save as `/etc/systemd/system/argus-hub.service`:

```ini
[Unit]
Description=Argus Hub
After=network.target

[Service]
Type=simple
ExecStart=npx @agentdeploymentco/argus-hub serve --port 4343
WorkingDirectory=/srv/argus-hub
Environment=HUB_DATA_DIR=/srv/argus-hub/data
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now argus-hub
sudo journalctl -fu argus-hub    # follow logs
```

### Docker

A public multi-arch image is published to GHCR — no `docker login` needed to pull it:

```bash
docker pull ghcr.io/agent-deployment-co/argus-hub:latest

docker run -d \
  --name argus-hub \
  -p 4343:4343 \
  -v argus-hub-data:/data \
  ghcr.io/agent-deployment-co/argus-hub:latest
```

To build from source instead:

```bash
docker build -t argus-hub .
docker run -d --name argus-hub -p 4343:4343 -v argus-hub-data:/data argus-hub
```

On first startup Hub prints the admin password and API key to stdout — retrieve them with:

```bash
docker logs argus-hub 2>&1 | grep -E "Hub API key|Admin password"
```

See **[DOCKER.md](DOCKER.md)** for environment variables, Docker Compose, health checks,
persisting data, and running behind a reverse proxy.

---

### launchd (macOS)

Save as `~/Library/LaunchAgents/co.agentdeployment.argus-hub.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>co.agentdeployment.argus-hub</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/npx</string>
    <string>@agentdeploymentco/argus-hub</string>
    <string>serve</string>
    <string>--port</string>
    <string>4343</string>
  </array>
  <key>WorkingDirectory</key>  <string>/Users/you/argus-hub</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HUB_DATA_DIR</key>   <string>/Users/you/argus-hub/data</string>
  </dict>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>         <true/>
  <key>StandardOutPath</key>   <string>/Users/you/argus-hub/hub.log</string>
  <key>StandardErrorPath</key> <string>/Users/you/argus-hub/hub.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/co.agentdeployment.argus-hub.plist
```

---

## Dashboard

Open `http://hub.internal:4343` in a browser. The dashboard is the same UI as `argus serve` with
a user/group dimension layered on top. The rail links to:

| Tab | Path | Shows |
|-----|------|-------|
| Activity | `/` | Usage/cost over time, org-wide or scoped |
| Tasks | `/tasks` | Extracted tasks — outcomes, frustration/interrupted rates, failure signals |
| Tools | `/tools` | Tool and MCP server usage |
| Team | `/users` | Per-user summary table — sessions, total tokens, estimated cost, last-sync time — sortable by any column |
| Export | `/export` | Download the full dataset as a Snowflake-ready zip (see [Export to Snowflake](#export-to-snowflake)) |

There's also a per-user activity view at `/users/$userId`, reached by clicking a row in Team.

A combined user/group scope dropdown in the filter bar (visible once at least one client has
synced) scopes Activity, Tasks, and Tools to a single user or group, or "All" for an org-wide
view.

### Groups

Users can be organized into groups for reporting:

- Full CRUD: `GET/POST /api/groups`, `PATCH/DELETE /api/groups/:groupId`
- Bulk membership changes: `POST/DELETE /api/groups/:groupId/members`
- Per-user assignment: `PATCH /api/users/:userId` with `{"groupId": "..."}`
- UI: the group picker and combined user/group scope dropdown in the filter bar

Deleting a group **ungroups** its members rather than deleting them — `groupId` is nulled on
each affected user, the users themselves are untouched.

---

## Query the Hub from an agent (MCP)

Hub exposes a small, read-only [MCP](https://modelcontextprotocol.io) surface at `POST /mcp` so an
agent — Claude Code, or any other MCP client — can query an org's pooled Argus data directly,
instead of scraping the dashboard. It's the same stateless Streamable HTTP transport as any other
MCP server; no session, no subprocess, just JSON-RPC over HTTPS.

**Tools:**

| Tool | Answers |
|------|---------|
| `query_activity` | How much are we using agents, by whom, trending how (usage/cost over a window, vs. the previous window) |
| `query_tasks` | What did people ask agents to do — a paged, filterable list of extracted tasks |
| `query_task_quality` | How *well* is agent work going — success/frustration/interrupted rates, outcomes over time, top failure signals |
| `query_tool_usage` | Which tools and MCP servers are actually being used, and by how many people |
| `query_users` | The org's user roster — userId, display name, email, last-sync, sessions, tokens, cost |

The first four take the same optional filters — `since`/`until` (ISO dates), `project`
(substring), `source` (`claude`/`codex`/`gemini`/`cowork`), `user` (scope to one userId), and
`group` (scope to one groupId, or `__none__` for users with no group assigned) — read by the
same query parsing the REST API uses, so an agent's answers can never disagree with what you
see in the UI for the filters the UI itself exposes. `query_task_quality` and `query_tool_usage`'s
`user` filter mirrors the dashboard's per-user page (`/users/$userId`); `query_activity`'s `user`
filter has no dashboard equivalent — the Activity page is always team-wide — so use it to get a
per-user usage/cost view the UI doesn't offer.

`query_tasks` additionally takes `q` (search over task description/project), `outcome` (comma
list of `success`/`failure`/`unknown`), `limit` (default 50, max 200), and `offset`, for paging
through the task list.

`query_users` takes an optional `group` filter (matches groupId or groupName, case-insensitively)
instead of the shared filter set; use it to look up a `userId` before scoping the other tools to
one person.

**Auth** reuses the Hub's existing admin password — no new credential to issue or rotate:

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
route is open (no auth required) only when Hub itself is run without `ADMIN_PASSWORD` configured,
matching how `/api/*` behaves in that case.

---

## Export to Snowflake

`argus-hub export snowflake` creates a consistent Snowflake-ready snapshot of the live Hub
database. Add `--load` to upload it with the built-in Snowflake connector, or use the generated
JSONL files and `load.sql` for a manual or externally scheduled load.

See [Export Argus Hub data to Snowflake](docs/snowflake.md) for data coverage, one-time role and
schema setup, authentication, scheduling, and limitations.

---

## Security

- **Two access layers.** API keys gate `/api/sync` uploads; the admin password gates the
  dashboard (via session cookie) and the `/mcp` tools (via bearer token). Put Hub behind a VPN or
  reverse proxy with TLS — do not expose it directly to the internet.
- **`hub.db` is sensitive.** It contains the full session data of every syncing user. Restrict
  filesystem access (Hub chmods it to `0600` on creation) and include it in backups.
- Uploaded payloads are JSON rows merged directly into `hub.db`; the client's raw `argus.db`
  never leaves the developer's machine.
- A disabled key (`is_enabled = 0`) is rejected immediately without reading the request body.

---

## Architecture

```
argus clients  ──POST /api/sync──►  Hub ingest  ──►  hub.db
(argus sync)      JSON {schemaVersion,            resolved_* + org_id + user_id
                  rows, fingerprint}              (auto-mapped from OAuth email)

hub.db  ──►  GET /api/snapshot, /api/sessions, /api/session/:id,
         ──►       /api/users, /api/user/:id, /api/clients
         ──►  React SPA  (user picker · Users tab · per-user filter on all views)
```

Hub supports multiple orgs via the `organizations` table — each API key is scoped to one org.
For strict isolation between unrelated tenants, run separate Hub instances.

---

## License

Argus Hub is licensed under the **Functional Source License 1.1 (FSL-1.1)**, converting to **MIT** after two years.

### What you can do

- Use Argus Hub freely for personal, internal, or commercial purposes
- Modify the source code and build on top of it
- Distribute copies or derivatives
- Incorporate Argus Hub into a larger product or service

### What you cannot do (for two years from each release)

Run a **paid hosted service** where the primary thing you're selling is essentially "Argus Hub as a service" — i.e., a product whose core value is auditing or reporting on AI agent usage, built on this codebase.

If you're building a dev-tooling platform, an IDE extension, or a larger product where agent-usage stats are one small feature among many, that's fine.

### After two years

Each released version automatically becomes **MIT-licensed** two years after it was first published. At that point, all restrictions lift and you can do anything MIT allows.

### In short

Free to use and build with. Don't resell it as a hosted Argus Hub clone. After two years, do whatever you want.

---

Questions? Contact support@agentdeployment.co
