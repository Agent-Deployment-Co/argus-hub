// Self-contained type definitions for hub/hub. Mirrors the subset of hub/src/types.ts,
// hub/src/store/store-contract.ts, and @agentdeploymentco/argus-schema that the hub server needs.

export type AgentSource = "claude" | "codex" | "gemini" | "cowork";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

export function addUsage(a: Usage, b: Usage): void {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite5m += b.cacheWrite5m;
  a.cacheWrite1h += b.cacheWrite1h;
}

export function totalTokens(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

export interface FrictionTotals {
  observableSessions: number;
  interruptions: number;
  rejections: number;
  compactions: number;
  turns: number;
}

export interface SessionHealth {
  interruptions: number | null;
  rejections: number | null;
  compactions: number | null;
  turns: number | null;
  medianTurnMs: number | null;
  maxTurnMs: number | null;
  stopReasons: Record<string, number> | null;
  tokenGrowth: number | null;
}

export interface SessionFriction {
  interruptions: number;
  rejections: number;
  compactions: number;
  turns: number;
  turnDurationsMs: number[];
  stopReasons: Record<string, number>;
  lastInterruptionMs?: number;
}

export type ToolCategory =
  | "file-io"
  | "shell"
  | "agent"
  | "web"
  | "planning"
  | "todo"
  | "skill"
  | "mcp"
  | "other";

export interface ToolUse {
  name: string;
  category: ToolCategory;
  skill?: string;
  args?: string;
  mcpServer?: string;
  mcpTool?: string;
  filePath?: string;
  approxResultTokens?: number;
}

export interface MessageRecord {
  source: AgentSource;
  sessionId: string;
  project: string;
  cwd: string;
  gitBranch: string;
  ts: number;
  date: string;
  model: string;
  usage: Usage;
  attributionSkill: string | null;
  stopReason?: string;
  interactionSeq?: number;
  toolUses: ToolUse[];
}

export interface ToolResultStat {
  count: number;
  approxTokens: number;
}

export interface SessionMeta {
  source: AgentSource;
  sessionId: string;
  project: string;
  cwd: string;
  filePath: string;
  firstPrompt?: string;
  userMessages?: number;
  agentMessages?: number;
  rawTurns?: number;
  friction?: SessionFriction;
}

export interface ParseResult {
  messages: MessageRecord[];
  sessions: Map<string, SessionMeta>;
  toolResults: Map<string, ToolResultStat>;
  tasksBySession?: Map<string, TaskFact[]>;
}

// ---- store-contract types -------------------------------------------------------

export interface TaskFact {
  id: string;
  source: AgentSource;
  sourceSessionId: string;
  timestampMs?: number;
  description: string;
  evidence: string;
  evidenceKind: "llm_inference" | "user_message";
  outcome?: string;
  frustration?: string;
  signals?: string[];
  outcomeReason?: string;
  position: { originKey: string; recordIndex: number; itemIndex: number; byteOffset?: number };
}

export interface ResolvedQuery {
  sources?: AgentSource[];
  since?: string;
  until?: string;
  projectSubstring?: string;
}

export interface SessionAggregate {
  meta: SessionMeta;
  byModel: { model: string; usage: Usage }[];
  firstTs: number | null;
  lastTs: number | null;
  messageCount: number;
}

export interface UsageGroupRow {
  model: string;
  usage: Usage;
  messages: number;
}

export interface DashboardAggregates {
  usageByDateModel: Array<{ date: string } & UsageGroupRow>;
  usageBySourceModel: Array<{ source: string } & UsageGroupRow>;
  usageByProjectModel: Array<{ project: string } & UsageGroupRow>;
  usageBySkillModel: Array<{ skill: string } & UsageGroupRow>;
  skillTokensByDate: Array<{ date: string; skill: string; total: number }>;
  sessionsBySource: Array<{ source: string; sessions: number }>;
  sessionsByProject: Array<{ project: string; sessions: number }>;
  toolResultStats: Array<{ tool: string; count: number; approxTokens: number }>;
  byTool: Array<{ tool: string; category: ToolCategory; calls: number; sessions: number }>;
  byToolCategory: Array<{ category: ToolCategory; calls: number; tools: number; sessions: number }>;
  mcpServers: Array<{ server: string; calls: number }>;
  mcpServerTools: Array<{ server: string; tool: string; count: number }>;
  skillInvocations: Array<{ skill: string; count: number; sampleArgs: string }>;
  frictionTotals: FrictionTotals;
  projectFriction: Array<{ project: string; friction: FrictionTotals }>;
  highTokenGrowthSessions: number;

  // ---- §4.1 source-dimensioned (Claude vs. Codex, etc.) --------------------------------
  byToolSource: Array<{ tool: string; source: string; category: ToolCategory; calls: number; sessions: number }>;
  byToolCategorySource: Array<{ category: ToolCategory; source: string; calls: number; tools: number; sessions: number }>;
  mcpServersSource: Array<{ server: string; source: string; calls: number }>;
  skillInvocationsSource: Array<{ skill: string; source: string; count: number }>;

  // ---- §4.2 user-dimensioned (distinct-user reach; counts only) ------------------------
  toolUsers: Array<{ tool: string; users: number }>;
  skillUsers: Array<{ skill: string; users: number }>;
  mcpServerUsers: Array<{ server: string; users: number }>;

  // ---- §4.3 friction-on-tools -----------------------------------------------------------
  stopReasonByTool: Array<{ tool: string; stopReason: string; count: number }>;
  /** Fraction of invocations with a populated interaction_seq — the friction-on-tools panel
   *  degrades to "insufficient data" below a usable threshold rather than showing partial data
   *  as if it were complete. */
  invocationSeqCoverage: number;
}

// ---- dashboard / presentation types --------------------------------------------

export interface NamedUsage {
  name: string;
  messages: number;
  total: number;
  cost: number;
  meta?: Record<string, unknown>;
}

export interface DayBucket {
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface PluginInfo {
  name: string;
  marketplace: string;
  enabled: boolean;
  installedAt?: string;
  version?: string;
}

export interface PluginRow {
  name: string;
  marketplace: string;
  used: boolean;
  version?: string;
  installedAt?: string;
  skills: string[];
  skillMessages: number;
  skillTokens: number;
  skillCost: number;
  mcpCalls: number;
  /** Observed-usage reach (§2 of TOOLS_PLAN.md) — NOT a config read. The hub cannot see
   *  install/enable state, only who invoked something. */
  users: number;
  sources: AgentSource[];
}

export interface ToolStat {
  name: string;
  category: ToolCategory;
  display: string;
  calls: number;
  sessions: number;
  approxResultTokens: number;
  /** Distinct users observed invoking this tool (observed-usage proxy, not a config read). */
  users: number;
  bySource: Record<string, number>;
}

export interface ToolCategoryStat {
  category: ToolCategory;
  label: string;
  calls: number;
  tools: number;
  sessions: number;
  approxResultTokens: number;
  bySource: Record<string, number>;
}

/** Bottom-decile-or-single-user items across tools/skills/MCP servers — the honest, observed-usage
 *  version of "what's underused" (TOOLS_PLAN.md §3.2). Never implies "installed but unused". */
export interface UnderusedRow {
  kind: "tool" | "skill" | "mcp";
  name: string;
  display: string;
  calls: number;
  users: number;
}

/** One item (skill or MCP server) bucketed by observed reach for the shared-vs-solo view
 *  (TOOLS_PLAN.md §3.7). `shared` follows the same MIN_COHORT_FOR_RANKINGS floor as Activity/Tasks. */
export interface ReachRow {
  kind: "skill" | "mcp";
  name: string;
  users: number;
  calls: number;
  shared: boolean;
}

export interface SourceBreakdownRow {
  key: string;
  display: string;
  bySource: Record<string, number>;
}

/** Claude/Codex/etc. comparison threaded across category mix, top tools, top skills, and top
 *  MCP servers (TOOLS_PLAN.md §3.8) — the highest-leverage panel unlocked by source-dimensioned data. */
export interface SourceComparison {
  sources: string[];
  byCategory: SourceBreakdownRow[];
  topTools: SourceBreakdownRow[];
  topSkills: SourceBreakdownRow[];
  topMcpServers: SourceBreakdownRow[];
}

export interface ToolFriction {
  byTool: Array<{ tool: string; stopReason: string; count: number }>;
  /** Below this, the panel is hidden rather than shown with a caveat — a coverage this low means
   *  the join sample isn't representative, not that friction is rare. */
  coverage: number;
}

export interface SessionRow {
  source: AgentSource;
  sessionId: string;
  project: string;
  start: number;
  end: number;
  durationMs: number;
  messages: number;
  userMessages: number | null;
  agentMessages: number | null;
  rawTurns: number | null;
  models: string[];
  topSkills: string[];
  toolCounts: Record<string, number>;
  filesTouched: string[];
  total: number;
  cost: number;
  firstPrompt: string;
  summary: string;
  health: SessionHealth;
  tasks?: TaskFact[];
}

// ---- Activity report (GET /api/activity) ----------------------------------------------

export interface ActivityTaskCounts {
  total: number;
  success: number;
  failure: number;
  unknown: number;
}

export interface ActivityTotals {
  sessions: number;
  activeUsers: number;
  tasks: ActivityTaskCounts;
  tokens: number;
  cost: number;
}

export interface ActivityDayPoint {
  date: string;
  sessions: number;
  tasks: number;
  tokens: number;
  cost: number;
  activeUsers: number;
}

/** One model's share of the window's token spend, for the Activity cost breakdown. Sorted
 *  descending by cost so the biggest spend driver leads. Unpriced models are omitted (their
 *  cost is 0 and would misleadingly rank last rather than flagging as unknown). */
export interface ModelCostRow {
  model: string;
  tokens: number;
  cost: number;
}

export type ActivityFreshness = "active" | "idle" | "silent";

export interface UserActivityRow {
  userId: string;
  displayName: string;
  sessions: number;
  tasks: number;
  taskSuccessRate: number | null;
  tokens: number;
  cost: number;
  activeDays: number;
  lastActiveMs: number | null;
  lastSyncMs: number;
  freshness: ActivityFreshness;
  score: number;
}

export interface SourceActivityRow {
  source: AgentSource;
  sessions: number;
  distinctUsers: number;
  tokens: number;
  cost: number;
  taskSuccessRate: number | null;
}

export interface ActivityReport {
  generatedAtMs: number;
  range: { since: string; until: string };
  previousRange: { since: string; until: string };
  totals: ActivityTotals;
  previousTotals: ActivityTotals;
  daily: ActivityDayPoint[];
  byUser: UserActivityRow[];
  bySource: SourceActivityRow[];
  costByModel: ModelCostRow[];
  unpriced: string[];
  minCohortGuard: boolean;
}

// ---- Task report (GET /api/tasks/report) ------------------------------------------------

export interface TaskOutcomeCounts {
  total: number;
  success: number;
  failure: number;
  unknown: number;
}

export interface FrustrationCounts {
  none: number;
  moderate: number;
  high: number;
  unknown: number;
}

export interface TaskTotals {
  total: number;
  /** `success / (success + failure)`; null when neither has occurred yet. */
  successRate: number | null;
  /** Share of tasks at `moderate` + `high` frustration, of those with a known frustration. */
  frustrationRate: number | null;
  /** Share of interactions with disposition `interrupted` or `incomplete`, of those with a
   *  known disposition — the mechanical, LLM-independent friction counterpart to successRate. */
  interruptedRate: number | null;
}

export interface TaskDayPoint {
  date: string;
  total: number;
  success: number;
  failure: number;
  successRate: number | null;
}

export interface TaskQualityRow {
  /** userId / source / project, depending on which dimension this row belongs to. */
  key: string;
  label: string;
  total: number;
  success: number;
  failure: number;
  successRate: number | null;
  frustrationRate: number | null;
}

export interface TaskSignalRow {
  signal: string;
  count: number;
}

export interface TaskReport {
  generatedAtMs: number;
  range: { since: string; until: string };
  totals: TaskTotals;
  outcomes: TaskOutcomeCounts;
  frustration: FrustrationCounts;
  daily: TaskDayPoint[];
  byUser: TaskQualityRow[];
  bySource: TaskQualityRow[];
  byProject: TaskQualityRow[];
  /** Most frequent `signals[]` tags across failed/frustrated tasks, ranked by frequency. */
  topSignals: TaskSignalRow[];
  /** Interruptions/rejections/compactions rolled up for the window. `observableSessions` is the
   *  count of sessions where these are knowable at all (codex/gemini leave them null, not zero). */
  friction: FrictionTotals;
  minCohortGuard: boolean;
}

export interface Dashboard {
  generatedAtMs: number;
  range: { start: string; end: string };
  totals: {
    sessions: number;
    messages: number;
    usage: Usage;
    total: number;
    cost: number;
  };
  unpriced: string[];
  daily: DayBucket[];
  byModelDaily: { date: string; byModel: Record<string, number> }[];
  bySkillDaily: { date: string; bySkill: Record<string, number> }[];
  byModel: NamedUsage[];
  bySource: NamedUsage[];
  bySkill: NamedUsage[];
  byUser?: NamedUsage[];
  skillInvocations: Array<{ name: string; count: number; plugin: string | null; sampleArgs: string }>;
  byMcpServer: Array<{
    server: string;
    calls: number;
    approxResultTokens: number;
    topTools: Array<{ tool: string; count: number }>;
  }>;
  heaviestToolResults: Array<{ tool: string; count: number; approxTokens: number }>;
  byPlugin: PluginRow[];
  byProject: NamedUsage[];
  byTool: ToolStat[];
  byToolCategory: ToolCategoryStat[];
  frictionTotals: FrictionTotals;
  highTokenGrowthSessions: number;

  underused: UnderusedRow[];
  sharedVsSolo: ReachRow[];
  minCohortGuard: boolean;
  sourceComparison: SourceComparison;
  toolFriction: ToolFriction;
}
