import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { compactProject, dayStamp } from "../lib/format";
import { StatCards, type Stat } from "../components/StatCards";

interface TaskListItem {
  id: string;
  source: string;
  sessionId: string;
  project: string;
  timestampMs: number | null;
  description: string;
  outcome?: string;
  outcomeReason?: string;
  frustration?: string;
  signals?: string[];
}

interface TaskListCounts {
  success: number;
  failure: number;
  unknown: number;
}

interface TaskListResponse {
  rows: TaskListItem[];
  total: number;
  offset: number;
  limit: number;
  counts: TaskListCounts;
}

interface HubUser {
  userId: string;
  displayName: string;
}

const OUTCOME_OPTIONS: { key: "success" | "failure" | "unknown"; label: string }[] = [
  { key: "success", label: "Success" },
  { key: "failure", label: "Failure" },
  { key: "unknown", label: "Unknown" },
];

async function fetchTasks(q: string, outcome: string[], user: string): Promise<TaskListResponse> {
  const params = new URLSearchParams({ limit: "100" });
  if (q) params.set("q", q);
  if (outcome.length) params.set("outcome", outcome.join(","));
  if (user) params.set("user", user);
  const res = await fetch(`/api/tasks?${params}`);
  if (!res.ok) throw new Error(`Failed to load tasks (${res.status})`);
  return res.json();
}

async function fetchUsers(): Promise<HubUser[]> {
  const res = await fetch("/api/users");
  if (!res.ok) throw new Error(`Failed to load users (${res.status})`);
  const body = await res.json() as { users: HubUser[] };
  return body.users;
}

function outcomePill(outcome?: string): { label: string; cls: string } {
  const v = (outcome ?? "").toLowerCase();
  if (v.includes("fail") || v.includes("abandon") || v.includes("block")) return { label: outcome!, cls: "task-failure" };
  if (v.includes("success") || v.includes("complete") || v.includes("done") || v.includes("resolved")) {
    return { label: outcome!, cls: "task-success" };
  }
  return { label: outcome || "Unclear", cls: "task-unclear" };
}

function frustPill(frustration?: string): { label: string; cls: string } | null {
  if (!frustration) return null;
  const v = frustration.toLowerCase();
  if (v.includes("high") || v.includes("severe")) return { label: frustration, cls: "frust-high" };
  if (v.includes("none") || v === "0") return { label: frustration, cls: "frust-none" };
  return { label: frustration, cls: "frust-low" };
}

/** Flat, cross-session feed of extracted tasks — what the team has been asking their agents
 *  to do, with outcome + frustration signals surfaced for quick scanning. */
const routeApi = getRouteApi("/tasks");

export function Tasks() {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const q = search.q ?? "";
  const outcome = search.outcome ?? [];
  const user = search.user ?? "";
  const [draft, setDraft] = useState(q);
  const [openId, setOpenId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["tasks", q, outcome, user],
    queryFn: () => fetchTasks(q, outcome, user),
    staleTime: 30_000,
  });
  const usersQuery = useQuery({ queryKey: ["users"], queryFn: fetchUsers, staleTime: 30_000 });

  const toggleOutcome = (key: string) => {
    const next = outcome.includes(key) ? outcome.filter((o: string) => o !== key) : [...outcome, key];
    navigate({ to: ".", search: { ...search, outcome: next.length ? next : undefined }, replace: true });
  };

  // Keep the input in sync if the URL changes out from under us (back/forward nav).
  useEffect(() => setDraft(q), [q]);

  useEffect(() => {
    const trimmed = draft.trim();
    if (trimmed === q) return;
    const handle = setTimeout(() => {
      navigate({ to: ".", search: { ...search, q: trimmed || undefined }, replace: true });
    }, 300);
    return () => clearTimeout(handle);
  }, [draft, q, navigate]);

  return (
    <>
      <div className="page-head">
        <h1>Tasks</h1>
      </div>
      <div className="task-filters">
        <div className="task-filters-outcomes" role="group" aria-label="Filter by outcome">
          {OUTCOME_OPTIONS.map((opt) => (
            <label key={opt.key} className="filter-toggle">
              <input
                type="checkbox"
                checked={outcome.includes(opt.key)}
                onChange={() => toggleOutcome(opt.key)}
              />
              {opt.label}
            </label>
          ))}
        </div>
        <div className="task-filters-right">
          <div className="select-wrap">
            <select
              className="filter-input"
              aria-label="Filter by user"
              value={user}
              onChange={(e) =>
                navigate({ to: ".", search: { ...search, user: e.target.value || undefined }, replace: true })
              }
            >
              <option value="">All users</option>
              {usersQuery.data?.map((u) => (
                <option key={u.userId} value={u.userId}>{u.displayName}</option>
              ))}
            </select>
          </div>
          <div className="filter-search">
            <input
              className="filter-input"
              type="search"
              placeholder="Search tasks…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Search tasks"
            />
            {draft && (
              <button
                type="button"
                className="filter-clear"
                aria-label="Clear search"
                onClick={() => {
                  setDraft("");
                  navigate({ to: ".", search: { ...search, q: undefined }, replace: true });
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>
      </div>
      {query.data && (
        <section>
          <StatCards
            stats={
              [
                { label: "Success", value: query.data.counts.success },
                { label: "Failure", value: query.data.counts.failure },
                { label: "Unknown", value: query.data.counts.unknown },
              ] satisfies Stat[]
            }
          />
        </section>
      )}
      {query.isPending ? (
        <div className="center-state">Loading…</div>
      ) : query.isError ? (
        <div className="center-state">Couldn't load data: {(query.error as Error).message}</div>
      ) : query.data.rows.length === 0 ? (
        <p className="muted">No tasks extracted yet. Run <code>argus sync</code> from a client to ingest data.</p>
      ) : (
        <ul className="tasks">
          {query.data.rows.map((t) => {
            const outcome = outcomePill(t.outcome);
            const frust = frustPill(t.frustration);
            const open = openId === t.id;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className={`task-item${open ? " selected" : ""}`}
                  onClick={() => setOpenId(open ? null : t.id)}
                  aria-expanded={open}
                  title={t.description}
                >
                  <span className="task-item-desc">{t.description}</span>
                  <span className="pill">{compactProject(t.project)}</span>
                  {frust && <span className={`pill ${frust.cls}`}>{frust.label}</span>}
                  <span className={`pill ${outcome.cls}`}>{outcome.label}</span>
                  <span className="task-item-tokens">
                    {t.timestampMs ? dayStamp(t.timestampMs) : "—"}
                  </span>
                </button>
                {open && (
                  <div className="task-card">
                    <div className="task-panel-body">
                      <div className="task-panel-field">
                        <span className="task-panel-label">Description</span>
                        <span className="task-panel-value task-panel-desc">{t.description}</span>
                      </div>
                      {t.outcomeReason && (
                        <div className="task-panel-field">
                          <span className="task-panel-label">Outcome reason</span>
                          <span className="task-panel-value task-panel-desc">{t.outcomeReason}</span>
                        </div>
                      )}
                      {t.signals && t.signals.length > 0 && (
                        <div className="task-panel-field">
                          <span className="task-panel-label">Signals</span>
                          <span className="task-panel-value">{t.signals.join(", ")}</span>
                        </div>
                      )}
                      <div className="task-panel-field">
                        <span className="task-panel-label">Session</span>
                        <span className="task-panel-value">
                          {t.source} · {t.project} · {t.sessionId}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
