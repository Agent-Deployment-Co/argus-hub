import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { compactProject, dayStamp } from "../lib/format";
import { FilterBar } from "../components/FilterBar";
import { TaskTiles } from "../components/TaskTiles";
import { TaskDistributions } from "../components/TaskDistributions";
import { TaskSuccessTrend } from "../components/TaskSuccessTrend";
import { TaskQualityByUser, TaskQualityBySource, TaskQualityByProject } from "../components/TaskQuality";
import { TaskSignalsAndFriction } from "../components/TaskSignalsAndFriction";
import { useTaskReportQuery } from "../lib/tasks-report";
import { DEFAULT_SINCE, DEFAULT_UNTIL, isFilterActive, sanitizedSource } from "../lib/filters";
import type { TaskListResponse } from "../types";

const NEGATION_RE = /\b(?:un|in|non)\w+|\bnot\s+\w+/;

const OUTCOME_OPTIONS: { key: "success" | "failure" | "unknown"; label: string }[] = [
  { key: "success", label: "Success" },
  { key: "failure", label: "Failure" },
  { key: "unknown", label: "Unknown" },
];

interface TaskFilters {
  q: string;
  outcome: string[];
  user: string;
  since: string;
  until: string;
  source: string;
}

async function fetchTasks(f: TaskFilters): Promise<TaskListResponse> {
  const params = new URLSearchParams({ limit: "100", since: f.since, until: f.until });
  if (f.q) params.set("q", f.q);
  if (f.outcome.length) params.set("outcome", f.outcome.join(","));
  if (f.user) params.set("user", f.user);
  const source = sanitizedSource(f.source);
  if (source) params.set("source", source);
  const res = await fetch(`/api/tasks?${params}`);
  if (!res.ok) throw new Error(`Failed to load tasks (${res.status})`);
  return res.json();
}

function outcomePill(outcome?: string): { label: string; cls: string } {
  const v = (outcome ?? "").toLowerCase();
  const negated = NEGATION_RE.test(v);
  if (v.includes("fail") || v.includes("abandon") || v.includes("block")) return { label: outcome!, cls: "task-failure" };
  if (!negated && (v.includes("success") || v.includes("complete") || v.includes("done") || v.includes("resolved"))) {
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

function reportErrorMessage(err: Error): ReactNode {
  if (err.message === "No data yet.") {
    return (
      <>
        No data yet. Run <code>argus sync</code> from a client to ingest data.
      </>
    );
  }
  return `Couldn't load data: ${err.message}`;
}

/** How *well* the org's agent work is going — outcomes, friction, and where quality is
 *  slipping (SPEC.md 5) — plus the flat, filterable feed of extracted tasks underneath. */
const routeApi = getRouteApi("/tasks");

export function Tasks() {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const q = search.q ?? "";
  const outcome = search.outcome ?? [];
  const user = search.user ?? "";
  const since = search.since ?? DEFAULT_SINCE();
  const until = search.until ?? DEFAULT_UNTIL();
  const source = search.source ?? "";
  const [draft, setDraft] = useState(q);
  const [openId, setOpenId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["tasks", q, outcome, user, since, until, source],
    queryFn: () => fetchTasks({ q, outcome, user, since, until, source }),
    staleTime: 30_000,
  });
  const reportQuery = useTaskReportQuery({ since, until, source, userId: user });
  const report = reportQuery.data;

  const toggleOutcome = (key: string) => {
    const next = outcome.includes(key) ? outcome.filter((o: string) => o !== key) : [...outcome, key];
    navigate({ to: ".", search: { ...search, outcome: next.length ? next : undefined }, replace: true });
  };

  const patchFilters = (patch: Partial<{ since: string; until: string; source: string; userId: string }>) =>
    navigate({
      to: ".",
      search: {
        ...search,
        since: "since" in patch ? patch.since || undefined : search.since,
        until: "until" in patch ? patch.until || undefined : search.until,
        source: "source" in patch ? patch.source || undefined : search.source,
        user: "userId" in patch ? patch.userId || undefined : search.user,
      },
      replace: true,
    });

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
      <FilterBar
        since={since}
        until={until}
        source={source}
        userId={user}
        showUser
        loading={query.isFetching}
        onChange={patchFilters}
        onReset={() => { setDraft(""); navigate({ to: ".", search: {}, replace: true }); }}
        resettable={isFilterActive(search, { since: DEFAULT_SINCE(), until: DEFAULT_UNTIL() }) || !!q || outcome.length > 0}
      />
      <div className="page-head">
        <h1>Tasks</h1>
      </div>
      {reportQuery.isPending ? (
        <div className="center-state">Loading…</div>
      ) : reportQuery.isError ? (
        <div className="center-state">{reportErrorMessage(reportQuery.error as Error)}</div>
      ) : (
        <>
          <section>
            <TaskTiles totals={report!.totals} />
          </section>
          <section>
            <TaskDistributions outcomes={report!.outcomes} frustration={report!.frustration} />
          </section>
          <section>
            <TaskSuccessTrend daily={report!.daily} />
          </section>
          <TaskQualityByUser rows={report!.byUser} minCohortGuard={report!.minCohortGuard} />
          <TaskQualityBySource rows={report!.bySource} />
          <TaskQualityByProject rows={report!.byProject} />
          <TaskSignalsAndFriction signals={report!.topSignals} friction={report!.friction} />
        </>
      )}
      <div className="page-head">
        <h2>Task list</h2>
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
