import { Link, useParams, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Check, LoaderCircle, Lock, Pencil, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
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
  values["llm.provider"] = typeof providerSetting?.value === "string" ? providerSetting.value : "";
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
  onBlur,
}: {
  descriptor: SettingDescriptor;
  provider: LlmProvider;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const Input = descriptor.control === "textarea" ? "textarea" : "input";
  return (
    <div className="settings-row">
      <label htmlFor={`setting-${descriptor.field}`} className="settings-row-copy">
        <span className="settings-row-label">{descriptor.label}</span>
        {descriptor.description && <span className="settings-row-description">{descriptor.description}</span>}
      </label>
      <Input
        id={`setting-${descriptor.field}`}
        className={`settings-control${descriptor.control === "textarea" ? " settings-textarea" : ""}`}
        value={value}
        placeholder={descriptor.placeholderByProvider?.[provider]}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={onBlur}
      />
    </div>
  );
}

function SecretField({ provider, onChanged }: { provider: LlmProvider; onChanged: () => void }) {
  const status = useSecretStatusQuery(provider);
  const save = useSaveSecretMutation(provider);
  const remove = useDeleteSecretMutation(provider);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const error = save.error ?? remove.error ?? status.error;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!value.trim()) return;
    save.mutate(value, {
      onSuccess: () => {
        setValue("");
        setEditing(false);
        onChanged();
      },
    });
  };
  const cancel = () => {
    setEditing(false);
    setValue("");
    save.reset();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      cancel();
    }
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
          <form className="settings-secret-form" onSubmit={submit}>
            <input
              autoFocus={editing}
              className="settings-control settings-secret-input"
              type="password"
              data-1p-ignore
              aria-label={status.data?.configured ? "Replacement API key" : "API key"}
              autoComplete="new-password"
              placeholder={status.data?.configured ? "New API key" : "Paste API key"}
              value={value}
              disabled={save.isPending}
              onChange={(event) => setValue(event.currentTarget.value)}
              onKeyDown={escape}
            />
            <button
              className="settings-secret-icon-btn"
              type="submit"
              title="Save key"
              aria-label="Save key"
              disabled={!value.trim() || save.isPending}
            >
              {save.isPending
                ? <LoaderCircle size={15} className="spin" aria-hidden />
                : <Check size={15} aria-hidden />}
            </button>
            {status.data?.configured && (
              <button
                className="settings-secret-icon-btn"
                type="button"
                title="Cancel"
                aria-label="Cancel"
                disabled={save.isPending}
                onClick={cancel}
              >
                <X size={15} aria-hidden />
              </button>
            )}
          </form>
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
              onClick={() => setEditing(true)}
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

  const section = settings.data?.categories[0].sections[0];
  const provider = (values["llm.provider"] || null) as LlmProvider | null;
  const providerDescriptor = section?.settings.find((setting) => setting.path === "llm.provider");
  const providerSaved = !!provider && providerDescriptor?.value === provider;
  const visibleFields = useMemo(() => section?.settings.filter((setting) =>
    setting.providerScoped && providerSaved && setting.visibleWhen?.in.includes(provider!)) ?? [],
  [section, provider, providerSaved]);
  const needsKey = !!provider && providerSaved && section?.secretField.providers.includes(provider);

  const setLocal = (path: string, value: string) => {
    setValues((current) => ({ ...current, [path]: value }));
    connection.reset();
  };
  const persist = (path: string, value: string) => {
    void saveQueue.save(path, value).catch(() => undefined);
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
            onChange={(event) => {
              const value = event.currentTarget.value;
              setLocal("llm.provider", value);
              persist("llm.provider", value);
            }}
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
        {provider && providerSaved && visibleFields.map((descriptor) => {
          const path = writePath(provider, descriptor.field!);
          return (
            <PlainField
              key={path}
              descriptor={descriptor}
              provider={provider}
              value={values[path] ?? ""}
              onChange={(value) => setLocal(path, value)}
              onBlur={() => persist(path, values[path] ?? "")}
            />
          );
        })}
        {provider && providerSaved && needsKey && (
          <SecretField key={provider} provider={provider} onChanged={() => {
            connection.reset();
            void settings.refetch();
          }} />
        )}
        <div className="settings-test-row">
          <div className="settings-row-copy">
            <span className="settings-row-label">Test connection</span>
            <span className="settings-row-description">
              {providerSaved
                ? "Send a tiny completion using the saved provider settings."
                : "Choose and save a provider to enable connection testing."}
            </span>
            {connection.data && (
              <span className={connection.data.ok ? "settings-test-success" : "settings-inline-error"} role="status">
                {connection.data.ok
                  ? `Connected${connection.data.model ? ` with ${connection.data.model}` : ""}.`
                  : connection.data.error}
              </span>
            )}
            {connection.error && <span className="settings-inline-error" role="alert">{connection.error.message}</span>}
          </div>
          <button
            className="btn-secondary"
            type="button"
            disabled={!providerSaved || connection.isPending || saveQueue.status.state === "saving"}
            onClick={() => connection.mutate()}
          >
            {connection.isPending ? "Testing…" : "Test connection"}
          </button>
        </div>
      </section>
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
          <ArrowLeft size={17} aria-hidden />
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
            <SlidersHorizontal size={17} aria-hidden />
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
