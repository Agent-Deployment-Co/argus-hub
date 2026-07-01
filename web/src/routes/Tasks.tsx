import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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

async function fetchTasks(q: string): Promise<TaskListResponse> {
  const params = new URLSearchParams({ limit: "100" });
  if (q) params.set("q", q);
  const res = await fetch(`/api/tasks?${params}`);
  if (!res.ok) throw new Error(`Failed to load tasks (${res.status})`);
  return res.json();
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
export function Tasks() {
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["tasks", q], queryFn: () => fetchTasks(q), staleTime: 30_000 });

  return (
    <>
      <div className="page-head">
        <h1>Tasks</h1>
        <input
          className="filter-input"
          type="search"
          placeholder="Search tasks…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search tasks"
        />
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
