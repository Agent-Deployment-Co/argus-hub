# Running Argus Hub as a service

This covers running Hub directly on a host with systemd or launchd. For containers, see
[DOCKER.md](DOCKER.md) instead — it's the more complete option (health checks, Compose,
upgrades) and the recommended path for anything beyond a quick local test.

---

## systemd (Linux)

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
EnvironmentFile=/etc/argus-hub.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Create `/etc/argus-hub.env` with `HUB_SECRET_KEY=<output of openssl rand -base64 32>`, restrict
it to the service administrator, and include it in the deployment's secret backup.

```bash
sudo systemctl enable --now argus-hub
sudo journalctl -fu argus-hub    # follow logs
```

---

## launchd (macOS)

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
    <key>HUB_SECRET_KEY</key> <string>REPLACE_WITH_BASE64_32_BYTE_KEY</string>
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

## Binding to a specific address

By default Hub listens on all interfaces. Add `--bind 127.0.0.1` (or set `HUB_BIND=127.0.0.1`) to
listen on loopback only — for a deployment that should only be reachable through a reverse proxy
or tunnel running on the same host, without relying on a host firewall rule to keep the port off
the public interface.

---

## Read-only mode

Add `--read-only` to `ExecStart`/`ProgramArguments` (or set `HUB_READ_ONLY=true` in the unit's
environment) to disable every write — settings, secrets, groups, labels, task-labels, user
updates — for a shared/demo instance that should only be viewed. MCP stays mounted, but its two
write tools (`create_label`, `set_task_label`) are hidden/rejected too; use `--no-mcp` below to
disable MCP entirely instead. This doesn't change the admin-password login requirement: if
`ADMIN_PASSWORD` is set, reads still require it exactly as they do today.

---

## No-password mode

Add `--no-password` (or set `HUB_NO_PASSWORD=true`) to remove the admin-password login
requirement entirely: `/login` and `/logout` aren't mounted, every route is open, and the SPA
hides the sign-out button. The server prints a warning to stderr at startup as a reminder. Only
use this on a network you trust (e.g. behind a VPN/Tailscale, or `localhost`-only) — anyone who
can reach the port can view and change all data. It composes with `--read-only` if you want an
open, view-only instance.

---

## Disabling MCP

Add `--no-mcp` (or set `HUB_NO_MCP=true`) to turn off the MCP server entirely — `/mcp` is not
mounted at all. This is independent of `--read-only`, which only hides MCP's two write tools
rather than disabling the whole surface; use `--no-mcp` for deployments that want to remove
programmatic access entirely regardless of whether writes are otherwise enabled.

---

## Disabling export

Add `--no-export` (or set `HUB_NO_EXPORT=true`) to turn off the dataset export surface —
`GET /api/export` is not mounted and the SPA hides the Export nav item. Independent of
`--read-only` and `--no-mcp`.
