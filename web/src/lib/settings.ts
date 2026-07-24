import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type {
  ConnectionTestResult,
  LlmProvider,
  SecretStatus,
  SettingsResponse,
} from "../types";

export const SETTINGS_QUERY_KEY = ["settings"] as const;

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (response.status === 401) {
    window.location.assign("/login");
    throw new Error("Your administrator session has expired.");
  }
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  if (!body) throw new Error("The server returned an empty response.");
  return body;
}

export function fetchSettings(): Promise<SettingsResponse> {
  return apiJson("/api/settings");
}

export function saveSetting(path: string, value: unknown): Promise<SettingsResponse> {
  return apiJson(`/api/settings/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

export function fetchSecretStatus(provider: LlmProvider): Promise<SecretStatus> {
  return apiJson(`/api/settings/secrets/${provider}`);
}

export function saveSecret(provider: LlmProvider, value: string): Promise<SecretStatus> {
  return apiJson(`/api/settings/secrets/${provider}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

export function deleteSecret(provider: LlmProvider): Promise<SecretStatus> {
  return apiJson(`/api/settings/secrets/${provider}`, { method: "DELETE" });
}

export function testConnection(): Promise<ConnectionTestResult> {
  return apiJson("/api/settings/test-connection", { method: "POST" });
}

export function useSettingsQuery() {
  return useQuery({ queryKey: SETTINGS_QUERY_KEY, queryFn: fetchSettings });
}

export function secretQueryKey(provider: LlmProvider | null) {
  return ["settings", "secret", provider] as const;
}

export function useSecretStatusQuery(provider: LlmProvider | null, enabled = true) {
  return useQuery({
    queryKey: secretQueryKey(provider),
    queryFn: () => fetchSecretStatus(provider!),
    enabled: enabled && provider !== null,
  });
}

export function useSaveSecretMutation(provider: LlmProvider | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (value: string) => {
      if (!provider) throw new Error("Choose a provider first.");
      return saveSecret(provider, value);
    },
    onSuccess: (status) => client.setQueryData(secretQueryKey(provider), status),
  });
}

export function useDeleteSecretMutation(provider: LlmProvider | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (!provider) throw new Error("Choose a provider first.");
      return deleteSecret(provider);
    },
    onSuccess: (status) => client.setQueryData(secretQueryKey(provider), status),
  });
}

export function useTestConnectionMutation() {
  return useMutation({ mutationFn: testConnection });
}

export type SaveStatus =
  | { state: "idle" | "saving" | "saved" }
  | { state: "error"; error: string };

interface PendingWrite {
  value: unknown;
  resolve: Array<(response: SettingsResponse) => void>;
  reject: Array<(error: Error) => void>;
}

/** Serializes writes and collapses queued edits to the same path to their newest value. */
export class SettingsSaveQueue {
  private pending = new Map<string, PendingWrite>();
  private running = false;

  constructor(
    private readonly writer: (path: string, value: unknown) => Promise<SettingsResponse>,
    private readonly onStatus: (status: SaveStatus) => void,
    private readonly onSaved?: (response: SettingsResponse) => void,
  ) {}

  enqueue(path: string, value: unknown): Promise<SettingsResponse> {
    this.onStatus({ state: "saving" });
    const promise = new Promise<SettingsResponse>((resolve, reject) => {
      const existing = this.pending.get(path);
      if (existing) {
        existing.value = value;
        existing.resolve.push(resolve);
        existing.reject.push(reject);
      } else {
        this.pending.set(path, { value, resolve: [resolve], reject: [reject] });
      }
    });
    void this.drain();
    return promise;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.pending.size) {
      const first = this.pending.entries().next().value as [string, PendingWrite] | undefined;
      if (!first) break;
      const [path, write] = first;
      this.pending.delete(path);
      try {
        const response = await this.writer(path, write.value);
        this.onSaved?.(response);
        for (const resolve of write.resolve) resolve(response);
        this.onStatus({ state: this.pending.size ? "saving" : "saved" });
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        for (const reject of write.reject) reject(error);
        this.onStatus({ state: "error", error: error.message });
      }
    }
    this.running = false;
  }
}

export function useSettingsSaveQueue(): {
  status: SaveStatus;
  save: (path: string, value: unknown) => Promise<SettingsResponse>;
} {
  const queryClient: QueryClient = useQueryClient();
  const [status, setStatus] = useState<SaveStatus>({ state: "idle" });
  const queue = useMemo(() => new SettingsSaveQueue(
    saveSetting,
    setStatus,
    (response) => queryClient.setQueryData(SETTINGS_QUERY_KEY, response),
  ), [queryClient]);
  return { status, save: (path, value) => queue.enqueue(path, value) };
}
