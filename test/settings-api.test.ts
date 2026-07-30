import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminAuth, makeSessionCookie } from "../src/admin-auth.ts";
import { createHubApp } from "../src/api/serve.ts";
import { createSecretCipher } from "../src/secrets.ts";
import { openHubStore, type HubStore } from "../src/store/hub-store.ts";

const dirs: string[] = [];
const cipher = createSecretCipher(Buffer.alloc(32, 9));
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function env(): Promise<{ store: HubStore; app: ReturnType<typeof createHubApp> }> {
  const dir = mkdtempSync(join(tmpdir(), "hub-settings-api-"));
  dirs.push(dir);
  const store = await openHubStore(dir, 1);
  return { store, app: createHubApp(store, undefined, { secretCipher: cipher }) };
}

describe("settings API", () => {
  const put = (app: ReturnType<typeof createHubApp>, path: string, value: unknown) =>
    app.request(`/api/settings/${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });

  test("all settings routes use the existing administrator session middleware", async () => {
    const { store } = await env();
    const auth = createAdminAuth("secret");
    const app = createHubApp(store, auth, { secretCipher: cipher });
    for (const [method, path] of [
      ["GET", "/api/settings"],
      ["PUT", "/api/settings/llm.provider"],
      ["GET", "/api/settings/secrets/openai"],
      ["POST", "/api/settings/secrets/openai"],
      ["DELETE", "/api/settings/secrets/openai"],
      ["POST", "/api/settings/test-connection"],
    ] as const) {
      expect((await app.request(path, { method })).status).toBe(401);
    }
    const cookie = makeSessionCookie(auth).split(";")[0];
    expect((await app.request("/api/settings", { headers: { Cookie: cookie! } })).status).not.toBe(401);
    await store.close();
  });

  test("starts blank and validates plain setting writes", async () => {
    const { store, app } = await env();
    const initial = await (await app.request("/api/settings")).json();
    expect(initial.categories[0].sections[0].settings[0].value).toBeNull();

    const saved = await app.request("/api/settings/llm.provider", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "openai" }),
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).categories[0].sections[0].settings[0].value).toBe("openai");

    for (const [path, value] of [
      ["llm.provider", "claude-cli"],
      ["llm.providerConfigs.gemini.baseUrl", "https://nope.example"],
      ["llm.providerConfigs.openai.baseUrl", "file:///tmp/socket"],
    ]) {
      const response = await app.request(`/api/settings/${path}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    await store.close();
  });

  test("disables and rejects API-key providers without HUB_SECRET_KEY", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-settings-api-no-secret-"));
    dirs.push(dir);
    const store = await openHubStore(dir, 1);
    const app = createHubApp(store);
    const settings = await (await app.request("/api/settings")).json();
    const provider = settings.categories[0].sections[0].settings[0];
    expect(provider.options.find((option: { value: string }) => option.value === "openai").disabled)
      .toBe(true);
    expect(provider.options.find((option: { value: string }) => option.value === "command").disabled)
      .toBe(false);
    expect((await put(app, "llm.provider", "openai")).status).toBe(503);
    expect((await put(app, "llm.provider", "command")).status).toBe(200);
    expect((await app.request("/api/settings/secrets/openai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "sk-test" }),
    })).status).toBe(503);
    await store.close();
  });

  test("creates, masks, replaces, and deletes a secret without echoing protected material", async () => {
    const { store, app } = await env();
    const firstKey = "  sk-first-1234  ";
    const created = await app.request("/api/settings/secrets/openai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: firstKey }),
    });
    expect(await created.json()).toEqual({ configured: true, hint: "…1234" });
    expect(await (await app.request("/api/settings/secrets/openai")).json())
      .toEqual({ configured: true, hint: "…1234" });
    const encrypted = await store.readEncryptedLlmSecret((await store.getDefaultOrgId())!, "openai");
    expect(JSON.stringify(encrypted)).not.toContain("sk-first");

    const replaced = await app.request("/api/settings/secrets/openai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "sk-second-5678" }),
    });
    expect(await replaced.json()).toEqual({ configured: true, hint: "…5678" });
    expect(await (await app.request("/api/settings/secrets/openai", { method: "DELETE" })).json())
      .toEqual({ configured: false });
    await store.close();
  });

  test("rejects blank state and missing keys, then reports injected success without completion text", async () => {
    const { store } = await env();
    const mockFetch = (async () =>
      Response.json({ choices: [{ message: { content: "secret completion" } }] })
    ) as unknown as typeof fetch;
    const app = createHubApp(store, undefined, {
      secretCipher: cipher,
      fetch: mockFetch,
    });
    expect((await app.request("/api/settings/test-connection", { method: "POST" })).status).toBe(400);
    await store.setTaskLlmProvider((await store.getDefaultOrgId())!, "openai", 1);
    expect((await app.request("/api/settings/test-connection", { method: "POST" })).status).toBe(400);
    await app.request("/api/settings/secrets/openai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "sk-test-1234" }),
    });
    const result = await (await app.request("/api/settings/test-connection", { method: "POST" })).json();
    expect(result).toEqual({ ok: true, provider: "openai", model: "gpt-5.6-luna" });
    expect(JSON.stringify(result)).not.toContain("completion");
    await store.close();
  });

  test("sanitizes authentication, URL, key, and command diagnostics", async () => {
    const { store } = await env();
    const orgId = (await store.getDefaultOrgId())!;
    await store.setTaskLlmProvider(orgId, "openai", 1);
    await store.setLlmSecret(orgId, "openai", cipher.encrypt(orgId, "openai", "sk-leak-1234"), "1234", 1);
    const mockFetch = (async () => new Response(
      JSON.stringify({ error: { message: "bad sk-leak-1234 https://user:pass@host/path?token=leak" } }),
      { status: 401 },
    )) as unknown as typeof fetch;
    const app = createHubApp(store, undefined, {
      secretCipher: cipher,
      fetch: mockFetch,
    });
    const response = await app.request("/api/settings/test-connection", { method: "POST" });
    const body = await response.text();
    expect(response.status).toBe(502);
    expect(body).toContain("Authentication failed");
    expect(body).not.toContain("sk-leak");
    expect(body).not.toContain("token=leak");
    await store.close();
  });

  test("uses only the selected provider config and key", async () => {
    const { store } = await env();
    const orgId = (await store.getDefaultOrgId())!;
    await store.setTaskLlmProviderField(orgId, "openai", "model", "openai-model", 1);
    await store.setTaskLlmProviderField(orgId, "gemini", "model", "gemini-model", 1);
    await store.setLlmSecret(orgId, "openai", cipher.encrypt(orgId, "openai", "openai-key"), "-key", 1);
    await store.setLlmSecret(orgId, "gemini", cipher.encrypt(orgId, "gemini", "gemini-key"), "-key", 1);
    await store.setTaskLlmProvider(orgId, "gemini", 1);
    let seenUrl = "";
    let seenHeaders: HeadersInit | undefined;
    const mockFetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = init?.headers;
      return Response.json({ candidates: [{ content: { parts: [{ text: "OK" }] } }] });
    }) as unknown as typeof fetch;
    const app = createHubApp(store, undefined, { secretCipher: cipher, fetch: mockFetch });
    const result = await (await app.request("/api/settings/test-connection", { method: "POST" })).json();
    expect(result.model).toBe("gemini-model");
    expect(seenUrl).toContain("gemini-model");
    expect((seenHeaders as Record<string, string>)["x-goog-api-key"]).toBe("gemini-key");
    expect(JSON.stringify(seenHeaders)).not.toContain("openai-key");
    await store.close();
  });

  test("bounds timeout and command failure diagnostics", async () => {
    const { store } = await env();
    const orgId = (await store.getDefaultOrgId())!;
    await store.setTaskLlmProvider(orgId, "command", 1);
    await store.setTaskLlmProviderField(orgId, "command", "command", "helper", 1);
    const commandApp = createHubApp(store, undefined, {
      secretCipher: cipher,
      executeCommand: async () => ({ ok: false, text: "", error: "private command output" }),
    });
    const commandBody = await (await commandApp.request(
      "/api/settings/test-connection",
      { method: "POST" },
    )).text();
    expect(commandBody).toContain("configured command failed");
    expect(commandBody).not.toContain("private command output");

    await store.setTaskLlmProvider(orgId, "openai", 2);
    await store.setLlmSecret(orgId, "openai", cipher.encrypt(orgId, "openai", "key"), "key", 2);
    const hangingFetch = ((_url: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as unknown as typeof fetch;
    const timeoutApp = createHubApp(store, undefined, {
      secretCipher: cipher,
      fetch: hangingFetch,
      connectionTimeoutMs: 5,
    });
    const timeoutBody = await (await timeoutApp.request(
      "/api/settings/test-connection",
      { method: "POST" },
    )).text();
    expect(timeoutBody).toContain("timed out");
    expect(timeoutBody).not.toContain("key");
    await store.close();
  });
});
