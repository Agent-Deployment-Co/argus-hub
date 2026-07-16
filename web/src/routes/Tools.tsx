import { getRouteApi } from "@tanstack/react-router";
import type { ChartOptions } from "chart.js";
import { ChartCanvas } from "../components/charts/ChartCanvas";
import { DataTable, type Column } from "../components/DataTable";
import { FilterBar } from "../components/FilterBar";
import { Dash, Skills } from "../components/pills";
import { StatCards } from "../components/StatCards";
import { CATEGORY_PALETTE, fmt, SERIES, SKILL_PALETTE, sourceColor, usd } from "../lib/format";
import { sourceLabel } from "../lib/filters";
import { DEFAULT_SINCE, DEFAULT_UNTIL, isFilterActive } from "../lib/filters";
import { SnapshotProvider, useSnapshot, useSnapshotQuery } from "../lib/snapshot";
import type {
  PluginRow,
  ReachRow,
  SourceBreakdownRow,
  ToolStat,
  UnderusedRow,
} from "../types";

const fmtTick = (v: number | string) => fmt(Number(v));
const UNATTRIBUTED_SKILL = "(none)";

function bySourceBars(rows: SourceBreakdownRow[], sources: string[]) {
  return {
    labels: rows.map((r) => r.display),
    datasets: sources.map((src) => ({
      label: sourceLabel(src),
      data: rows.map((r) => r.bySource[src] ?? 0),
      backgroundColor: sourceColor(src),
    })),
  };
}

const toolColumns: Column<ToolStat>[] = [
  { id: "display", label: "Tool", sortValue: (r) => r.display, cell: (r) => r.display },
  { id: "category", label: "Category", sortValue: (r) => r.category, cell: (r) => <span className="pill">{r.category}</span> },
  { id: "calls", label: "Calls", num: true, sortValue: (r) => r.calls, cell: (r) => fmt(r.calls) },
  { id: "sessions", label: "Sessions", num: true, sortValue: (r) => r.sessions, cell: (r) => r.sessions },
  { id: "users", label: "Users", num: true, sortValue: (r) => r.users, cell: (r) => r.users },
  {
    id: "sources", label: "Sources", sortValue: (r) => Object.keys(r.bySource).length,
    cell: (r) => Object.keys(r.bySource).sort().map((s) => sourceLabel(s)).join(", ") || <Dash />,
  },
  { id: "resultTokens", label: "Result tokens", num: true, sortValue: (r) => r.approxResultTokens, cell: (r) => fmt(r.approxResultTokens) },
];

const underusedColumns: Column<UnderusedRow>[] = [
  { id: "kind", label: "Kind", sortValue: (r) => r.kind, cell: (r) => <span className="pill">{r.kind}</span> },
  { id: "display", label: "Name", sortValue: (r) => r.display, cell: (r) => r.display },
  { id: "calls", label: "Calls", num: true, sortValue: (r) => r.calls, cell: (r) => fmt(r.calls) },
  { id: "users", label: "Users", num: true, sortValue: (r) => r.users, cell: (r) => r.users },
];

const sharedVsSoloColumns: Column<ReachRow>[] = [
  { id: "kind", label: "Kind", sortValue: (r) => r.kind, cell: (r) => <span className="pill">{r.kind}</span> },
  { id: "name", label: "Name", sortValue: (r) => r.name, cell: (r) => r.name },
  { id: "users", label: "Users", num: true, sortValue: (r) => r.users, cell: (r) => r.users },
  { id: "calls", label: "Calls", num: true, sortValue: (r) => r.calls, cell: (r) => fmt(r.calls) },
  {
    id: "shared", label: "Reach", sortValue: (r) => (r.shared ? 1 : 0),
    cell: (r) => (r.shared ? <span className="pill on">shared</span> : <span className="pill">solo</span>),
  },
];

function pluginColumns(): Column<PluginRow>[] {
  return [
    {
      id: "name", label: "Plugin", sortValue: (r) => r.name,
      cell: (r) => <>{r.name}{r.marketplace && <span className="muted"> @{r.marketplace}</span>}</>,
    },
    {
      id: "status", label: "Observed reach", sortValue: (r) => (r.used ? r.users : -1),
      cell: (r) => r.used
        ? <span className="pill on">{r.users} user{r.users === 1 ? "" : "s"} · {r.sources.map(sourceLabel).join(", ")}</span>
        : <span className="pill">not observed</span>,
    },
    { id: "skills", label: "Skills used", sortValue: (r) => r.skills.length, cell: (r) => <Skills skills={r.skills} /> },
    { id: "skillMessages", label: "Responses", num: true, sortValue: (r) => r.skillMessages, cell: (r) => fmt(r.skillMessages) },
    { id: "skillTokens", label: "Tokens", num: true, sortValue: (r) => r.skillTokens, cell: (r) => fmt(r.skillTokens) },
    { id: "mcpCalls", label: "MCP calls", num: true, sortValue: (r) => r.mcpCalls, cell: (r) => (r.mcpCalls ? r.mcpCalls : <Dash />) },
    { id: "skillCost", label: "Cost", num: true, sortValue: (r) => r.skillCost, cell: (r) => (r.skillCost ? usd(r.skillCost) : <Dash />) },
  ];
}

function ToolsContent() {
  const { dashboard: d } = useSnapshot();
  const sk = d.bySkill.filter((s) => s.name !== UNATTRIBUTED_SKILL).slice(0, 12);
  const skillNames = sk.map((s) => s.name);
  const tc = d.byToolCategory;
  const tr = d.byTool.slice(0, 15);
  const mcp = d.byMcpServer.slice(0, 12);
  const ht = d.heaviestToolResults.slice(0, 12);
  const skillReach = d.skillInvocations.filter((s) => s.name !== UNATTRIBUTED_SKILL);

  // ---- overview / concentration ----
  const totalToolCalls = d.byTool.reduce((n, t) => n + t.calls, 0);
  const top3Calls = [...d.byTool].sort((a, b) => b.calls - a.calls).slice(0, 3).reduce((n, t) => n + t.calls, 0);
  const top3Share = totalToolCalls > 0 ? Math.round((100 * top3Calls) / totalToolCalls) : 0;
  const mcpTotalCalls = d.byMcpServer.reduce((n, m) => n + m.calls, 0);
  const longTailMcp = d.byMcpServer.filter((m) => mcpTotalCalls > 0 && m.calls / mcpTotalCalls < 0.01).length;

  const overviewStats = [
    { label: "Tools used", value: fmt(d.byTool.length) },
    { label: "Skills used", value: fmt(skillReach.length) },
    { label: "MCP servers used", value: fmt(d.byMcpServer.length) },
    { label: "Plugins observed", value: fmt(d.byPlugin.filter((p) => p.used).length) },
  ];

  const sources = d.sourceComparison.sources;

  return (
    <>
      <section>
        <h2>Access layer overview</h2>
        <StatCards stats={overviewStats} />
        <p className="note">
          Top 3 tools account for <strong>{top3Share}%</strong> of all tool calls this window
          {longTailMcp > 0 && <> · <strong>{longTailMcp}</strong> MCP server{longTailMcp === 1 ? "" : "s"} each account for
            &lt;1% of MCP calls</>}. All figures are <strong>observed usage</strong> — the hub has no
          record of what's installed or enabled, only what was invoked.
        </p>
      </section>

      <section>
        <h2>What people aren't using</h2>
        {d.underused.length === 0 ? (
          <p className="note">Nothing stands out as rarely reached this window.</p>
        ) : (
          <DataTable columns={underusedColumns} rows={d.underused} initialSort="calls" />
        )}
        <p className="note">
          Rarely-reached tools/skills/MCP servers, by observed calls or single-user reach — <em>not</em> a
          list of what's installed but unused. The hub only sees invocations, so "installed but never
          invoked" can't be computed from this data (it would require a client-side inventory upload).
        </p>
      </section>

      <section>
        <h2>MCP servers</h2>
        <div className="grid2">
          <div className="panel">
            <h3>MCP server calls</h3>
            <ChartCanvas
              type="bar"
              height={240}
              data={{ labels: mcp.map((m) => m.server), datasets: [{ label: "calls", data: mcp.map((m) => m.calls), backgroundColor: SERIES.input }] }}
              options={{
                indexAxis: "y",
                plugins: {
                  legend: { display: false },
                  tooltip: { callbacks: { afterLabel: (c) => mcp[c.dataIndex]!.topTools.slice(0, 4).map((x) => `${x.tool} (${x.count})`).join("\n") } },
                },
              } satisfies ChartOptions<"bar">}
            />
          </div>
          <div className="panel">
            <h3>Heaviest tool results (approx tokens dumped into context)</h3>
            <ChartCanvas
              type="bar"
              height={240}
              data={{ labels: ht.map((t) => t.tool), datasets: [{ label: "approx tokens", data: ht.map((t) => t.approxTokens), backgroundColor: SERIES.output }] }}
              options={{
                indexAxis: "y",
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${fmt(Number(c.parsed.x))} tok · ${ht[c.dataIndex]!.count} results` } } },
                scales: { x: { ticks: { callback: fmtTick } } },
              } satisfies ChartOptions<"bar">}
            />
            <p className="note">Approximate (≈chars/4). Shows which tools flood context — useful for trimming.</p>
          </div>
        </div>
        <div style={{ marginTop: 24 }}>
          <DataTable
            columns={[
              { id: "server", label: "Server", sortValue: (r) => r.server, cell: (r) => r.server },
              { id: "calls", label: "Calls", num: true, sortValue: (r) => r.calls, cell: (r) => fmt(r.calls) },
              { id: "users", label: "Users", num: true, sortValue: (r) => r.users, cell: (r) => r.users },
              {
                id: "perCall", label: "Tokens / call", num: true,
                sortValue: (r) => (r.calls > 0 ? r.approxResultTokens / r.calls : 0),
                cell: (r) => fmt(r.calls > 0 ? Math.round(r.approxResultTokens / r.calls) : 0),
              },
              {
                id: "sources", label: "Sources", sortValue: (r) => Object.keys(r.bySource).length,
                cell: (r) => Object.keys(r.bySource).sort().map((s) => sourceLabel(s)).join(", ") || <Dash />,
              },
            ]}
            rows={d.byMcpServer}
            initialSort="calls"
          />
        </div>
        <p className="note">
          Reach vs. weight: a server with many calls but low tokens/call is cheap and popular; high
          tokens/call with few users floods context for just one person — a trimming candidate.
        </p>
      </section>

      {d.toolFriction.coverage >= 0.05 && d.toolFriction.byTool.length > 0 && (
        <section>
          <h2>Where people encounter issues</h2>
          <DataTable
            columns={[
              { id: "tool", label: "Tool", sortValue: (r) => r.tool, cell: (r) => r.tool },
              { id: "stopReason", label: "Stop reason", sortValue: (r) => r.stopReason, cell: (r) => <span className="pill">{r.stopReason}</span> },
              { id: "count", label: "Count", num: true, sortValue: (r) => r.count, cell: (r) => fmt(r.count) },
            ]}
            rows={d.toolFriction.byTool}
            initialSort="count"
          />
          <p className="note">
            Anomalous stop reasons (max_tokens, stop_sequence, refusals, tool errors — excludes the
            expected end_turn/tool_use) on the interaction that invoked each tool — a per-tool issue
            signal. Rejections at the permission prompt can't be attributed to a specific tool from
            stored data (only an org-wide count exists, see
            Recommendations); this table only covers stop reasons.
          </p>
        </section>
      )}

      <section>
        <h2>Skills</h2>
        <div className="grid2">
          <div className="panel">
            <h3>Top skills by tokens</h3>
            <ChartCanvas
              type="bar"
              height={260}
              data={{ labels: sk.map((s) => s.name), datasets: [{ label: "tokens", data: sk.map((s) => s.total), backgroundColor: SERIES.cacheWrite }] }}
              options={{
                indexAxis: "y",
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${fmt(Number(c.parsed.x))} tok · ${usd(sk[c.dataIndex]!.cost)} · ${sk[c.dataIndex]!.messages} msgs` } } },
                scales: { x: { ticks: { callback: fmtTick } } },
              } satisfies ChartOptions<"bar">}
            />
            <p className="note">Token attribution is exact — usage and the active skill are recorded on the same message.</p>
          </div>
          <div className="panel">
            <h3>Skill usage over time</h3>
            {skillNames.length > 0 && (
              <ChartCanvas
                type="bar"
                height={260}
                data={{
                  labels: d.bySkillDaily.map((x) => x.date),
                  datasets: skillNames.map((name, i) => ({
                    label: name,
                    data: d.bySkillDaily.map((x) => x.bySkill[name] ?? 0),
                    backgroundColor: SKILL_PALETTE[i % SKILL_PALETTE.length],
                    stack: "s",
                  })),
                }}
                options={{
                  plugins: { legend: { position: "right" }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(Number(c.parsed.y))} tok` } } },
                  scales: { x: { stacked: true, ticks: { maxRotation: 90, minRotation: 45 } }, y: { stacked: true, ticks: { callback: fmtTick } } },
                } satisfies ChartOptions<"bar">}
              />
            )}
          </div>
        </div>
        <div style={{ marginTop: 24 }}>
          <DataTable
            columns={[
              { id: "name", label: "Skill", sortValue: (r) => r.name, cell: (r) => r.name },
              { id: "count", label: "Invocations", num: true, sortValue: (r) => r.count, cell: (r) => fmt(r.count) },
              { id: "users", label: "Users", num: true, sortValue: (r) => r.users, cell: (r) => r.users },
              {
                id: "sources", label: "Sources", sortValue: (r) => Object.keys(r.bySource).length,
                cell: (r) => Object.keys(r.bySource).sort().map((s) => sourceLabel(s)).join(", ") || <Dash />,
              },
              { id: "sampleArgs", label: "Sample call", cell: (r) => <code className="muted">{r.sampleArgs.slice(0, 80) || "—"}</code> },
            ]}
            rows={skillReach}
            initialSort="count"
          />
        </div>
        <p className="note">Distinct-user reach is what separates a genuinely shared skill from one power-user's habit.</p>
      </section>

      <section>
        <h2>Tools</h2>
        <div className="grid2">
          <div className="panel">
            <h3>Tool calls by category</h3>
            <ChartCanvas
              type="doughnut"
              height={240}
              data={{ labels: tc.map((c) => c.label), datasets: [{ data: tc.map((c) => c.calls), backgroundColor: CATEGORY_PALETTE }] }}
              options={{
                plugins: { legend: { position: "right" }, tooltip: { callbacks: { label: (c) => `${c.label}: ${fmt(Number(c.parsed))} calls · ${tc[c.dataIndex]!.tools} tools` } } },
                scales: { x: { display: false }, y: { display: false } },
              } satisfies ChartOptions<"doughnut">}
            />
          </div>
          <div className="panel">
            <h3>Most-used tools (by calls)</h3>
            <ChartCanvas
              type="bar"
              height={240}
              data={{ labels: tr.map((t) => t.display), datasets: [{ label: "calls", data: tr.map((t) => t.calls), backgroundColor: SERIES.input }] }}
              options={{
                indexAxis: "y",
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${fmt(Number(c.parsed.x))} calls · ${tr[c.dataIndex]!.sessions} sessions · ${tr[c.dataIndex]!.category}` } } },
                scales: { x: { ticks: { callback: fmtTick } } },
              } satisfies ChartOptions<"bar">}
            />
          </div>
        </div>
        <div style={{ marginTop: 24 }}>
          <DataTable columns={toolColumns} rows={d.byTool} initialSort="calls" />
        </div>
        <p className="note">MCP tool names are displayed as <code>server · tool</code>.</p>
      </section>

      <section>
        <h2>Plugins</h2>
        <DataTable columns={pluginColumns()} rows={d.byPlugin} initialSort="skillTokens" />
        <p className="note">
          "Observed reach" reflects invocations seen by the hub, not a config read — the hub cannot
          tell an enabled-but-unused plugin from one that isn't installed at all, so there's no
          enabled/disabled status here (only used / not observed).
        </p>
      </section>

      {d.minCohortGuard ? (
        <section>
          <h2>Shared vs. solo</h2>
          <p className="note">Withheld — fewer than 3 distinct users have observed activity in this window.</p>
        </section>
      ) : (
        <section>
          <h2>Shared vs. solo</h2>
          <DataTable columns={sharedVsSoloColumns} rows={d.sharedVsSolo} initialSort="users" />
          <p className="note">
            "Shared" = used by 3+ distinct users (an observed-usage proxy, not a config read — the hub
            sees who invoked something, not who has it configured). "Solo" items are candidates for
            promoting to the team, or for confirming they're meant to stay personal.
          </p>
        </section>
      )}

      {sources.length > 1 && (
        <section>
          <h2>Claude / Codex</h2>
          <div className="panel">
            <h3>Category mix by source</h3>
            <ChartCanvas
              type="bar"
              height={280}
              data={bySourceBars(d.sourceComparison.byCategory, sources)}
              options={{
                indexAxis: "y",
                plugins: { legend: { position: "right" } },
                scales: { x: { ticks: { callback: fmtTick } } },
              } satisfies ChartOptions<"bar">}
            />
          </div>
          <div className="grid2" style={{ marginTop: 16 }}>
            <div className="panel">
              <h3>Top tools by source</h3>
              <ChartCanvas
                type="bar"
                height={260}
                data={bySourceBars(d.sourceComparison.topTools, sources)}
                options={{ indexAxis: "y", plugins: { legend: { position: "right" } }, scales: { x: { ticks: { callback: fmtTick } } } } satisfies ChartOptions<"bar">}
              />
            </div>
            <div className="panel">
              <h3>Top skills by source</h3>
              <ChartCanvas
                type="bar"
                height={260}
                data={bySourceBars(d.sourceComparison.topSkills, sources)}
                options={{ indexAxis: "y", plugins: { legend: { position: "right" } }, scales: { x: { ticks: { callback: fmtTick } } } } satisfies ChartOptions<"bar">}
              />
            </div>
          </div>
          <div className="panel" style={{ marginTop: 16 }}>
            <h3>Top MCP servers by source</h3>
            <ChartCanvas
              type="bar"
              height={240}
              data={bySourceBars(d.sourceComparison.topMcpServers, sources)}
              options={{ indexAxis: "y", plugins: { legend: { position: "right" } }, scales: { x: { ticks: { callback: fmtTick } } } } satisfies ChartOptions<"bar">}
            />
          </div>
          <p className="note">
            Compared by category (stable across sources, since Claude and Codex name tools
            differently — e.g. <code>Read</code>/<code>Bash</code> vs. <code>read_file</code>/<code>run_shell_command</code>)
            with raw tool/skill/server names as the drill-down.
          </p>
        </section>
      )}

      <section>
        <h2>Token usage</h2>
        <p className="note">
          Context weight spans both sides of the access layer: tokens generated while a skill runs
          (exact, above) and tokens dumped into context by tool results (approximate, above). See
          Activity for the org-wide cost-over-time and cost-by-model breakdown.
        </p>
      </section>
    </>
  );
}

const routeApi = getRouteApi("/tools");

/** Org-wide access-layer usage — tools, skills, MCP servers, and plugins, scoped to the whole team. */
export function Tools() {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const since = search.since ?? DEFAULT_SINCE();
  const until = search.until ?? DEFAULT_UNTIL();
  const source = search.source ?? "";
  const query = useSnapshotQuery({ since, until, source });
  const snap = query.data;

  const patchFilters = (patch: Partial<{ since: string; until: string; source: string }>) =>
    navigate({
      to: ".",
      search: (prev: { since?: string; until?: string; source?: string }) => ({
        since: "since" in patch ? patch.since || undefined : prev.since,
        until: "until" in patch ? patch.until || undefined : prev.until,
        source: "source" in patch ? patch.source || undefined : prev.source,
      }),
      replace: true,
    });

  return (
    <>
      <FilterBar
        since={since}
        until={until}
        source={source}
        loading={query.isFetching}
        onChange={patchFilters}
        onReset={() => navigate({ to: ".", search: {}, replace: true })}
        resettable={isFilterActive(search, { since: DEFAULT_SINCE(), until: DEFAULT_UNTIL() })}
      />
      <div className="page-head">
        <h1>Tools</h1>
      </div>
      {query.isPending ? (
        <div className="center-state">Loading…</div>
      ) : query.isError ? (
        <div className="center-state">Couldn't load data: {(query.error as Error).message}</div>
      ) : (
        <SnapshotProvider value={snap!}>
          <ToolsContent />
        </SnapshotProvider>
      )}
    </>
  );
}
