import { fmt } from "../lib/format";
import { StatCards, type Stat } from "./StatCards";
import type { FrictionTotals, TaskSignalRow } from "../types";

/** Top signals across failed/frustrated tasks, ranked by frequency (SPEC.md 5.4) — a
 *  ready-made list of what's going wrong org-wide. */
function TaskSignals({ signals }: { signals: TaskSignalRow[] }) {
  return (
    <div className="panel">
      <h3>Top signals</h3>
      {signals.length === 0 ? (
        <p className="muted">No signals recorded on failed or frustrated tasks in this window.</p>
      ) : (
        <ol className="rank-list">
          {signals.map((s, i) => (
            <li key={s.signal} className="rank-row">
              <span className="rank-num">{i + 1}</span>
              <span className="rank-name">{s.signal}</span>
              <span className="rank-score">{fmt(s.count)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Interruptions/rejections/compactions rolled up for the window (SPEC.md 5.4). codex/gemini
 *  leave these null at the source, so `observableSessions` distinguishes "no friction data
 *  available" from "zero friction" rather than silently implying a clean run. */
function TaskFriction({ friction }: { friction: FrictionTotals }) {
  const stats: Stat[] = [
    { label: "Sessions observed", value: fmt(friction.observableSessions) },
    { label: "Interruptions", value: fmt(friction.interruptions) },
    { label: "Permission rejections", value: fmt(friction.rejections) },
    { label: "Compactions", value: fmt(friction.compactions) },
  ];
  return (
    <div className="panel">
      <h3>Friction rollup</h3>
      {friction.observableSessions === 0 ? (
        <p className="muted">
          No friction data available for this window — only Claude/Cowork sessions report it;
          codex/gemini leave it unknown, not zero.
        </p>
      ) : (
        <>
          <StatCards stats={stats} />
          <p className="note">
            Counted only over sessions with known friction data (Claude/Cowork). codex/gemini
            leave these fields unknown rather than zero, so they're excluded here rather than
            implying a clean run the Hub can't attest to.
          </p>
        </>
      )}
    </div>
  );
}

export function TaskSignalsAndFriction({ signals, friction }: { signals: TaskSignalRow[]; friction: FrictionTotals }) {
  return (
    <section>
      <h2>Signals &amp; friction</h2>
      <div className="grid2">
        <TaskSignals signals={signals} />
        <TaskFriction friction={friction} />
      </div>
    </section>
  );
}
