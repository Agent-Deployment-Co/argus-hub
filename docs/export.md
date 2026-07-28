# Export Argus Hub data

`argus-hub export snowflake` creates a consistent Snowflake-ready snapshot of the live Argus Hub
database. Add `--load` to upload it with the built-in Snowflake connector, or use the generated
JSONL files and `load.sql` for a manual or externally scheduled load.

See [Export Argus Hub data to Snowflake](snowflake.md) for data coverage, one-time role and
schema setup, authentication, scheduling, and limitations.

The same bundle is also available straight from the browser: the **Export** tab
(`GET /api/export`) streams it as a zip with no separate CLI step. `api_keys` is deliberately
excluded from the bundle either way.
