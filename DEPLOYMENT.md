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

## Read-only mode

Add `--read-only` to `ExecStart`/`ProgramArguments` (or set `HUB_READ_ONLY=true` in the unit's
environment) to disable every write — settings, secrets, groups, labels, task-labels, user
updates — and MCP entirely, for a shared/demo instance that should only be viewed. This doesn't
change the admin-password login requirement: if `ADMIN_PASSWORD` is set, reads still require it
exactly as they do today.
