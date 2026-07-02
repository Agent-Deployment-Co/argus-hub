# Running Argus Hub with Docker

This covers building, running, configuring, and operating Argus Hub as a container. For
general product docs (connecting clients, API keys, dashboard), see [README.md](README.md).

---

## Image

Build it:

```bash
docker build -t argus-hub .
```

The image listens on port `4343` and writes its SQLite database under `/data` (set via
`HUB_DATA_DIR`, baked into the image as an `ENV` default).

---

## Pull the prebuilt image

CI publishes multi-arch (`linux/amd64`, `linux/arm64`) images to GitHub Container Registry on
every push, so you usually don't need to build locally:

```bash
docker pull ghcr.io/agent-deployment-co/argus-hub:latest
```

The package is public — no `docker login` needed to pull. See the
[package page](https://github.com/Agent-Deployment-Co/argus-hub/pkgs/container/argus-hub) for
the full tag list. Available tag schemes:

| Tag | Example | Meaning |
|-----|---------|---------|
| `latest` | `latest` | Most recent build of the default branch |
| `<version>` | `0.1.15` | Matches the `version` in `package.json` for that release |
| `sha-<commit>` | `sha-8f0da31` | Pinned to an exact commit, for reproducible deploys |

Prefer pinning to a `<version>` or `sha-<commit>` tag in anything beyond local testing —
`latest` will move out from under you.

---

## Quick start

Using the prebuilt image:

```bash
docker run -d \
  --name argus-hub \
  -p 4343:4343 \
  -v argus-hub-data:/data \
  ghcr.io/agent-deployment-co/argus-hub:latest
```

Or build locally instead of pulling:

```bash
docker run -d \
  --name argus-hub \
  -p 4343:4343 \
  -v argus-hub-data:/data \
  argus-hub
```

On first startup Hub generates an admin password and an API key and prints them once to
stdout. Retrieve them before they scroll out of your log buffer:

```bash
docker logs argus-hub 2>&1 | grep -E "Hub API key|Admin password"
```

If you lose them: the admin password can be pinned via `ADMIN_PASSWORD` (see below); the API
key lives in `hub.db` and can be inspected/rotated per [README.md § API keys](README.md#api-keys).

---

## Persisting data

`hub.db` lives at `$HUB_DATA_DIR/hub.db`, `/data` by default in the container. **Always mount
a volume there** — without one, all synced session data, users, and API keys are lost when the
container is removed.

```bash
-v argus-hub-data:/data          # named volume (recommended)
-v /srv/argus-hub/data:/data     # or a bind mount to a host path
```

Hub `chmod`s `hub.db` to `0600` on creation. If you bind-mount a host directory, make sure the
container's user (root, by default in this image) can write to it.

---

## Configuration

Hub reads config in this order (highest precedence last): `hub.json` in the working directory →
environment variables → CLI flags. In a container, environment variables are the natural knob.

| Variable | Default | Description |
|----------|---------|-------------|
| `HUB_PORT` | `4343` | Port the server listens on inside the container |
| `HUB_DATA_DIR` | `/data` | Directory for `hub.db` |
| `ADMIN_PASSWORD` | _(generated)_ | Pins the dashboard login password across container restarts. Without it, a new random password is generated — and printed — every time the container starts |
| `HUB_INSECURE_COOKIE_HOSTS` | _(none)_ | Comma-separated hostnames (no port) that receive a non-`Secure` session cookie, for plain-HTTP-only deployments (e.g. a cluster-internal address reachable only over a private network/VPN). **Never** list a host reachable from the public internet |

Pass variables with `-e NAME=value` per flag, or collect them in a file and use `--env-file`:

```bash
docker run -d \
  --name argus-hub \
  -p 4343:4343 \
  -v argus-hub-data:/data \
  --env-file hub.env \
  argus-hub
```

`hub.env`:

```
ADMIN_PASSWORD=change-me
```

If you change `HUB_PORT`, also update the `-p` mapping and the `HEALTHCHECK` will still hit
`localhost:4343` **inside** the container unless you rebuild — the healthcheck URL is baked
into the image, not derived from `HUB_PORT` at runtime. Leave `HUB_PORT` at its default unless
you rebuild the image with a matching `HEALTHCHECK` line.

---

## Docker Compose

`compose.yml`, using the prebuilt GHCR image:

```yaml
services:
  argus-hub:
    image: ghcr.io/agent-deployment-co/argus-hub:latest
    restart: unless-stopped
    ports:
      - "4343:4343"
    environment:
      - ADMIN_PASSWORD=change-me
    volumes:
      - argus-hub-data:/data

volumes:
  argus-hub-data:
```

Swap `image:` for `build: .` to build from source instead of pulling.

```bash
docker compose up -d
docker compose logs -f argus-hub   # grab the admin password / API key on first boot
```

---

## Health checks

The image defines:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4343/healthz || exit 1
```

`GET /healthz` returns a plain `200 ok` with no auth required. Use the same path for Kubernetes
liveness/readiness probes:

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 4343
  initialDelaySeconds: 10
  periodSeconds: 30
```

Check container health directly with `docker inspect --format='{{.State.Health.Status}}' argus-hub`.

---

## Operating behind a reverse proxy / TLS terminator

Hub has no built-in TLS. Run it behind a reverse proxy (nginx, Caddy, Traefik, an ALB, an
ingress controller) that terminates TLS and forwards plain HTTP to the container's port `4343`.
Do not expose the container directly to the internet.

If the proxy path is itself plain HTTP end-to-end (e.g. a Tailscale-only cluster-internal
address, with no TLS anywhere on the path), add that hostname to
`HUB_INSECURE_COOKIE_HOSTS` — otherwise browsers silently drop the session cookie and dashboard
logins won't persist. Only ever list hosts that are *not* reachable from the public internet.

---

## Upgrading

If you're running the prebuilt image, pull the new tag and recreate the container:

```bash
docker pull ghcr.io/agent-deployment-co/argus-hub:latest
docker stop argus-hub && docker rm argus-hub
docker run -d --name argus-hub -p 4343:4343 -v argus-hub-data:/data \
  ghcr.io/agent-deployment-co/argus-hub:latest
```

If you're building from source instead:

```bash
docker pull node:24-slim        # optional: refresh the base layer
docker build -t argus-hub .
docker stop argus-hub && docker rm argus-hub
docker run -d --name argus-hub -p 4343:4343 -v argus-hub-data:/data argus-hub
```

Either way, the volume is untouched, so `hub.db` and its contents survive the upgrade.

---

## Troubleshooting

- **Container exits immediately** — check `docker logs argus-hub`. A common cause is the data
  directory not being writable (bind mount owned by a different UID).
- **Lost the admin password** — set `ADMIN_PASSWORD` and restart the container to pin a known
  value; this does not touch existing session data.
- **Dashboard login doesn't stick over plain HTTP** — see `HUB_INSECURE_COOKIE_HOSTS` above.
- **`sqlite3` errors on startup** — the image recompiles `sqlite3` from source during build
  specifically to avoid glibc mismatches; if you're building on an unusual base or architecture,
  confirm the builder stage's `npm rebuild sqlite3 --build-from-source` step completed without
  errors.
