export type LlmProvider = "claude-api" | "command" | "gemini" | "openai" | "openrouter";

export type LlmConfigField = "model" | "baseUrl" | "effort" | "command";

export interface LlmRequest {
  system?: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  effort?: string;
  signal?: AbortSignal;
}

export interface LlmResult {
  ok: boolean;
  text: string;
  error?: string;
  status?: number | null;
}

export interface ResolvedLlmConfig {
  provider: LlmProvider;
  model?: string;
  baseUrl?: string;
  effort?: string;
  command?: string;
  apiKey?: string;
}

export type ExecuteCommand = (
  command: string,
  input: string,
  signal?: AbortSignal,
) => Promise<LlmResult>;

export interface ProviderCall {
  system?: string;
  prompt: string;
  model: string;
  maxTokens: number;
  effort?: string;
  baseUrl?: string;
  apiKey?: string;
  command?: string;
  fetch: typeof fetch;
  executeCommand?: ExecuteCommand;
  signal?: AbortSignal;
}

export interface ProviderDescriptor {
  name: LlmProvider;
  label: string;
  description: string;
  defaultModel?: string;
  requiresApiKey?: boolean;
  configFields: readonly LlmConfigField[];
  complete(call: ProviderCall): Promise<LlmResult>;
}
