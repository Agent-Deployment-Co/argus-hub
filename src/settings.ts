import {
  defaultModelByProvider,
  getProvider,
  isLlmProvider,
  PROVIDERS,
} from "./llm/index.ts";
import type { LlmConfigField, LlmProvider } from "./llm/types.ts";
import type { AutomaticTaggingEligibility, TaskLlmSettings } from "./store/hub-store.ts";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

export interface SettingDescriptor {
  path: string;
  field?: LlmConfigField;
  label: string;
  description?: string;
  control: "toggle" | "select" | "text" | "textarea";
  options?: SelectOption[];
  value: string | boolean | null;
  providerScoped?: boolean;
  visibleWhen?: { path: "llm.provider"; in: LlmProvider[] };
  placeholderByProvider?: Record<string, string>;
}

export interface SettingsSection {
  settings: SettingDescriptor[];
  secretField: {
    key: "llm.apiKey";
    label: "API key";
    description: string;
    providerPath: "llm.provider";
    providers: LlmProvider[];
  };
  connectionTest: {
    label: "Test connection";
    providerPath: "llm.provider";
  };
}

export interface SettingsResponse {
  categories: [{
    id: "tasks";
    label: "Tasks";
    sections: [SettingsSection];
  }];
  providerConfigs: Partial<Record<LlmProvider, Record<string, string>>>;
  automaticTaggingEligibility: AutomaticTaggingEligibility;
}

const providersFor = (field: LlmConfigField): LlmProvider[] =>
  PROVIDERS.filter((provider) => provider.configFields.includes(field)).map((provider) => provider.name);

const providerOptions: SelectOption[] = PROVIDERS.map((provider) => ({
  value: provider.name,
  label: provider.label,
  description: provider.description,
}));

const BASE_DESCRIPTORS: Omit<SettingDescriptor, "value">[] = [
  {
    path: "automaticTaggingEnabled",
    label: "Automatic task tagging",
    description: "Classify new and changed tasks against automatic labels.",
    control: "toggle",
  },
  {
    path: "llm.provider",
    label: "LLM Provider",
    description: "Choose the LLM connection used by organization task features.",
    control: "select",
    options: providerOptions,
  },
  {
    path: "llm.model",
    field: "model",
    label: "Model",
    description: "Provider model identifier. Leave blank to use the built-in default where available.",
    control: "text",
    providerScoped: true,
    visibleWhen: { path: "llm.provider", in: providersFor("model") },
    placeholderByProvider: defaultModelByProvider(),
  },
  {
    path: "llm.baseUrl",
    field: "baseUrl",
    label: "Base URL",
    description: "OpenAI-compatible API endpoint. Leave blank for OpenAI's default.",
    control: "text",
    providerScoped: true,
    visibleWhen: { path: "llm.provider", in: providersFor("baseUrl") },
  },
  {
    path: "llm.effort",
    field: "effort",
    label: "Reasoning effort",
    description: "Provider-native reasoning effort. Leave blank for the model default.",
    control: "text",
    providerScoped: true,
    visibleWhen: { path: "llm.provider", in: providersFor("effort") },
  },
  {
    path: "llm.command",
    field: "command",
    label: "Command",
    description: "Executes this administrator-configured command on the Hub host. The prompt is sent on stdin and completion text is read from stdout.",
    control: "textarea",
    providerScoped: true,
    visibleWhen: { path: "llm.provider", in: providersFor("command") },
  },
];

export function describeSettings(
  settings: TaskLlmSettings,
  automaticTaggingEligibility: AutomaticTaggingEligibility = {
    eligible: false,
    reason: "Select and save an LLM provider first.",
  },
): SettingsResponse {
  const providerConfigs = Object.fromEntries(
    Object.entries(settings.providerConfigs).map(([provider, config]) => [
      provider,
      Object.fromEntries(Object.entries(config ?? {}).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string")),
    ]),
  ) as SettingsResponse["providerConfigs"];
  return {
    categories: [{
      id: "tasks",
      label: "Tasks",
      sections: [{
        settings: BASE_DESCRIPTORS.map((descriptor) => ({
          ...descriptor,
          value: descriptor.path === "automaticTaggingEnabled"
            ? settings.automaticTaggingEnabled
            : descriptor.path === "llm.provider" ? settings.provider : null,
        })),
        secretField: {
          key: "llm.apiKey",
          label: "API key",
          description: "Encrypted in the Hub database with the deployment's HUB_SECRET_KEY.",
          providerPath: "llm.provider",
          providers: PROVIDERS.filter((provider) => provider.requiresApiKey).map((provider) => provider.name),
        },
        connectionTest: { label: "Test connection", providerPath: "llm.provider" },
      }],
    }],
    providerConfigs,
    automaticTaggingEligibility,
  };
}

export type ValidatedSettingWrite =
  | { kind: "automaticTagging"; enabled: boolean }
  | { kind: "provider"; provider: LlmProvider | null }
  | { kind: "field"; provider: LlmProvider; field: LlmConfigField; value: string | null };

export class SettingsValidationError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

const PROVIDER_CONFIG_PATH = /^llm\.providerConfigs\.([^.]+)\.([^.]+)$/;

export function validateSettingWrite(path: string, raw: unknown): ValidatedSettingWrite {
  if (path === "automaticTaggingEnabled") {
    if (typeof raw !== "boolean") {
      throw new SettingsValidationError("Automatic tagging must be true or false.");
    }
    return { kind: "automaticTagging", enabled: raw };
  }
  if (path === "llm.provider") {
    if (raw === null || raw === "") return { kind: "provider", provider: null };
    if (typeof raw !== "string" || !isLlmProvider(raw)) {
      throw new SettingsValidationError("Invalid LLM provider.");
    }
    return { kind: "provider", provider: raw };
  }

  const match = PROVIDER_CONFIG_PATH.exec(path);
  if (!match) throw new SettingsValidationError(`Unknown setting "${path}".`, 404);
  const [, providerName, fieldName] = match;
  const provider = providerName ? getProvider(providerName) : undefined;
  if (!provider || !isLlmProvider(providerName!)) {
    throw new SettingsValidationError(`Unknown LLM provider "${providerName}".`, 404);
  }
  if (!provider.configFields.includes(fieldName as LlmConfigField)) {
    throw new SettingsValidationError(`Provider "${providerName}" has no "${fieldName}" setting.`, 404);
  }
  if (raw !== null && typeof raw !== "string") {
    throw new SettingsValidationError(`The ${fieldName} value must be a string or null.`);
  }
  const value = raw === null || raw.trim() === "" ? null : raw;
  const maxLength = fieldName === "command" ? 8192 : 2048;
  if (value && value.length > maxLength) throw new SettingsValidationError(`The ${fieldName} value is too long.`);
  if (fieldName === "baseUrl" && value) {
    let url: URL;
    try { url = new URL(value); } catch { throw new SettingsValidationError("Base URL must be a valid URL."); }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new SettingsValidationError("Base URL must use http or https.");
    }
  }
  return {
    kind: "field",
    provider: provider.name,
    field: fieldName as LlmConfigField,
    value,
  };
}
