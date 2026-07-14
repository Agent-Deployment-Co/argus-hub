import { skillPlugin } from "./inventory.ts";
import { cost, unpricedModels } from "../pricing.ts";
import { MIN_COHORT_FOR_RANKINGS } from "./activity.ts";
import { CATEGORY_LABELS, parseMcpTool, toolDisplayName, UNATTRIBUTED_SKILL } from "../tool-categories.ts";
import type {
  AgentSource,
  Dashboard,
  DashboardAggregates,
  DayBucket,
  NamedUsage,
  PluginInfo,
  PluginRow,
  ReachRow,
  SourceBreakdownRow,
  SourceComparison,
  ToolCategoryStat,
  ToolFriction,
  ToolStat,
  UnderusedRow,
  Usage,
} from "../types.ts";
import { addUsage, emptyUsage, totalTokens } from "../types.ts";

/** Groups rows keyed by `key(r)` into a per-key `source -> value` record. */
function groupBySource<R>(rows: R[], key: (r: R) => string, source: (r: R) => string, value: (r: R) => number): Map<string, Record<string, number>> {
  const map = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const k = key(r);
    const rec = map.get(k) ?? {};
    map.set(k, rec);
    rec[source(r)] = (rec[source(r)] ?? 0) + value(r);
  }
  return map;
}

/** Bottom-decile-by-calls cutoff within a set of comparable items (tools, skills, or MCP servers
 *  considered separately — a heavy tool and a light skill aren't the same population). */
function decileCutoff(calls: number[]): number {
  if (calls.length === 0) return 0;
  const sorted = [...calls].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.1);
  return sorted[Math.min(idx, sorted.length - 1)]!;
}

export function assembleDashboard(agg: DashboardAggregates, plugins: Map<string, PluginInfo>): Dashboard {
  // ---- daily / totals / byModel / byModelDaily ----
  const dayMap = new Map<string, DayBucket>();
  const modelDayMap = new Map<string, Map<string, number>>();
  const modelMap = new Map<string, { u: Usage; messages: number; cost: number }>();
  const totalUsage = emptyUsage();
  let totalCost = 0;
  let totalMessages = 0;
  for (const r of agg.usageByDateModel) {
    const c = cost(r.usage, r.model);
    let day = dayMap.get(r.date);
    if (!day) {
      day = { date: r.date, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
      dayMap.set(r.date, day);
    }
    day.input += r.usage.input;
    day.output += r.usage.output;
    day.cacheRead += r.usage.cacheRead;
    day.cacheWrite += r.usage.cacheWrite5m + r.usage.cacheWrite1h;
    day.total += totalTokens(r.usage);
    day.cost += c;

    let mdRow = modelDayMap.get(r.date);
    if (!mdRow) { mdRow = new Map(); modelDayMap.set(r.date, mdRow); }
    mdRow.set(r.model, (mdRow.get(r.model) ?? 0) + totalTokens(r.usage));

    const md = modelMap.get(r.model) ?? { u: emptyUsage(), messages: 0, cost: 0 };
    addUsage(md.u, r.usage);
    md.messages += r.messages;
    md.cost += c;
    modelMap.set(r.model, md);

    addUsage(totalUsage, r.usage);
    totalCost += c;
    totalMessages += r.messages;
  }
  const dates = [...dayMap.keys()].sort();
  const daily = dates.map((d) => dayMap.get(d)!);
  const byModelDaily = dates.map((d) => ({ date: d, byModel: Object.fromEntries(modelDayMap.get(d) ?? []) }));

  // ---- bySkillDaily ----
  const skillDayMap = new Map<string, Map<string, number>>();
  for (const r of agg.skillTokensByDate) {
    let row = skillDayMap.get(r.date);
    if (!row) { row = new Map(); skillDayMap.set(r.date, row); }
    row.set(r.skill, (row.get(r.skill) ?? 0) + r.total);
  }
  const bySkillDaily = dates.map((d) => ({ date: d, bySkill: Object.fromEntries(skillDayMap.get(d) ?? []) }));

  const byModel: NamedUsage[] = [...modelMap.entries()]
    .map(([name, v]) => ({ name, messages: v.messages, total: totalTokens(v.u), cost: v.cost }))
    .sort((a, b) => b.total - a.total);

  // ---- bySource / byProject / bySkill ----
  const sessionsBySource = new Map(agg.sessionsBySource.map((r) => [r.source, r.sessions]));
  const sessionsByProject = new Map(agg.sessionsByProject.map((r) => [r.project, r.sessions]));
  const projectFriction = new Map(agg.projectFriction.map((r) => [r.project, r.friction]));

  const foldByDimension = <R extends { model: string; usage: Usage; messages: number }>(
    rows: R[],
    keyOf: (row: R) => string,
  ): Map<string, { u: Usage; messages: number; cost: number }> => {
    const map = new Map<string, { u: Usage; messages: number; cost: number }>();
    for (const r of rows) {
      const key = keyOf(r);
      const entry = map.get(key) ?? { u: emptyUsage(), messages: 0, cost: 0 };
      addUsage(entry.u, r.usage);
      entry.messages += r.messages;
      entry.cost += cost(r.usage, r.model);
      map.set(key, entry);
    }
    return map;
  };

  const bySource: NamedUsage[] = [...foldByDimension(agg.usageBySourceModel, (r) => r.source).entries()]
    .map(([name, v]) => ({ name, messages: v.messages, total: totalTokens(v.u), cost: v.cost, meta: { sessions: sessionsBySource.get(name) ?? 0 } }))
    .sort((a, b) => b.total - a.total);

  const bySkill: NamedUsage[] = [...foldByDimension(agg.usageBySkillModel, (r) => r.skill || UNATTRIBUTED_SKILL).entries()]
    .map(([name, v]) => ({ name, messages: v.messages, total: totalTokens(v.u), cost: v.cost, meta: { plugin: skillPlugin(name, plugins) } }))
    .sort((a, b) => b.total - a.total);

  const byProject: NamedUsage[] = [...foldByDimension(agg.usageByProjectModel, (r) => r.project).entries()]
    .map(([name, v]) => {
      const friction = projectFriction.get(name);
      const meta: NamedUsage["meta"] = { sessions: sessionsByProject.get(name) ?? 0 };
      if (friction) meta.friction = friction;
      return { name, messages: v.messages, total: totalTokens(v.u), cost: v.cost, meta };
    })
    .sort((a, b) => b.total - a.total);

  // ---- tool result sizes + call counts ----
  const resultTokensByTool = new Map(agg.toolResultStats.map((r) => [r.tool, r.approxTokens]));
  const toolUsersMap = new Map(agg.toolUsers.map((r) => [r.tool, r.users]));
  const skillUsersMap = new Map(agg.skillUsers.map((r) => [r.skill, r.users]));
  const mcpServerUsersMap = new Map(agg.mcpServerUsers.map((r) => [r.server, r.users]));
  const byToolSourceMap = groupBySource(agg.byToolSource, (r) => r.tool, (r) => r.source, (r) => r.calls);
  const byToolCategorySourceMap = groupBySource(agg.byToolCategorySource, (r) => r.category, (r) => r.source, (r) => r.calls);
  const mcpServersSourceMap = groupBySource(agg.mcpServersSource, (r) => r.server, (r) => r.source, (r) => r.calls);
  const skillInvocationsSourceMap = groupBySource(agg.skillInvocationsSource, (r) => r.skill, (r) => r.source, (r) => r.count);

  const byTool: ToolStat[] = agg.byTool
    .map((r) => ({
      name: r.tool,
      category: r.category,
      display: toolDisplayName(r.tool),
      calls: r.calls,
      sessions: r.sessions,
      approxResultTokens: resultTokensByTool.get(r.tool) ?? 0,
      users: toolUsersMap.get(r.tool) ?? 0,
      bySource: byToolSourceMap.get(r.tool) ?? {},
    }))
    .sort((a, b) => b.calls - a.calls);

  const categoryApprox = new Map<string, number>();
  for (const r of agg.byTool) {
    categoryApprox.set(r.category, (categoryApprox.get(r.category) ?? 0) + (resultTokensByTool.get(r.tool) ?? 0));
  }
  const byToolCategory: ToolCategoryStat[] = agg.byToolCategory
    .map((r) => ({
      category: r.category,
      label: CATEGORY_LABELS[r.category],
      calls: r.calls,
      tools: r.tools,
      sessions: r.sessions,
      approxResultTokens: categoryApprox.get(r.category) ?? 0,
      bySource: byToolCategorySourceMap.get(r.category) ?? {},
    }))
    .sort((a, b) => b.calls - a.calls);

  // ---- MCP servers ----
  const toolsByServer = new Map<string, Array<{ tool: string; count: number }>>();
  for (const r of agg.mcpServerTools) {
    const list = toolsByServer.get(r.server) ?? [];
    list.push({ tool: r.tool, count: r.count });
    toolsByServer.set(r.server, list);
  }
  const byMcpServer = agg.mcpServers
    .map((s) => {
      let approxResultTokens = 0;
      const topTools = (toolsByServer.get(s.server) ?? [])
        .map(({ tool, count }) => {
          approxResultTokens += resultTokensByTool.get(tool) ?? 0;
          return { tool: parseMcpTool(tool)?.tool ?? tool, count };
        })
        .sort((a, b) => b.count - a.count);
      return {
        server: s.server,
        calls: s.calls,
        approxResultTokens,
        topTools,
        users: mcpServerUsersMap.get(s.server) ?? 0,
        bySource: mcpServersSourceMap.get(s.server) ?? {},
      };
    })
    .sort((a, b) => b.calls - a.calls);

  const skillInvocations = agg.skillInvocations
    .map((r) => ({
      name: r.skill,
      count: r.count,
      plugin: skillPlugin(r.skill, plugins),
      sampleArgs: r.sampleArgs,
      users: skillUsersMap.get(r.skill) ?? 0,
      bySource: skillInvocationsSourceMap.get(r.skill) ?? {},
    }))
    .sort((a, b) => b.count - a.count);

  const heaviestToolResults = agg.toolResultStats
    .map((r) => ({ tool: r.tool, count: r.count, approxTokens: r.approxTokens }))
    .sort((a, b) => b.approxTokens - a.approxTokens)
    .slice(0, 15);

  const byPlugin = foldPlugins(bySkill, skillInvocations, byMcpServer, plugins);

  // ---- §3.2 underused (observed usage only — no "installed but never invoked" denominator) ----
  const namedSkillInvocations = skillInvocations.filter((s) => s.name !== UNATTRIBUTED_SKILL);
  const maxObservedUsers = Math.max(
    0,
    ...byTool.map((t) => t.users),
    ...namedSkillInvocations.map((s) => s.users),
    ...byMcpServer.map((m) => m.users),
  );
  const minCohortGuard = maxObservedUsers > 0 && maxObservedUsers < MIN_COHORT_FOR_RANKINGS;

  const toolCutoff = decileCutoff(byTool.map((t) => t.calls));
  const skillCutoff = decileCutoff(namedSkillInvocations.map((s) => s.count));
  const mcpCutoff = decileCutoff(byMcpServer.map((m) => m.calls));
  const underused: UnderusedRow[] = [
    ...byTool
      .filter((t) => t.calls <= toolCutoff || (!minCohortGuard && t.users === 1))
      .map((t): UnderusedRow => ({ kind: "tool", name: t.name, display: t.display, calls: t.calls, users: t.users })),
    ...namedSkillInvocations
      .filter((s) => s.count <= skillCutoff || (!minCohortGuard && s.users === 1))
      .map((s): UnderusedRow => ({ kind: "skill", name: s.name, display: s.name, calls: s.count, users: s.users })),
    ...byMcpServer
      .filter((m) => m.calls <= mcpCutoff || (!minCohortGuard && m.users === 1))
      .map((m): UnderusedRow => ({ kind: "mcp", name: m.server, display: m.server, calls: m.calls, users: m.users })),
  ].sort((a, b) => a.calls - b.calls);

  // ---- §3.7 shared vs. solo (skills + MCP servers, by distinct-user reach) ----
  const sharedVsSolo: ReachRow[] = minCohortGuard
    ? []
    : [
        ...namedSkillInvocations.map((s): ReachRow => ({ kind: "skill", name: s.name, users: s.users, calls: s.count, shared: s.users >= MIN_COHORT_FOR_RANKINGS })),
        ...byMcpServer.map((m): ReachRow => ({ kind: "mcp", name: m.server, users: m.users, calls: m.calls, shared: m.users >= MIN_COHORT_FOR_RANKINGS })),
      ].sort((a, b) => b.users - a.users);

  // ---- §3.8 Claude/Codex source comparison ----
  const sources = [...new Set(bySource.map((s) => s.name))].sort();
  const topTools8 = byTool.slice(0, 8);
  const topSkills8 = namedSkillInvocations.slice(0, 8);
  const topMcp8 = byMcpServer.slice(0, 8);
  const toRow = (key: string, display: string, bySourceMap: Record<string, number>): SourceBreakdownRow => ({ key, display, bySource: bySourceMap });
  const sourceComparison: SourceComparison = {
    sources,
    byCategory: byToolCategory.map((c) => toRow(c.category, c.label, c.bySource)),
    topTools: topTools8.map((t) => toRow(t.name, t.display, t.bySource)),
    topSkills: topSkills8.map((s) => toRow(s.name, s.name, s.bySource)),
    topMcpServers: topMcp8.map((m) => toRow(m.server, m.server, m.bySource)),
  };

  // ---- §3.4 friction on tools ----
  const toolFriction: ToolFriction = { byTool: agg.stopReasonByTool, coverage: agg.invocationSeqCoverage };

  return {
    generatedAtMs: 0,
    range: { start: dates[0] || "", end: dates[dates.length - 1] || "" },
    totals: {
      sessions: agg.sessionsBySource.reduce((n, r) => n + r.sessions, 0),
      messages: totalMessages,
      usage: totalUsage,
      total: totalTokens(totalUsage),
      cost: totalCost,
    },
    unpriced: unpricedModels(),
    daily,
    byModelDaily,
    bySkillDaily,
    byModel,
    bySource,
    bySkill,
    skillInvocations,
    byMcpServer,
    byTool,
    byToolCategory,
    heaviestToolResults,
    byPlugin,
    byProject,
    frictionTotals: agg.frictionTotals,
    highTokenGrowthSessions: agg.highTokenGrowthSessions,
    underused,
    sharedVsSolo,
    minCohortGuard,
    sourceComparison,
    toolFriction,
  };
}

function foldPlugins(
  bySkill: NamedUsage[],
  skillInvocations: Array<{ name: string; plugin: string | null; users: number; bySource: Record<string, number> }>,
  byMcpServer: Array<{ server: string; calls: number; users: number; bySource: Record<string, number> }>,
  plugins: Map<string, PluginInfo>,
): PluginRow[] {
  const costBySkill = new Map(bySkill.map((s) => [s.name, s]));
  const pluginAgg = new Map<string, PluginRow>();
  const ensurePlugin = (name: string): PluginRow => {
    let row = pluginAgg.get(name);
    if (!row) {
      const info = plugins.get(name);
      row = {
        name,
        marketplace: info?.marketplace || "",
        used: false,
        version: info?.version,
        installedAt: info?.installedAt,
        skills: [],
        skillMessages: 0,
        skillTokens: 0,
        skillCost: 0,
        mcpCalls: 0,
        users: 0,
        sources: [],
      };
      pluginAgg.set(name, row);
    }
    return row;
  };
  for (const name of plugins.keys()) ensurePlugin(name);
  const mergeSources = (row: PluginRow, bySource: Record<string, number>) => {
    for (const src of Object.keys(bySource)) {
      if (!row.sources.includes(src as AgentSource)) row.sources.push(src as AgentSource);
    }
  };
  for (const s of skillInvocations) {
    if (!s.plugin) continue;
    const row = ensurePlugin(s.plugin);
    row.used = true;
    if (!row.skills.includes(s.name)) row.skills.push(s.name);
    const usage = costBySkill.get(s.name);
    if (usage) {
      row.skillMessages += usage.messages;
      row.skillTokens += usage.total;
      row.skillCost += usage.cost;
    }
    row.users = Math.max(row.users, s.users);
    mergeSources(row, s.bySource);
  }
  for (const s of byMcpServer) {
    if (pluginAgg.has(s.server)) {
      const row = ensurePlugin(s.server);
      row.used = true;
      row.mcpCalls += s.calls;
      row.users = Math.max(row.users, s.users);
      mergeSources(row, s.bySource);
    }
  }
  return [...pluginAgg.values()].sort((a, b) => {
    if (a.used !== b.used) return a.used ? -1 : 1;
    return b.skillTokens - a.skillTokens;
  });
}
