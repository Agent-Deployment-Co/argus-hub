# Configuration

Argus Hub reads config from `hub.json`, then environment variables, then CLI flags — highest
precedence last.

| CLI flag | Env var | Config key | Default | Description |
|----------|---------|-----------|---------|-------------|
| `--port` | `HUB_PORT` | `port` | `4343` | Port to listen on |
| `--data-dir` | `HUB_DATA_DIR` | `dataDir` | `./data` | Directory for `hub.db` |
| —        | `HUB_SECRET_KEY` | — | _(optional)_ | Base64 encoding of 32 random bytes; enables and encrypts API-key-based task providers |
| —        | `ADMIN_PASSWORD` | —     | _(random)_ | Dashboard login password (pinned across restarts when set) |
| —        | `HUB_INSECURE_COOKIE_HOSTS` | — | _(none)_ | Comma-separated hostnames (no port) that get a non-`Secure` session cookie, for plain-HTTP-only internal deployments. **Never** list a host reachable from the public internet |

`GET /healthz` always returns `200 ok` unauthenticated, for load balancer / orchestrator health checks.

**Client compatibility:** Argus Hub ingests client store schema versions v10–v23
(`HUB_MIN_CLIENT_SCHEMA_VERSION` / `HUB_MAX_CLIENT_SCHEMA_VERSION`). A client outside that range
gets a `422` with an actionable message — update Argus Hub if the client is newer than Argus Hub supports, or
run `argus index` to migrate if the client's store is older than Argus Hub's minimum.

Example `hub.json`:

```json
{
  "port": 4343,
  "dataDir": "/var/lib/argus-hub"
}
```

There is no `HUB_KEY` setting — API keys live in `hub.db` and are managed there. On first
startup, if the `api_keys` table is empty, Argus Hub generates a `hub-{UUID}` key linked to the
Default org and prints it to stdout.

## Connecting clients

On each developer's machine, point the client at Argus Hub and store the API key in the OS secret
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

With Argus Hub configured, `argus sync` posts a JSON payload of resolved session rows to Argus Hub
instead of the hosted service. No `argus login` / OAuth flow is needed. Argus Hub identifies each
user from the client's latest identity signal — Claude/Codex OAuth email when present, falling
back to `git.user.name` — and folds repeat clients from the same person into a single user
(the underlying table is named `fingerprint`, but that's an implementation detail).

The desktop app (macOS/Windows) offers the same connection under Settings → Argus Hub URL + key, and
uploads on a schedule automatically. From the CLI, `argus run` also syncs on a built-in five-minute
schedule; use `--sync-interval N` to change it or `--no-sync` to disable it and rely on manual
`argus sync` calls.

## Task LLM settings

Administrators can open **Settings → General** to select and configure one of these providers:
Anthropic API, a host command, Google Gemini, OpenAI, or OpenRouter. This connection is reserved for
future organization task-labeling features — nothing in Argus Hub calls it yet beyond the Settings
page's own "Test connection" check. The provider begins blank, and settings, along with encrypted
API keys, are scoped to the current organization. Provider environment variables such as
`OPENAI_API_KEY` are not read.

API keys entered in Settings are encrypted in SQLite with AES-256-GCM using `HUB_SECRET_KEY`.
Back that key up separately from `hub.db`: changing or losing it makes existing provider keys
unreadable, and recovery means restoring the original key or replacing every saved provider key.
Generate one with `openssl rand -base64 32`.

The **Command** provider runs the configured command directly on the Argus Hub host, with the prompt
on stdin and completion on stdout — administrator-controlled remote code execution. Enable it
only when Argus Hub administrators and the configured command are fully trusted.
