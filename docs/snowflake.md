# Export Argus Hub data to Snowflake

Argus Hub can export a transactionally consistent snapshot of a running Hub database to
Snowflake-ready JSON Lines files. It can then either load the files directly with Snowflake's
Node.js driver or leave a bundle for review and manual loading.

The export is a full snapshot, not an incremental feed. During a direct load, Hub uploads each
table into a temporary Snowflake table and only replaces the reporting tables after every upload
has succeeded. The replacement is one transaction, so a failed load leaves the previous data in
place.

## Data included

| Area | Snowflake tables | Contents |
|---|---|---|
| Organization | `ORGANIZATIONS`, `GROUPS`, `USERS` | Org, group, user, display-name, and email mappings |
| Clients | `CLIENTS`, `CLIENT_FINGERPRINT`, `CLIENT_SYNCS` | Client-to-user mapping, fingerprint observations, and last sync time |
| Sessions | `RESOLVED_SESSIONS`, `RESOLVED_SESSION_LABELS` | Session metadata, prompts, friction signals, summaries, and applied labels |
| Activity | `RESOLVED_USAGE` | Token usage, model attribution, dates, and raw usage records |
| Work | `RESOLVED_TASKS`, `RESOLVED_INTERACTIONS` | Extracted tasks, outcomes, and raw task/interaction records |
| Tools | `RESOLVED_INVOCATIONS` | Tool, MCP, skill, file-path, argument, and result-size observations |

The `api_keys` table is deliberately excluded, including its key hashes. JSON payload columns
such as `META_JSON`, `RECORD_JSON`, and `TASK_JSON` are loaded as Snowflake `VARIANT`; epoch
timestamps remain `NUMBER(38, 0)` so their original millisecond values are preserved.

## One-time Snowflake setup

Create the database, schema, warehouse, and loader role with an administrative role. Adapt the
object names to your environment:

```sql
USE ROLE SYSADMIN;

CREATE DATABASE IF NOT EXISTS ANALYTICS;
CREATE SCHEMA IF NOT EXISTS ANALYTICS.ARGUS_HUB;
CREATE WAREHOUSE IF NOT EXISTS ARGUS_LOAD_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE;

USE ROLE SECURITYADMIN;

CREATE ROLE IF NOT EXISTS ARGUS_HUB_LOADER;
GRANT USAGE ON DATABASE ANALYTICS TO ROLE ARGUS_HUB_LOADER;
GRANT USAGE ON SCHEMA ANALYTICS.ARGUS_HUB TO ROLE ARGUS_HUB_LOADER;
GRANT CREATE TABLE ON SCHEMA ANALYTICS.ARGUS_HUB TO ROLE ARGUS_HUB_LOADER;
GRANT USAGE ON WAREHOUSE ARGUS_LOAD_WH TO ROLE ARGUS_HUB_LOADER;
GRANT ROLE ARGUS_HUB_LOADER TO USER ARGUS_LOADER;
```

The loader role creates and owns the target tables on its first run. If those tables already
exist under a different owner, transfer ownership to the loader role or grant a role that owns
them; the connector needs to add newly introduced columns and replace their rows.

Snowflake documents these privileges in its
[access-control privilege reference](https://docs.snowflake.com/en/user-guide/security-access-control-privileges)
and recommends service-oriented authentication instead of interactive credentials for unattended
jobs.

## Direct connector

The recommended unattended configuration is
[key-pair authentication](https://docs.snowflake.com/en/user-guide/key-pair-auth). Store the private
key outside the Hub data directory and restrict its file permissions.

```bash
export SNOWFLAKE_ACCOUNT=myorg-myaccount
export SNOWFLAKE_USER=ARGUS_LOADER
export SNOWFLAKE_DATABASE=ANALYTICS
export SNOWFLAKE_SCHEMA=ARGUS_HUB
export SNOWFLAKE_WAREHOUSE=ARGUS_LOAD_WH
export SNOWFLAKE_ROLE=ARGUS_HUB_LOADER
export SNOWFLAKE_PRIVATE_KEY_PATH=/etc/argus-hub/snowflake-key.p8
export SNOWFLAKE_PRIVATE_KEY_PASSPHRASE='key passphrase, if encrypted'

npx @agentdeploymentco/argus-hub export snowflake \
  --data-dir /var/lib/argus-hub \
  --load \
  --authenticator SNOWFLAKE_JWT
```

The connector uses Snowflake's official
[Node.js driver](https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver). It creates a
private temporary export directory, runs `PUT` and `COPY INTO` for each non-empty table, commits
the complete replacement, and deletes the local temporary files. Pass `--output-dir PATH` if you
need to retain the bundle for auditing; the path must not already exist.

Other supported authentication modes are:

| Mode | Configuration |
|---|---|
| Password | Set `SNOWFLAKE_PASSWORD`; `SNOWFLAKE` is the default authenticator |
| Programmatic access token | Set `SNOWFLAKE_TOKEN` and pass `--authenticator PROGRAMMATIC_ACCESS_TOKEN` |
| Browser SSO | Pass `--authenticator EXTERNALBROWSER`; suitable only for an interactive run |

Passwords, tokens, and key passphrases are environment-only; the CLI intentionally provides no
flags for them so they do not appear in shell history. See Snowflake's current
[Node.js authentication options](https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-authenticate)
for account-side requirements.

Run `argus-hub export snowflake --help` for all connection flags. The command reads
`SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_DATABASE`, `SNOWFLAKE_SCHEMA`,
`SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_ROLE`, `SNOWFLAKE_AUTHENTICATOR`, and
`SNOWFLAKE_PRIVATE_KEY_PATH` as their environment equivalents.

## Manual export and load

Without `--load`, the command makes no Snowflake connection. It writes one `.jsonl` file per
table, `manifest.json` with row counts and schema versions, and a generated `load.sql`:

```bash
npx @agentdeploymentco/argus-hub export snowflake \
  --data-dir /var/lib/argus-hub \
  --database ANALYTICS \
  --schema ARGUS_HUB \
  --output-dir /secure/argus-export-2026-07-21
```

Review the manifest and SQL, then execute the loader on the same machine because `load.sql`
contains absolute `file://` paths:

```bash
snow sql --connection argus-loader \
  --warehouse ARGUS_LOAD_WH \
  --filename /secure/argus-export-2026-07-21/load.sql
```

Snowflake CLI documents file execution under
[`snow sql --filename`](https://docs.snowflake.com/en/developer-guide/snowflake-cli/command-reference/sql-commands/sql).
The legacy equivalent is `snowsql -f /secure/argus-export-2026-07-21/load.sql`.

This bundle is also the integration point for an external scheduler or transfer system: copy the
directory to the Snowflake CLI host without changing its final paths, or regenerate `load.sql`
after placing it there.

## Scheduled exports

For a simple hourly job, put the non-secret connection values and credentials in a root-readable
environment file, for example `/etc/argus-hub/snowflake.env`, and set its mode to `0600`. A cron
entry can then load it without placing secrets in the crontab:

```cron
15 * * * * set -a; . /etc/argus-hub/snowflake.env; set +a; cd /srv/argus-hub && /usr/bin/npx @agentdeploymentco/argus-hub export snowflake --data-dir /var/lib/argus-hub --load --authenticator SNOWFLAKE_JWT >> /var/log/argus-hub-snowflake.log 2>&1
```

Use your service manager's `EnvironmentFile` support instead of shell sourcing when available.
Do not overlap runs; although each export uses unique staging tables, overlapping full refreshes
waste warehouse work and the last transaction to commit wins.

## Behavior and limitations

- The export reads `hub.db` and its WAL through SQLite's read-only transaction support. Hub can
  remain online, and all exported tables reflect one database snapshot.
- Loads are full replacements. There is no change-data-capture cursor, append mode, Snowpipe
  integration, or automatic history table.
- Target data replacement is atomic, but initial table creation and additive column updates are
  DDL performed before that transaction.
- The exporter requires the Hub database schema version used by the installed CLI. Start that CLI
  version's server once to migrate an older database before exporting it.
- Export files are sensitive. They can contain email addresses, prompts, summaries, working
  directories, file paths, tool arguments, and raw JSON. The command creates local directories as
  `0700` and files as `0600`; preserve equivalent controls in backups and transfer systems.
- Snowflake tables intentionally omit SQLite primary/foreign-key declarations. Use the source key
  columns (`ORG_ID`, `CLIENT_ID`, `SESSION_ID`, and `SEQ`) when joining data.
- Epoch fields such as `FIRST_TS`, `LAST_TS`, and `CREATED_AT` are milliseconds. Convert them in
  queries with `TO_TIMESTAMP_LTZ(field / 1000)` when a Snowflake timestamp is preferable.
- The generated SQL uses
  [`PUT`](https://docs.snowflake.com/en/sql-reference/sql/put) and
  [`COPY INTO`](https://docs.snowflake.com/en/sql-reference/sql/copy-into-table); outbound access
  to Snowflake and its cloud-storage endpoints must be allowed by the host network.
