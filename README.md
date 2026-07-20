# Argus Hub

Self-hosted server that collects usage data from multiple Argus clients and presents an
org-wide dashboard. It is the on-premise alternative to the hosted `argus-dash` backend.

Each developer runs `argus sync` as usual. Instead of uploading to `argus.agentdeployment.co`,
they point their client at a Hub instance. Hub receives each client's local `argus.db` via a
single `POST /api/sync` endpoint, merges the data into one central database tagged by user, and
serves the same dashboard UI as `argus serve` — extended with a user dimension so you can view
the full org at once or scope any view to a specific person.

Nothing is forwarded anywhere else. Hub runs entirely on your network.

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

On each developer's machine, set two environment variables before running `argus sync`:

```bash
export ARGUS_HUB_URL=http://hub.internal:4343
export ARGUS_HUB_KEY=hub-550e8400-e29b-41d4-a716-446655440000
```

Or add them to `argus.json` in the Argus config directory:

```json
{
  "hub": {
    "url": "http://hub.internal:4343",
    "key": "hub-550e8400-e29b-41d4-a716-446655440000"
  }
}
```

With Hub configured, `argus sync` posts a JSON payload of resolved session rows to Hub
instead of the hosted service. No `argus login` / OAuth flow is needed. Hub identifies each
user from the client's latest fingerprint — Claude/Codex OAuth email when present, falling
back to `git.user.name` — and folds repeat clients from the same person into a single user.

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

Keys are stored in `hub.db`. The printed key is the only time it appears in plain text.

To rotate a key: delete the old row from `api_keys` directly in `hub.db`, then restart Hub. A
new key will be generated and printed on startup if the table is empty.

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

```bash
docker build -t argus-hub .

docker run -d \
  --name argus-hub \
  -p 4343:4343 \
  -v argus-hub-data:/data \
  argus-hub
```

On first startup Hub prints the admin password and API key to stdout — retrieve them with:

```bash
docker logs argus-hub 2>&1 | grep -E "Hub API key|Admin password"
```

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `HUB_PORT` | `4343` | Port inside the container |
| `HUB_DATA_DIR` | `/data` | Directory for `hub.db` |
| `ADMIN_PASSWORD` | _(generated)_ | Pin the dashboard password across restarts |
| `HUB_INSECURE_COOKIE_HOSTS` | _(none)_ | Comma-separated hostnames that skip the `Secure` cookie flag, for plain-HTTP-only deployments. Never use for a publicly reachable host. |

Pass them with `-e NAME=value` or `--env-file hub.env`. The data volume (`/data`) holds `hub.db`; mount a named volume or bind mount there to persist data across container restarts.

**Docker Compose** — save as `compose.yml` and run `docker compose up -d`:

```yaml
services:
  argus-hub:
    build: .
    restart: unless-stopped
    ports:
      - "4343:4343"
    volumes:
      - argus-hub-data:/data

volumes:
  argus-hub-data:
```

Hub exposes `GET /healthz` (plain `200 ok`, no auth) for Docker `HEALTHCHECK` and Kubernetes liveness probes.

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

Open `http://hub.internal:4343` in a browser. The dashboard is the same UI as `argus serve`
with one addition: a **user picker** appears in the filter bar once at least one client has
synced. Use it to scope all views (Activity, Sessions, Projects, Tools, Health) to a single
user, or leave it on "All users" for an org-wide view. The **Users** tab (rail link, visible in
hub mode) shows a per-user summary table — sessions, total tokens, estimated cost, and last-sync
time — sortable by any column.

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
(substring), `source` (`claude`/`codex`/`gemini`/`cowork`), `user` (scope to one userId) — read by
the same query parsing the REST API uses, so an agent's answers can never disagree with what you
see in the UI for the filters the UI itself exposes. `query_task_quality` and `query_tool_usage`'s
`user` filter mirrors the dashboard's per-user page (`/users/$userId`); `query_activity`'s `user`
filter has no dashboard equivalent — the Activity page is always team-wide — so use it to get a
per-user usage/cost view the UI doesn't offer. `query_users` takes no arguments; use it to look up
a `userId` before scoping the other tools to one person.

**Auth** reuses the Hub's existing admin password — no new credential to issue or rotate:

```
Authorization: Bearer <admin password>
```

**Add it to Claude Code:**

```bash
claude mcp add --transport http argus-hub https://hub.internal:4343/mcp \
  --header "Authorization: Bearer <admin password>"
```

Treat the admin password as a shared read credential for the org's pooled data once it's
handed out this way — anyone holding it can query everyone's activity, tasks, and tool usage. The
route is open (no auth required) only when Hub itself is run without `ADMIN_PASSWORD` configured,
matching how `/api/*` behaves in that case.

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
