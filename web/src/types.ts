// Self-contained types for the hub web SPA. Mirrors the shapes returned by hub/src/api/serve.ts's
// /api/snapshot endpoint. Kept separate from hub/src/* by design — the React bundle does not
// import server code, and the server does not import this file. Keep in sync with
// hub/src/types.ts (Dashboard) and hub/src/api/recommendations.ts (Recommendation).

export type AgentSource = "claude" | "codex" | "gemini" | "cowork";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface FrictionTotals {
  observableSessions: number;
  interruptions: number;
  rejections: number;
  compactions: number;
  turns: number;
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

export interface PluginRow {
  name: string;
  marketplace: string;
  enabled: boolean;
  used: boolean;
  version?: string;
  installedAt?: string;
  skills: string[];
  skillMessages: number;
  skillTokens: number;
  skillCost: number;
  mcpCalls: number;
}

export interface ToolStat {
  name: string;
  category: ToolCategory;
  display: string;
  calls: number;
  sessions: number;
  approxResultTokens: number;
}

export interface ToolCategoryStat {
  category: ToolCategory;
  label: string;
  calls: number;
  tools: number;
  sessions: number;
  approxResultTokens: number;
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
}

export type RecommendationSeverity = "tip" | "warning";

export interface Recommendation {
  id: string;
  severity: RecommendationSeverity;
  title: string;
  detail: string;
}

/** The payload served at GET /api/snapshot. */
export interface Snapshot {
  dashboard: Dashboard;
  recommendations: Recommendation[];
  generatedAtMs: number;
}
