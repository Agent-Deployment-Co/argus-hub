import { describe, expect, test } from "bun:test";
import {
  describeSettings,
  SettingsValidationError,
  validateSettingWrite,
} from "../src/settings.ts";

describe("Hub settings descriptors", () => {
  test("has one Tasks category, no implicit provider, and registry-derived choices", () => {
    const response = describeSettings({ provider: null, providerConfigs: {} });
    expect(response.categories).toHaveLength(1);
    expect(response.categories[0].id).toBe("tasks");
    const provider = response.categories[0].sections[0].settings[0];
    expect(provider).toBeDefined();
    expect(provider!.value).toBeNull();
    expect(provider!.options?.map((option) => option.value))
      .toEqual(["claude-api", "command", "gemini", "openai", "openrouter"]);
    expect(provider!.options?.some((option) => ["off", "hub", "claude-cli"].includes(option.value))).toBe(false);
  });

  test("describes provider fields, defaults, API-key requirements, and command risk", () => {
    const section = describeSettings({ provider: "command", providerConfigs: {} })
      .categories[0].sections[0];
    const command = section.settings.find((setting) => setting.field === "command");
    const model = section.settings.find((setting) => setting.field === "model");
    expect(command?.visibleWhen?.in).toEqual(["command"]);
    expect(command?.description).toContain("Hub host");
    expect(model?.placeholderByProvider?.openai).toBe("gpt-5.4-nano");
    expect(section.secretField.providers).toEqual(["claude-api", "gemini", "openai", "openrouter"]);
  });
});

describe("settings write validation", () => {
  test("accepts valid providers and provider-field paths", () => {
    expect(validateSettingWrite("llm.provider", "openai"))
      .toEqual({ kind: "provider", provider: "openai" });
    expect(validateSettingWrite("llm.providerConfigs.openai.baseUrl", "https://proxy.example/v1"))
      .toEqual({
        kind: "field",
        provider: "openai",
        field: "baseUrl",
        value: "https://proxy.example/v1",
      });
    expect(validateSettingWrite("llm.providerConfigs.openai.model", "   "))
      .toEqual({ kind: "field", provider: "openai", field: "model", value: null });
  });

  test.each([
    ["llm.provider", "claude-cli"],
    ["llm.provider", "off"],
    ["llm.provider", "hub"],
    ["llm.unknown", "x"],
    ["llm.providerConfigs.gemini.baseUrl", "https://example.com"],
    ["llm.providerConfigs.openai.command", "echo"],
    ["llm.providerConfigs.openai.baseUrl", "file:///tmp/api"],
  ])("rejects invalid or irrelevant write %s", (path, value) => {
    expect(() => validateSettingWrite(path, value)).toThrow(SettingsValidationError);
  });
});
