import { describe, expect, test } from "bun:test";
import { complete, defaultModelByProvider, LLM_PROVIDERS, PROVIDERS } from "../src/llm/index.ts";
import { splitCommand } from "../src/llm/providers/command.ts";

describe("LLM provider registry", () => {
  test("contains exactly the five supported providers", () => {
    expect(LLM_PROVIDERS).toEqual(["claude-api", "command", "gemini", "openai", "openrouter"]);
    expect(LLM_PROVIDERS).not.toContain("claude-cli");
    expect(LLM_PROVIDERS).not.toContain("off");
    expect(LLM_PROVIDERS).not.toContain("hub");
  });

  test("is the source of config fields and model defaults", () => {
    expect(PROVIDERS.find((provider) => provider.name === "openai")?.configFields)
      .toEqual(["model", "baseUrl", "effort"]);
    expect(defaultModelByProvider().openai).toBe("gpt-5.4-nano");
    expect(defaultModelByProvider().openrouter).toBeUndefined();
  });

  test("requires API keys without reading environment variables", async () => {
    const result = await complete({ prompt: "ping" }, { provider: "openai" }, {
      fetch: (async () => { throw new Error("fetch should not run"); }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No API key");
  });

  test("dispatches command execution through the injected dependency", async () => {
    let seen = "";
    const result = await complete(
      { system: "system", prompt: "ping" },
      { provider: "command", command: "helper --flag" },
      { executeCommand: async (command, input) => {
        seen = `${command}|${input}`;
        return { ok: true, text: "pong" };
      } },
    );
    expect(result).toEqual({ ok: true, text: "pong" });
    expect(seen).toBe("helper --flag|system\n\nping");
  });

  test("shapes an OpenAI request", async () => {
    let request: RequestInit | undefined;
    const result = await complete(
      { prompt: "ping" },
      { provider: "openai", apiKey: "test-key" },
      { fetch: (async (_url: URL | RequestInfo, init?: RequestInit) => {
        request = init;
        return Response.json({ choices: [{ message: { content: "pong" } }] });
      }) as unknown as typeof fetch },
    );
    expect(result.ok).toBe(true);
    expect((request?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(request?.body)).model).toBe("gpt-5.4-nano");
  });
});

describe("command parsing", () => {
  test("honors quotes and escapes without invoking a shell", () => {
    expect(splitCommand(`tool --name "two words" one\\ two`))
      .toEqual(["tool", "--name", "two words", "one two"]);
    expect(() => splitCommand(`tool "unterminated`)).toThrow("unterminated quote");
  });
});
