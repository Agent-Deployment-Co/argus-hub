import { getRouteApi } from "@tanstack/react-router";
import { compactProject, dayStamp, dtAmPm, dur, fmt, usd } from "../lib/format";
import { useSessionDetail } from "../lib/sessions";

const routeApi = getRouteApi("/sessions/$sessionId");

function sourceLabel(source: string): string {
  return source.charAt(0).toUpperCase() + source.slice(1);
}

export function SessionDetail() {
  const { sessionId } = routeApi.useParams();
  const search = routeApi.useSearch();
  const query = useSessionDetail(sessionId, search.user);

  if (query.isPending) return <div className="session-empty">Loading…</div>;
  if (query.isError) return <div className="session-empty">{(query.error as Error).message}</div>;

  const s = query.data;

  return (
    <div className="session-detail-inner">
      <div className="session-detail-head">
        <div className="session-detail-headline">
          <div className="session-detail-eyebrow">
            <span className="pill">{sourceLabel(s.source)}</span>
            <span className="truncate">{compactProject(s.project)}</span>
            <span className="session-id">{s.sessionId}</span>
          </div>
          <h1 className="session-detail-title">{s.firstPrompt || "(no prompt captured)"}</h1>
          <div className="session-detail-range">
            {dtAmPm(s.start)} → {dtAmPm(s.end)} · {dur(s.durationMs)}
          </div>
        </div>
      </div>

      <p className="summary">{s.summary}</p>

      <section>
        <h3>Overview</h3>
        <div className="kv">
          <div className="kv-row"><span className="kv-k">Messages</span><span className="kv-v">{fmt(s.messages)}</span></div>
          <div className="kv-row"><span className="kv-k">User messages</span><span className="kv-v">{s.userMessages ?? "—"}</span></div>
          <div className="kv-row"><span className="kv-k">Agent messages</span><span className="kv-v">{s.agentMessages ?? "—"}</span></div>
          <div className="kv-row"><span className="kv-k">Turns</span><span className="kv-v">{s.rawTurns ?? s.health.turns ?? "—"}</span></div>
          <div className="kv-row"><span className="kv-k">Total tokens</span><span className="kv-v">{fmt(s.total)}</span></div>
          <div className="kv-row"><span className="kv-k">Est. cost</span><span className="kv-v">{usd(s.cost)}</span></div>
          <div className="kv-row"><span className="kv-k">Interruptions</span><span className="kv-v">{s.health.interruptions ?? "—"}</span></div>
          <div className="kv-row"><span className="kv-k">Rejections</span><span className="kv-v">{s.health.rejections ?? "—"}</span></div>
          <div className="kv-row"><span className="kv-k">Compactions</span><span className="kv-v">{s.health.compactions ?? "—"}</span></div>
        </div>
      </section>

      {s.models.length > 0 && (
        <section>
          <h3>Models</h3>
          <div className="chips">
            {s.models.map((m) => <span key={m} className="chip">{m}</span>)}
          </div>
        </section>
      )}

      {s.topSkills.length > 0 && (
        <section>
          <h3>Top skills</h3>
          <div className="chips">
            {s.topSkills.map((sk) => <span key={sk} className="chip">{sk}</span>)}
          </div>
        </section>
      )}

      {s.filesTouched.length > 0 && (
        <section>
          <h3>Files touched ({s.filesTouched.length})</h3>
          <ul className="file-list">
            {s.filesTouched.slice(0, 40).map((f) => <li key={f}>{f}</li>)}
          </ul>
        </section>
      )}

      {s.firstPrompt && (
        <section>
          <h3>First prompt</h3>
          <pre className="first-prompt">{s.firstPrompt}</pre>
        </section>
      )}

      <section>
        <div className="section-title-row"><h3>Tasks ({s.tasks?.length ?? 0})</h3></div>
        {s.tasks && s.tasks.length > 0 ? (
          <ul className="tasks">
            {s.tasks.map((t) => (
              <li key={t.id}>
                <div className="task-item" style={{ cursor: "default" }}>
                  <span className="task-item-desc" title={t.description}>{t.description}</span>
                  {t.outcome && <span className="pill">{t.outcome}</span>}
                  <span className="task-item-tokens">{t.timestampMs ? dayStamp(t.timestampMs) : "—"}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="task-empty">No tasks found.</p>
        )}
      </section>
    </div>
  );
}
