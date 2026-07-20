import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openHubStore, type HubStore, type HubUploadPayload } from "../src/store/hub-store.ts";
import { createHubApp } from "../src/api/serve.ts";
import { HUB_MAX_CLIENT_SCHEMA_VERSION } from "../src/api/sync.ts";
import { createAdminAuth } from "../src/admin-auth.ts";

// ---- Temp dir + test store helpers (mirrors test/serve.test.ts) -----------------------

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "hub-mcp-test-"));
  tempDirs.push(d);
  return d;
}

function buildUploadPayload(sessions: Array<{ id: string; source?: string; project?: string }>): HubUploadPayload {
  return {
    schemaVersion: HUB_MAX_CLIENT_SCHEMA_VERSION,
    rows: {
      sessions: sessions.map(({ id, source = "claude", project = "/Users/you/proj" }) => ({
        session_id: id,
        source,
        project,
        cwd: project,
        first_ts: null,
        last_ts: null,
        message_count: 1,
        first_prompt: null,
        archived: 0,
        friction_interruptions: null,
        friction_rejections: null,
        friction_compactions: null,
        friction_turns: null,
        last_interruption_ms: null,
        title: null,
        summary: null,
        meta_json: JSON.stringify({ sessionId: id, source, project, cwd: project, filePath: "" }),
      })),
      usage: sessions.map(({ id, source = "claude", project = "/Users/you/proj" }) => ({
        session_id: id,
        seq: 0,
        source,
        ts: 1_000_000,
        date: "2026-01-01",
        cwd: project,
        project,
        record_json: JSON.stringify({
          sessionId: id, model: "claude-sonnet-4-6", ts: 1_000_000, date: "2026-01-01",
          source, project, cwd: project, gitBranch: "",
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
          attributionSkill: null, toolUses: [],
        }),
        input_tokens: 100,
        output_tokens: 50,
        cache_read: 0,
        cache_write_5m: 0,
        cache_write_1h: 0,
        model: "claude-sonnet-4-6",
        attribution_skill: null,
        stop_reason: null,
        interaction_seq: null,
      })),
      tasks: [],
      interactions: [],
      invocations: [],
      labels: [],
    },
  };
}

interface TestEnv {
  store: HubStore;
  apiKey: string;
}

async function openTestEnv(): Promise<TestEnv> {
  const dir = tempDir();
  let printed = "";
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { printed += s; return true; };
  const store = await openHubStore(dir, 1_000_000);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = orig;
  const apiKey = (/Hub API key \(Default\): (hub-\S+)/.exec(printed))?.[1] ?? "";
  return { store, apiKey };
}

async function syncSessions(env: TestEnv, sessions: Array<{ id: string }>): Promise<void> {
  const app = createHubApp(env.store);
  const payload = {
    ...buildUploadPayload(sessions),
    fingerprint: [{ key: "claude.oauth.email", value: "alice@example.com", tsMs: 1_000_000 }],
  };
  const res = await app.request("/api/sync", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.apiKey}`,
      "X-Argus-Client": `client-${randomUUID()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (res.status !== 200) throw new Error(`sync failed: ${res.status} ${await res.text()}`);
}

// ---- JSON-RPC helpers -------------------------------------------------------------------

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

async function rpc(
  app: ReturnType<typeof createHubApp>,
  method: string,
  params?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: JsonRpcResponse | { jsonrpc: string; error: { message: string } } }> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

function callTool(
  app: ReturnType<typeof createHubApp>,
  name: string,
  args: Record<string, unknown> = {},
  headers?: Record<string, string>,
) {
  return rpc(app, "tools/call", { name, arguments: args }, headers);
}

// ---- Tests -------------------------------------------------------------------------------

describe("tools/list", () => {
  test("returns all four tools with a JSON-schema input", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      const { status, body } = await rpc(app, "tools/list");
      expect(status).toBe(200);
      const tools = (body as { result: { tools: Array<{ name: string; inputSchema: { type: string } }> } }).result.tools;
      expect(tools.map((t) => t.name)).toEqual([
        "query_activity", "query_tasks", "query_task_quality", "query_tool_usage", "list_users",
      ]);
      for (const t of tools) expect(t.inputSchema.type).toBe("object");
    } finally {
      await env.store.close();
    }
  });
});

describe("tools/call query_activity", () => {
  test("returns 'No data yet.' as a tool error when the org has no sessions", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      const { body } = await callTool(app, "query_activity");
      const result = (body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toBe("No data yet.");
    } finally {
      await env.store.close();
    }
  });

  test("returns a tool error for an unknown source", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      await syncSessions(env, [{ id: "s1" }]);
      const { body } = await callTool(app, "query_activity", { source: "unknown" });
      const result = (body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Unknown source");
    } finally {
      await env.store.close();
    }
  });

  test("matches the equivalent /api/activity response for the same window", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      await syncSessions(env, [{ id: "s1" }, { id: "s2" }]);

      const query = "since=2020-01-01&until=2030-01-01";
      const restRes = await app.request(`/api/activity?${query}`);
      const restBody = await restRes.json();

      const { body } = await callTool(app, "query_activity", { since: "2020-01-01", until: "2030-01-01" });
      const result = (body as { result: { content: Array<{ text: string }> } }).result;
      const mcpBody = JSON.parse(result.content[0]!.text);

      // Both calls stamp `generatedAtMs` with their own Date.now(); every other field must match.
      expect({ ...mcpBody, generatedAtMs: 0 }).toEqual({ ...(restBody as object), generatedAtMs: 0 });
    } finally {
      await env.store.close();
    }
  });

  test("returns an unknown-tool error for an unregistered tool name", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      const { body } = await callTool(app, "query_nonexistent");
      const result = (body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Unknown tool");
    } finally {
      await env.store.close();
    }
  });
});

describe("tools/call query_tasks", () => {
  test("returns the empty-state shape when the org has no sessions", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      const { body } = await callTool(app, "query_tasks");
      const result = (body as { result: { content: Array<{ text: string }> } }).result;
      expect(JSON.parse(result.content[0]!.text)).toEqual({
        rows: [], total: 0, offset: 0, limit: 50, counts: { success: 0, failure: 0, unknown: 0 },
      });
    } finally {
      await env.store.close();
    }
  });

  test("returns a tool error for an unknown outcome", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      await syncSessions(env, [{ id: "s1" }]);
      const { body } = await callTool(app, "query_tasks", { outcome: "bogus" });
      const result = (body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Unknown outcome");
    } finally {
      await env.store.close();
    }
  });

  test("matches the equivalent /api/tasks response, including limit/offset", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      await syncSessions(env, [{ id: "s1" }, { id: "s2" }]);

      const restRes = await app.request("/api/tasks?limit=1&offset=0");
      const restBody = await restRes.json();

      const { body } = await callTool(app, "query_tasks", { limit: 1, offset: 0 });
      const result = (body as { result: { content: Array<{ text: string }> } }).result;
      expect(JSON.parse(result.content[0]!.text)).toEqual(restBody as object);
    } finally {
      await env.store.close();
    }
  });
});

describe("tools/call query_task_quality", () => {
  test("returns 'No data yet.' as a tool error when the org has no sessions", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      const { body } = await callTool(app, "query_task_quality");
      const result = (body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toBe("No data yet.");
    } finally {
      await env.store.close();
    }
  });

  test("matches the equivalent /api/tasks/report response for the same window", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      await syncSessions(env, [{ id: "s1" }, { id: "s2" }]);

      const query = "since=2020-01-01&until=2030-01-01";
      const restBody = await (await app.request(`/api/tasks/report?${query}`)).json();

      const { body } = await callTool(app, "query_task_quality", { since: "2020-01-01", until: "2030-01-01" });
      const result = (body as { result: { content: Array<{ text: string }> } }).result;
      const mcpBody = JSON.parse(result.content[0]!.text);

      // Both calls stamp `generatedAtMs` with their own Date.now(); every other field must match.
      expect({ ...mcpBody, generatedAtMs: 0 }).toEqual({ ...(restBody as object), generatedAtMs: 0 });
    } finally {
      await env.store.close();
    }
  });
});

describe("tools/call query_tool_usage", () => {
  test("returns 'No data yet.' as a tool error when the org has no sessions", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      const { body } = await callTool(app, "query_tool_usage");
      const result = (body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toBe("No data yet.");
    } finally {
      await env.store.close();
    }
  });

  test("returns only the tool-facing slices of the dashboard, matching /api/snapshot", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      await syncSessions(env, [{ id: "s1" }, { id: "s2" }]);

      const restBody = await (await app.request("/api/snapshot")).json() as {
        dashboard: Record<string, unknown>;
      };

      const { body } = await callTool(app, "query_tool_usage");
      const result = (body as { result: { content: Array<{ text: string }> } }).result;
      const mcpBody = JSON.parse(result.content[0]!.text);

      expect(Object.keys(mcpBody).sort()).toEqual(
        ["byTool", "byToolCategory", "underused", "sharedVsSolo", "sourceComparison"].sort(),
      );
      for (const key of Object.keys(mcpBody)) {
        expect(mcpBody[key]).toEqual(restBody.dashboard[key]);
      }
    } finally {
      await env.store.close();
    }
  });
});

describe("tools/call list_users", () => {
  test("returns an empty roster when the org has no sessions", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      const { body } = await callTool(app, "list_users");
      const result = (body as { result: { content: Array<{ text: string }> } }).result;
      expect(JSON.parse(result.content[0]!.text)).toEqual({ users: [] });
    } finally {
      await env.store.close();
    }
  });

  test("matches the equivalent /api/users response", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      await syncSessions(env, [{ id: "s1" }, { id: "s2" }]);

      const restBody = await (await app.request("/api/users")).json();

      const { body } = await callTool(app, "list_users");
      const result = (body as { result: { content: Array<{ text: string }> } }).result;
      expect(JSON.parse(result.content[0]!.text)).toEqual(restBody as object);
    } finally {
      await env.store.close();
    }
  });
});

describe("/mcp auth", () => {
  test("is open when the app is built without auth", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store);
    try {
      const { status } = await rpc(app, "tools/list");
      expect(status).toBe(200);
    } finally {
      await env.store.close();
    }
  });

  test("rejects a missing bearer token when auth is configured", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store, createAdminAuth("s3cret"));
    try {
      const { status } = await rpc(app, "tools/list");
      expect(status).toBe(401);
    } finally {
      await env.store.close();
    }
  });

  test("rejects a wrong bearer token", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store, createAdminAuth("s3cret"));
    try {
      const { status } = await rpc(app, "tools/list", undefined, { Authorization: "Bearer nope" });
      expect(status).toBe(401);
    } finally {
      await env.store.close();
    }
  });

  test("accepts the admin password as a bearer token", async () => {
    const env = await openTestEnv();
    const app = createHubApp(env.store, createAdminAuth("s3cret"));
    try {
      const { status } = await rpc(app, "tools/list", undefined, { Authorization: "Bearer s3cret" });
      expect(status).toBe(200);
    } finally {
      await env.store.close();
    }
  });
});
