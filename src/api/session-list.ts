import { cost } from "../pricing.ts";
import type {
  AgentSource,
  MessageRecord,
  SessionAggregate,
  SessionFriction,
  SessionHealth,
  SessionMeta,
  SessionRow,
  TaskFact,
} from "../types.ts";
import { addUsage, emptyUsage, totalTokens } from "../types.ts";

export type SessionSort = "recent" | "tokens" | "cost";

export interface SessionListItem {
  sessionId: string;
  source: AgentSource;
  project: string;
  firstPrompt: string | null;
  start: number;
  end: number;
  userMessages: number | null;
  agentMessages: number | null;
  total: number;
  cost: number;
}

export interface SessionListResponse {
  rows: SessionListItem[];
  total: number;
  offset: number;
  limit: number;
}

export interface SessionListParams {
  sort: SessionSort;
  limit: number;
  offset: number;
  project?: string;
  q?: string;
  includeGenerated?: boolean;
}

export function isArgusGeneratedSession(firstPrompt: string | null | undefined): boolean {
  const title = firstPrompt?.trim();
  return Boolean(
    title === "Task extraction run" ||
      title === "Session analysis run" ||
      title?.startsWith("Task extraction for ") ||
      title?.startsWith("Session analysis for "),
  );
}

function listItem(agg: SessionAggregate): SessionListItem {
  let total = 0;
  let c = 0;
  for (const { model, usage } of agg.byModel) {
    total += totalTokens(usage);
    c += cost(usage, model);
  }
  const meta = agg.meta;
  return {
    sessionId: meta.sessionId,
    source: meta.source,
    project: meta.project,
    firstPrompt: meta.firstPrompt ?? null,
    start: agg.firstTs ?? 0,
    end: agg.lastTs ?? 0,
    userMessages: meta.userMessages ?? null,
    agentMessages: meta.agentMessages ?? null,
    total,
    cost: c,
  };
}

const SORTERS: Record<SessionSort, (a: SessionListItem, b: SessionListItem) => number> = {
  recent: (a, b) => b.start - a.start,
  tokens: (a, b) => b.total - a.total,
  cost: (a, b) => b.cost - a.cost,
};

export function buildSessionList(aggregates: SessionAggregate[], params: SessionListParams): SessionListResponse {
  const project = params.project?.toLowerCase();
  const term = params.q?.trim().toLowerCase();
  let items = aggregates.map(listItem);
  items = items.filter((it) => {
    if (!params.includeGenerated && isArgusGeneratedSession(it.firstPrompt)) return false;
    if (project && !it.project.toLowerCase().includes(project)) return false;
    if (term) {
      const title = (it.firstPrompt ?? "").toLowerCase();
      if (!title.includes(term) && !it.project.toLowerCase().includes(term) && !it.source.toLowerCase().includes(term)) {
        return false;
      }
    }
    return true;
  });
  items.sort(SORTERS[params.sort]);
  const total = items.length;
  const offset = Math.max(0, params.offset);
  const rows = items.slice(offset, offset + params.limit);
  return { rows, total, offset, limit: params.limit };
}

export function buildSessionDetail(
  sessionId: string,
  messages: MessageRecord[],
  meta: SessionMeta | undefined,
  tasks: TaskFact[],
): SessionRow {
  const summary = heuristicSummary(summaryFactsFromMessages(messages, meta?.firstPrompt || ""));
  return buildSessionRow(sessionId, messages, meta, summary, tasks);
}

// ---- Inline from hub/src/indexing/interpret/summarize.ts --------------------------------

interface SummaryFacts {
  firstPrompt: string;
  topSkills: string[];
  toolCounts: Record<string, number>;
  filesTouched: string[];
}

function summaryFactsFromMessages(messages: MessageRecord[], firstPrompt: string): SummaryFacts {
  const topSkills: string[] = [];
  const toolCounts: Record<string, number> = {};
  const filesTouched: string[] = [];
  for (const m of messages) {
    if (m.attributionSkill && !topSkills.includes(m.attributionSkill)) topSkills.push(m.attributionSkill);
    for (const tu of m.toolUses) {
      toolCounts[tu.name] = (toolCounts[tu.name] || 0) + 1;
      if (tu.filePath && !filesTouched.includes(tu.filePath)) filesTouched.push(tu.filePath);
    }
  }
  return { firstPrompt, topSkills, toolCounts, filesTouched };
}

function heuristicSummary(opts: SummaryFacts): string {
  function truncate(s: string, n: number): string {
    s = s.replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  const parts: string[] = [];
  if (opts.firstPrompt) parts.push(`"${truncate(opts.firstPrompt, 140)}"`);
  if (opts.topSkills.length) parts.push(`skills: ${opts.topSkills.join(", ")}`);
  const topTools = Object.entries(opts.toolCounts)
    .filter(([n]) => n !== "Skill")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([n, c]) => `${c}×${n}`);
  if (topTools.length) parts.push(topTools.join(" "));
  if (opts.filesTouched.length) parts.push(`${opts.filesTouched.length} file(s) edited`);
  return parts.join(" · ") || "(no activity recorded)";
}

// ---- Inline from hub/src/reporting/aggregate.ts -----------------------------------------

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function tokenGrowth(msgs: MessageRecord[]): number | null {
  if (msgs.length < 10) return null;
  const k = Math.floor(msgs.length / 10);
  const mean = (slice: MessageRecord[]) =>
    slice.reduce((sum, m) => sum + totalTokens(m.usage), 0) / slice.length;
  const first = mean(msgs.slice(0, k));
  return first > 0 ? mean(msgs.slice(-k)) / first : null;
}

function sessionHealth(msgs: MessageRecord[], friction: SessionFriction | undefined): SessionHealth {
  return {
    interruptions: friction?.interruptions ?? null,
    rejections: friction?.rejections ?? null,
    compactions: friction?.compactions ?? null,
    turns: friction?.turns ?? null,
    medianTurnMs: friction ? median(friction.turnDurationsMs) : null,
    maxTurnMs: friction?.turnDurationsMs.length ? Math.max(...friction.turnDurationsMs) : null,
    stopReasons: friction?.stopReasons ?? null,
    tokenGrowth: tokenGrowth(msgs),
  };
}

function buildSessionRow(
  sid: string,
  msgs: MessageRecord[],
  meta: SessionMeta | undefined,
  summary: string,
  tasks: TaskFact[],
): SessionRow {
  const u = emptyUsage();
  let c = 0;
  const models = new Set<string>();
  const skillCounts = new Map<string, number>();
  const toolCounts: Record<string, number> = {};
  const files = new Set<string>();
  for (const m of msgs) {
    addUsage(u, m.usage);
    c += cost(m.usage, m.model);
    models.add(m.model);
    if (m.attributionSkill) skillCounts.set(m.attributionSkill, (skillCounts.get(m.attributionSkill) || 0) + 1);
    for (const tu of m.toolUses) {
      toolCounts[tu.name] = (toolCounts[tu.name] || 0) + 1;
      if (tu.filePath) files.add(tu.filePath);
    }
  }
  const start = msgs[0]!.ts;
  const end = msgs[msgs.length - 1]!.ts;
  const topSkills = [...skillCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  return {
    source: meta?.source || msgs[0]!.source,
    sessionId: sid,
    project: meta?.project || msgs[0]!.project,
    start,
    end,
    durationMs: end - start,
    messages: msgs.length,
    userMessages: meta?.userMessages ?? null,
    agentMessages: meta?.agentMessages ?? null,
    rawTurns: meta?.rawTurns ?? null,
    models: [...models],
    topSkills,
    toolCounts,
    filesTouched: [...files],
    total: totalTokens(u),
    cost: c,
    firstPrompt: meta?.firstPrompt || "",
    summary,
    health: {
      ...sessionHealth(msgs, meta?.friction),
      turns: meta?.rawTurns ?? meta?.friction?.turns ?? null,
    },
    tasks,
  };
}
