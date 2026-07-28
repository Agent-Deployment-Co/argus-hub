# Contributing to Argus Hub

## Setup

Argus Hub is developed with [Bun](https://bun.sh) 1.2 or newer.

```bash
bun install     # required first — `bun test` fails with a misleading
                # "Cannot find package 'sqlite3'" error if you skip this
bun run dev     # dev server
```

## Development commands

```bash
make test       # 179 tests
make typecheck
bun run demo    # seeds a realistic 5-person fake team into .demo/ — the fastest way to see the product
```

## Related docs

- [DOCKER.md](DOCKER.md) — building and running the Docker image
- [DEPLOYMENT.md](DEPLOYMENT.md) — running as a systemd or launchd service
- [docs/snowflake.md](docs/snowflake.md) — the Snowflake export
- [SECURITY.md](SECURITY.md) — reporting a vulnerability
