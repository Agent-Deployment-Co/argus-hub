# Security

## Reporting a vulnerability

Use GitHub's private reporting:
[Report a vulnerability](https://github.com/Agent-Deployment-Co/argus-hub/security/advisories/new).
It's private between you and the maintainers. Please don't open a public issue for something
exploitable.

Tell us what you found, how to reproduce it and what an attacker could do with it. We'll
acknowledge within three business days and keep you updated while we work on it.

## What's in scope

This repository: the Argus Hub server and the dashboard it serves. The Argus client (the
`argus` CLI and desktop app that sync data *to* a Hub) is a separate project with its own
repository and `SECURITY.md`.

Things we care about most, given what Hub touches:

- Anything that lets a request reach `/api/*` or `/mcp` without a valid API key or admin
  session, or that leaks another org's data across the `organizations` boundary.
- Anything that exposes `hub.db` — the full synced session/task history of every user in an
  org — or a task provider's decrypted API key.
- Anything that lets the Command provider (which runs a configured command on the Hub host)
  execute beyond what an administrator configured.
- Anything reachable by another process or machine through the sync/dashboard/MCP HTTP surface.

## What Hub already does

Useful context when judging whether something is a real finding — see also
[README.md § Security](README.md#security) for the full list:

- Two access layers: API keys gate `/api/sync`, the admin password gates the dashboard and
  `/mcp`. `GET /healthz` is the one intentionally unauthenticated route.
- `hub.db` is `chmod 600` on creation and holds resolved usage/task rows, not raw session
  text — client prompt/response text and BYO model API keys never reach Hub.
- Task-provider API keys are encrypted at rest with AES-256-GCM under `HUB_SECRET_KEY`.
- A disabled API key (`is_enabled = 0`) is rejected before the request body is read.

## Supported versions

Fixes go into the next release from `main`. There is no long-term support branch; stay current
rather than pin a version.
