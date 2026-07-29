# Argus Hub

Argus Hub is a self-hosted server that pools session, task, and usage data from a team's
[Argus](https://github.com/Agent-Deployment-Co/argus) clients into one org-wide dashboard. Argus Hub runs entirely on your own network.

Argus Hub is free to self-host, including commercially, and source-available under the Functional
Source License (see [License](#license)), converting to MIT two years after each release.

![The Argus Hub Activity view: sessions, tasks and token usage up top, with activity and cost-by-model trends below.](docs/images/screenshots/activity@1920x1080@2.webp)

## Quick start

**Requirements:** Node.js ≥ 20.17 (or Bun ≥ 1.0).

```bash
export HUB_SECRET_KEY="$(openssl rand -base64 32)" # save this value
npx @agentdeploymentco/argus-hub serve --port 4343
```

`HUB_SECRET_KEY` is optional. Without it, Argus Hub starts with a warning and disables API-key-based
LLM providers. Set it in your deployment's secret manager to enable those providers; it encrypts
task-provider API keys and must remain stable across restarts.

On first startup, Argus Hub creates `data/hub.db`, generates a sync API key and a random admin password, and prints them once:

```
Admin password: 4f2c8a91b7e3d6502a1c9f48de07b3a5
Hub API key (Default): hub-550e8400-e29b-41d4-a716-446655440000
```

Both are only shown at this moment — copy them somewhere safe before scrolling past. The
**API key** authenticates `argus sync` uploads. The **admin password** gates the dashboard
login at `http://localhost:4343/login`. Set `ADMIN_PASSWORD` in the environment to pin it
across restarts; otherwise a fresh random password is generated each launch.

## Configuration

Argus Hub reads config from `hub.json`, then environment variables, then CLI flags — highest
precedence last. See **[docs/configuration.md](docs/configuration.md)** for the full flag/env/config
reference, connecting clients, `hub.json` example, client compatibility notes, and Task LLM settings.

## Running as a service

Docker is the recommended path for anything beyond local testing — see **[DOCKER.md](DOCKER.md)**
for building/pulling the image, environment variables, Compose, health checks, persisting data,
and running behind a reverse proxy:

```bash
docker pull ghcr.io/agent-deployment-co/argus-hub:latest
docker run -d --name argus-hub -p 4343:4343 -v argus-hub-data:/data \
  ghcr.io/agent-deployment-co/argus-hub:latest
docker logs argus-hub 2>&1 | grep -E "Hub API key|Admin password"
```

To run Argus Hub directly on a host instead, see **[DEPLOYMENT.md](DEPLOYMENT.md)** for systemd
(Linux) and launchd (macOS) unit files.

## Features

Argus Hub's dashboard runs in your browser at `http://hub.internal:4343`, the same UI as
`argus serve` with a user/group dimension layered on top:

- **Activity** is the home view: usage and cost over time, org-wide or scoped to a user or group.
- **Tasks** are the things people asked agents to do, each with a judged outcome, frustration and
  interrupted rates, and top failure signals.
- **Tools** shows tool, skill, and MCP server usage across the org.
- **Team** is a per-user summary — sessions, total tokens, estimated cost, last-sync time — with
  optional grouping for reporting.
- **Labels** manages hub-level task labels — distinct from any labels an Argus client applies
  itself — and applies them to tasks from the Tasks tab. A label can also be set to "Apply
  automatically": given a name and description, an LLM (using the org's configured provider)
  classifies the org's most recent tasks and a review wizard lets you confirm its judgment
  before anything is saved. Auto-apply currently covers only that reviewed set — it doesn't yet
  backfill a label across full task history or reclassify new tasks as they arrive.
- **[Export](docs/export.md)** downloads the full dataset as a Snowflake-ready zip.
- **[MCP](docs/MCP.md)** lets an agent query pooled usage data and manage task labels directly.

| Tasks | Tools |
| --- | --- |
| ![The Tasks view: total tasks, success rate, frustration rate and outcome trends over time.](docs/images/screenshots/tasks@1920x1080@2.webp) | ![The Tools view: tools, skills and MCP servers used across the org, and what's going unused.](docs/images/screenshots/tools@1920x1080@2.webp) |

## Contributing

```bash
bun install
bun run dev
make test
make typecheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup details and the full command list.

## Security

- **Two access layers.** API keys gate `/api/sync` uploads; the admin password gates the
  dashboard (via session cookie) and the `/mcp` tools (via bearer token). Put Argus Hub behind a VPN or
  reverse proxy with TLS — do not expose it directly to the internet.
- **`hub.db` is sensitive.** It contains the full session data of every syncing user. Restrict
  filesystem access (Argus Hub chmods it to `0600` on creation) and include it in backups.
- **Back up `HUB_SECRET_KEY` separately.** It is required to decrypt task-provider API keys in
  `hub.db`; losing or changing it requires replacing those keys.
- **The Command provider runs code on the Argus Hub host.** Only trusted administrators should be able
  to configure it, and the Argus Hub admin surface must not be exposed to untrusted users.
- Uploaded payloads are resolved usage rows, session rows (including title/summary), tasks,
  interaction metadata, tool/MCP invocations, and labels — merged directly into `hub.db`. The
  client's raw `argus.db` never leaves the developer's machine. **Not** sent: prompt/response
  text, or any BYO model API keys configured on the client.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

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

Questions? Contact support@agentdeployment.co
