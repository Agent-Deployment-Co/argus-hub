import { Link, useParams, useRouter } from "@tanstack/react-router";
import {
  ArrowLeft, Check, LoaderCircle, Lock, Pencil, PlugZap, SlidersHorizontal, Trash2, TriangleAlert, X,
} from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useSettingsBackHref } from "../components/Layout";
import {
  useDeleteSecretMutation,
  useSaveSecretMutation,
  useSecretStatusQuery,
  useSettingsQuery,
  useSettingsSaveQueue,
  useTestConnectionMutation,
} from "../lib/settings";
import type { LlmConfigField, LlmProvider, SettingDescriptor } from "../types";

function writePath(provider: LlmProvider, field: LlmConfigField): string {
  return `llm.providerConfigs.${provider}.${field}`;
}

function initialValueMap(
  response: NonNullable<ReturnType<typeof useSettingsQuery>["data"]>,
): Record<string, string> {
  const values: Record<string, string> = {};
  const providerSetting = response.categories[0].sections[0].settings
    .find((setting) => setting.path === "llm.provider");
  values["llm.provider"] = providerSetting?.value ?? "";
  for (const [provider, config] of Object.entries(response.providerConfigs)) {
    for (const [field, value] of Object.entries(config ?? {})) {
      if (typeof value === "string") values[writePath(provider as LlmProvider, field as LlmConfigField)] = value;
    }
  }
  return values;
}

function SaveIndicator({ status }: { status: ReturnType<typeof useSettingsSaveQueue>["status"] }) {
  return (
    <div className={`settings-save-status is-${status.state}`} role="status" aria-live="polite">
      {status.state === "saving" && <><LoaderCircle size={14} className="spin" aria-hidden /> Saving</>}
      {status.state === "saved" && <><Check size={14} aria-hidden /> Saved</>}
      {status.state === "error" && <>Error: {status.error}</>}
    </div>
  );
}

function PlainField({
  descriptor,
  provider,
  value,
  onChange,
}: {
  descriptor: SettingDescriptor;
  provider: LlmProvider;
  value: string;
  onChange: (value: string) => void;
}) {
  const stacked = descriptor.control === "textarea";
  const Input = stacked ? "textarea" : "input";
  return (
    <div className={`settings-row${stacked ? " settings-row-stacked" : ""}`}>
      <label htmlFor={`setting-${descriptor.field}`} className="settings-row-copy">
        <span className="settings-row-label">{descriptor.label}</span>
        {descriptor.description && <span className="settings-row-description">{descriptor.description}</span>}
      </label>
      <Input
        id={`setting-${descriptor.field}`}
        className={`settings-control${stacked ? " settings-textarea" : ""}`}
        value={value}
        placeholder={descriptor.placeholderByProvider?.[provider]}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </div>
  );
}

function SecretField({
  provider,
  value,
  onChange,
  editing,
  onStartEdit,
  onCancelEdit,
  onChanged,
}: {
  provider: LlmProvider;
  value: string;
  onChange: (value: string) => void;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onChanged: () => void;
}) {
  const status = useSecretStatusQuery(provider);
  const remove = useDeleteSecretMutation(provider);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const error = remove.error ?? status.error;

  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") onCancelEdit();
  };
  const showInput = !status.data?.configured || editing;

  return (
    <div className="settings-row settings-secret-row">
      <div className="settings-row-copy">
        <span className="settings-row-label">
          API key <Lock size={12} strokeWidth={2} aria-hidden className="settings-secret-lock" />
        </span>
        <span className="settings-row-description">
          Stored encrypted by Argus Hub and never returned to the browser.
        </span>
      </div>
      <div className="settings-secret-control">
        {status.isLoading ? (
          <span className="settings-secret-status">
            <LoaderCircle size={13} className="spin" aria-hidden /> Checking…
          </span>
        ) : showInput ? (
          <div className="settings-secret-form">
            <input
              autoFocus={editing}
              className="settings-control settings-secret-input"
              type="password"
              data-1p-ignore
              aria-label={status.data?.configured ? "Replacement API key" : "API key"}
              autoComplete="new-password"
              placeholder={status.data?.configured ? "New API key" : "Paste API key"}
              value={value}
              onChange={(event) => onChange(event.currentTarget.value)}
              onKeyDown={escape}
            />
            {status.data?.configured && (
              <button
                className="settings-secret-icon-btn"
                type="button"
                title="Cancel"
                aria-label="Cancel"
                onClick={onCancelEdit}
              >
                <X size={15} aria-hidden />
              </button>
            )}
          </div>
        ) : confirmingRemove ? (
          <div className="settings-secret-line">
            <span className="settings-secret-confirm">Remove key?</span>
            <button
              className="settings-secret-icon-btn is-danger"
              type="button"
              title="Confirm remove"
              aria-label="Confirm remove"
              disabled={remove.isPending}
              onClick={() => remove.mutate(undefined, { onSuccess: () => {
                setConfirmingRemove(false);
                onChanged();
              } })}
            >
              {remove.isPending
                ? <LoaderCircle size={15} className="spin" aria-hidden />
                : <Check size={15} aria-hidden />}
            </button>
            <button
              className="settings-secret-icon-btn"
              type="button"
              title="Cancel"
              aria-label="Cancel"
              disabled={remove.isPending}
              onClick={() => setConfirmingRemove(false)}
            >
              <X size={15} aria-hidden />
            </button>
          </div>
        ) : (
          <div className="settings-secret-line">
            <code className="settings-secret-mask">••••••••••••••••</code>
            <button
              className="settings-secret-icon-btn"
              type="button"
              title="Replace key"
              aria-label="Replace key"
              onClick={onStartEdit}
            >
              <Pencil size={15} aria-hidden />
            </button>
            <button
              className="settings-secret-icon-btn"
              type="button"
              title="Remove key"
              aria-label="Remove key"
              onClick={() => setConfirmingRemove(true)}
            >
              <Trash2 size={15} aria-hidden />
            </button>
          </div>
        )}
        {error && <span className="settings-inline-error" role="alert">{error.message}</span>}
      </div>
    </div>
  );
}

function GeneralSettingsPane() {
  const settings = useSettingsQuery();
  const saveQueue = useSettingsSaveQueue();
  const connection = useTestConnectionMutation();
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (settings.data) setValues(initialValueMap(settings.data));
  }, [settings.data]);

  const savedValues = useMemo(
    () => (settings.data ? initialValueMap(settings.data) : {}),
    [settings.data],
  );

  const section = settings.data?.categories[0].sections[0];
  const provider = (values["llm.provider"] || null) as LlmProvider | null;
  const savedProvider = (savedValues["llm.provider"] || null) as LlmProvider | null;
  const providerDescriptor = section?.settings.find((setting) => setting.path === "llm.provider");
  const providerSaved = !!provider && provider === savedProvider;
  const visibleFields = useMemo(() => section?.settings.filter((setting) =>
    setting.providerScoped && provider && setting.visibleWhen?.in.includes(provider)) ?? [],
  [section, provider]);
  const needsKey = !!provider && section?.secretField.providers.includes(provider);

  const saveSecretMutation = useSaveSecretMutation(provider);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyEditing, setApiKeyEditing] = useState(false);

  useEffect(() => {
    setApiKeyDraft("");
    setApiKeyEditing(false);
  }, [provider]);

  const apiKeyDirty = needsKey && apiKeyDraft.trim().length > 0;

  const dirtyPaths = useMemo(() => {
    const paths: string[] = [];
    if ((values["llm.provider"] ?? "") !== (savedValues["llm.provider"] ?? "")) paths.push("llm.provider");
    if (provider) {
      for (const descriptor of visibleFields) {
        const path = writePath(provider, descriptor.field!);
        if ((values[path] ?? "") !== (savedValues[path] ?? "")) paths.push(path);
      }
    }
    return paths;
  }, [values, savedValues, provider, visibleFields]);
  const dirty = dirtyPaths.length > 0 || apiKeyDirty;
  const saving = saveQueue.status.state === "saving" || saveSecretMutation.isPending;

  const setLocal = (path: string, value: string) => {
    setValues((current) => ({ ...current, [path]: value }));
    connection.reset();
  };
  const save = () => {
    const writes: Promise<unknown>[] = dirtyPaths.map((path) => saveQueue.save(path, values[path] ?? ""));
    if (apiKeyDirty) {
      writes.push(saveSecretMutation.mutateAsync(apiKeyDraft.trim()).then(() => {
        setApiKeyDraft("");
        setApiKeyEditing(false);
      }));
    }
    void Promise.all(writes).catch(() => undefined);
  };
  const cancel = () => {
    setValues(savedValues);
    setApiKeyDraft("");
    setApiKeyEditing(false);
    connection.reset();
  };

  if (settings.isLoading) return <div className="settings-loading">Loading General settings…</div>;
  if (settings.error || !section || !providerDescriptor) {
    return <div className="settings-load-error" role="alert">
      {settings.error?.message ?? "The settings response was incomplete."}
    </div>;
  }

  return (
    <div className="settings-pane" data-settings-pane="general">
      <div className="settings-pane-head">
        <div>
          <h2>General</h2>
          <p className="settings-pane-intro">Configure the LLM connection for organization task features.</p>
        </div>
        <SaveIndicator status={saveQueue.status} />
      </div>
      <section className="settings-section">
        <div className="settings-row">
          <label htmlFor="setting-provider" className="settings-row-copy">
            <span className="settings-row-label">{providerDescriptor.label}</span>
            <span className="settings-row-description">{providerDescriptor.description}</span>
          </label>
          <select
            id="setting-provider"
            className="settings-control settings-select"
            value={provider ?? ""}
            onChange={(event) => setLocal("llm.provider", event.currentTarget.value)}
          >
            <option value="">None</option>
            {providerDescriptor.options?.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}{option.disabled ? " (requires HUB_SECRET_KEY)" : ""}
              </option>
            ))}
          </select>
        </div>
        {provider && providerDescriptor.options?.find((option) => option.value === provider)?.description && (
          <p className={`settings-provider-note${provider === "command" ? " is-warning" : ""}`}>
            {providerDescriptor.options.find((option) => option.value === provider)!.description}
          </p>
        )}
        {provider && visibleFields.map((descriptor) => {
          const path = writePath(provider, descriptor.field!);
          return (
            <PlainField
              key={path}
              descriptor={descriptor}
              provider={provider}
              value={values[path] ?? ""}
              onChange={(value) => setLocal(path, value)}
            />
          );
        })}
        {provider && needsKey && (
          <SecretField
            key={provider}
            provider={provider}
            value={apiKeyDraft}
            onChange={setApiKeyDraft}
            editing={apiKeyEditing}
            onStartEdit={() => setApiKeyEditing(true)}
            onCancelEdit={() => {
              setApiKeyEditing(false);
              setApiKeyDraft("");
            }}
            onChanged={() => {
              connection.reset();
              void settings.refetch();
            }}
          />
        )}
        {provider && (
          <div className="settings-test-row">
            <div className="settings-row-copy">
              <span className="settings-row-label">Test connection</span>
              <span className="settings-row-description">
                {!providerSaved
                  ? "Choose and save a provider to enable connection testing."
                  : dirty
                    ? "Save your changes to enable connection testing."
                    : "Send a tiny completion using the saved provider settings."}
              </span>
              {connection.data && (
                <span
                  className={`settings-test-result ${connection.data.ok ? "is-ok" : "is-error"}`}
                  role="status"
                >
                  {connection.data.ok ? <Check size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />}
                  {connection.data.ok
                    ? `Connected${connection.data.model ? ` with ${connection.data.model}` : ""}.`
                    : connection.data.error}
                </span>
              )}
              {connection.error && (
                <span className="settings-test-result is-error" role="alert">
                  <TriangleAlert size={14} aria-hidden /> {connection.error.message}
                </span>
              )}
            </div>
            <button
              className="settings-test-btn"
              type="button"
              disabled={!providerSaved || dirty || connection.isPending || saving}
              onClick={() => connection.mutate()}
            >
              {connection.isPending
                ? <LoaderCircle size={14} className="spin" aria-hidden />
                : <PlugZap size={14} aria-hidden />}
              {connection.isPending ? "Testing…" : "Test connection"}
            </button>
          </div>
        )}
      </section>
      <div className="settings-footer">
        <button
          type="button"
          className="btn-secondary"
          disabled={!dirty || saving}
          onClick={cancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!dirty || saving}
          onClick={save}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

export function Settings() {
  const { category } = useParams({ from: "/settings/$category" });
  const router = useRouter();
  const backHref = useSettingsBackHref();
  const goBack = () => router.history.push(backHref);

  return (
    <div className="settings-shell">
      <aside className="settings-rail">
        <button type="button" className="settings-back" onClick={goBack}>
          <ArrowLeft size={16} aria-hidden />
          <span>Back to app</span>
        </button>
        <h1>Settings</h1>
        <nav aria-label="Settings categories">
          <Link
            to="/settings/$category"
            params={{ category: "general" }}
            className="settings-nav-link"
            aria-current={category === "general" ? "page" : undefined}
          >
            <SlidersHorizontal size={16} aria-hidden />
            <span>General</span>
          </Link>
        </nav>
      </aside>
      <main className="settings-main">
        {category === "general" ? (
          <GeneralSettingsPane />
        ) : (
          <div className="settings-not-found" role="status">
            <h2>Settings category not found</h2>
            <p>There is no settings category named “{category}”.</p>
            <Link to="/settings/$category" params={{ category: "general" }}>Open General settings</Link>
          </div>
        )}
      </main>
    </div>
  );
}
