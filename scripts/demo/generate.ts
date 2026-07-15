// Deterministic expander: turns the authored team scenarios into Hub store rows. Given a fixed seed
// and anchor date it always produces the same corpus, so demo screenshots are reproducible. It emits
// the same `Uploaded*` shapes a real client uploads (`resolved_*` mirror rows), so `demo.ts` can seed
// them straight through `HubStore.upsertClientSessions` — the same path a change to the store contract
// would break at typecheck.
//
// Why these row shapes and not the client demo's `MaterializeSession`: Hub stores the client's already-
// resolved rows verbatim. So the generator does the expansion the client would (messages -> usage rows
// with per-message `record_json`, tool uses -> invocation rows, tasks/interactions with their seq
// linkage) rather than handing the store raw material to expand. `record_json`/`task_json`/`meta_json`
// are re-parsed on read (see hub-store.ts), so they must round-trip real `MessageRecord`/`TaskFact`/
// `SessionMeta` objects; `interaction_json` is not re-parsed (only its columns are read).
//
// Invariants (kept true here, checked by test/demo.test.ts):
//  - Only priced models (src/pricing.ts). Sessions spread across a fixed window ending at the anchor.
//  - Session ids: `<source>:<uuid>`, except Claude Code (`claude`) which is a bare `<uuid>` (legacy
//    parity with the client), derived deterministically so a logical session keeps its id across runs.
//  - Friction only on `claude`/`cowork`; `codex`/`gemini` leave every friction column null.
//  - Tasks tie to interactions (usage.interaction_seq -> interaction.seq, interaction.task_seq ->
//    task.seq) so per-task token/tool metrics and the friction-on-tools join aren't empty.
//  - Corpus tuned to trip token-growth / high-interruptions / rejections / frequent-compactions
//    (src/api/recommendations.ts). Note Hub has NO unused-plugins rule (no install manifest).
//  - Determinism: everything flows from `seed` + `asOfMs`; no `Date.now()`/`Math.random()`.

import { categorizeTool, parseMcpTool } from "../../src/tool-categories.ts";
import {
  emptyUsage,
  type AgentSource,
  type MessageRecord,
  type SessionFriction,
  type SessionMeta,
  type TaskFact,
  type ToolUse,
  type Usage,
} from "../../src/types.ts";
import type {
  HubUploadRows,
  UploadedFingerprintEntry,
  UploadedInteraction,
  UploadedInvocation,
  UploadedSession,
  UploadedTask,
  UploadedUsage,
} from "../../src/store/hub-store.ts";
import {
  DEMO_TEAM,
  PLUGIN_CATALOG,
  PLUGIN_MARKETPLACE,
  type FrictionProfile,
  type PluginCatalogEntry,
  type ProjectScenario,
  type SessionTemplate,
  type TeamMember,
} from "./scenarios.ts";

/** Sources whose transcripts expose friction signals (Claude Code + Cowork share the Claude reader).
 *  Codex and Gemini leave friction undefined. */
const FRICTION_SOURCES = new Set<AgentSource>(["claude", "cowork"]);

/** Sources with real cache accounting. Gemini/Codex report input/output only (no cache-write buckets
 *  in this pricing model), so we leave their cache fields at zero. */
const CACHE_SOURCES = new Set<AgentSource>(["claude", "cowork", "codex"]);

const DAY_MS = 86_400_000;
/** Sessions are spread across this many days ending at the anchor date. */
const WINDOW_DAYS = 42;

/** UTC `YYYY-MM-DD` for a timestamp. Matches how the rest of Hub derives date strings
 *  (see reporting/tasks.ts) and is machine-independent, so screenshots reproduce anywhere. */
function toDateStr(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// ---- Output shape -------------------------------------------------------------------------------

/** One synthetic person's fully-expanded upload: a client that resolves to a user, its fingerprint
 *  observations (the identity the auto-mapper folds on), and the rows to `upsertClientSessions`. */
export interface DemoMember {
  member: TeamMember;
  /** Deterministic `client-<uuid>` (satisfies the store's CLIENT_ID_RE). */
  clientId: string;
  /** Fingerprint entries for `recordFingerprintObservations` — `git.user.name` for everyone plus the
   *  source-appropriate `*.oauth.email` (none for Gemini, which has no oauth-email fingerprint). */
  fingerprint: UploadedFingerprintEntry[];
  rows: HubUploadRows;
  stats: { sessions: number; messages: number; tasks: number; invocations: number };
}

export interface DemoData {
  members: DemoMember[];
  /** The plugin world the team installs from — passed through for docs/reference; Hub sees only the
   *  observed skill invocations in the rows, not this catalog. */
  plugins: { marketplace: string; catalog: PluginCatalogEntry[] };
  stats: { sessions: number; messages: number; tasks: number; bySource: Record<string, number> };
}

export interface GenerateOptions {
  /** Anchor date (epoch ms). Sessions land in the WINDOW_DAYS ending here. */
  asOfMs: number;
  /** PRNG seed. */
  seed: number;
}

// ---- Deterministic primitives -------------------------------------------------------------------

/** Deterministic UUID (v4-shaped) from a stable key (cyrb128 hash), so a session/client always gets
 *  the same id across runs without Math.random. */
function deterministicUuid(key: string): string {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < key.length; i++) {
    const k = key.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const hex =
    (h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0") +
    (h3 >>> 0).toString(16).padStart(8, "0") +
    (h4 >>> 0).toString(16).padStart(8, "0");
  const c = hex.split("");
  c[12] = "4"; // version nibble
  c[16] = ((parseInt(c[16]!, 16) & 0x3) | 0x8).toString(16); // variant nibble
  const u = c.join("");
  return `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20, 32)}`;
}

/** A canonical session id: real ids are a UUID prefixed by the source, except Claude Code, which is
 *  a bare UUID for legacy reasons. Stable for a given logical session across runs. */
function sessionIdFor(source: AgentSource, key: string): string {
  const uuid = deterministicUuid(key);
  return source === "claude" ? uuid : `${source}:${uuid}`;
}

/** mulberry32: a tiny, fast, seedable PRNG so runs are reproducible without Math.random. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Base per-message token magnitudes by source. Non-cache sources report input/output only. */
function baseUsage(source: AgentSource, rng: () => number): Usage {
  const jitter = (lo: number, hi: number) => Math.round(lo + (hi - lo) * rng());
  const input = jitter(300, 1600);
  const output = jitter(150, 900);
  const u: Usage = { ...emptyUsage(), input, output };
  if (CACHE_SOURCES.has(source)) {
    u.cacheRead = jitter(3000, 26000);
    // Occasional cache writes on the Claude family; Codex reports none.
    if (source !== "codex" && rng() < 0.4) u.cacheWrite5m = jitter(200, 2200);
  }
  return u;
}

/** Scale a usage record's context-heavy fields (used to manufacture rapid growth within a session). */
function scaleUsage(u: Usage, factor: number): Usage {
  return {
    input: Math.round(u.input * factor),
    output: u.output,
    cacheRead: Math.round(u.cacheRead * factor),
    cacheWrite5m: Math.round(u.cacheWrite5m * factor),
    cacheWrite1h: Math.round(u.cacheWrite1h * factor),
  };
}

/** Build one ToolUse from a raw tool name, filling MCP/skill/file fields the way the parser would. */
function makeTool(name: string, opts: { filePath?: string; skill?: string; rng: () => number }): ToolUse {
  const category = categorizeTool(name);
  const tool: ToolUse = { name, category };
  const mcp = parseMcpTool(name);
  if (mcp) {
    tool.mcpServer = mcp.server;
    tool.mcpTool = mcp.tool;
    tool.approxResultTokens = Math.round(400 + 6000 * opts.rng());
  } else if (name === "Skill" || name === "activate_skill") {
    if (opts.skill) tool.skill = opts.skill;
    tool.args = "run the skill";
  } else if (category === "file-io") {
    if (opts.filePath) tool.filePath = opts.filePath;
    tool.approxResultTokens = Math.round(200 + 3500 * opts.rng());
  } else if (category === "web" || category === "shell") {
    tool.approxResultTokens = Math.round(300 + 4500 * opts.rng());
  }
  return tool;
}

/** Friction for a session, given its profile. Only called for friction-bearing sources. Values are
 *  chosen so the corpus crosses the recommendation thresholds (see api/recommendations.ts). */
function frictionFor(
  profile: FrictionProfile,
  turns: number,
  lastTs: number,
  rng: () => number,
): SessionFriction {
  const dur = () => Math.round(4000 + 90000 * rng());
  const turnDurationsMs = Array.from({ length: Math.max(1, Math.round(turns / 2)) }, dur);
  const base: SessionFriction = {
    interruptions: 0,
    rejections: 0,
    compactions: 0,
    turns,
    turnDurationsMs,
    stopReasons: { end_turn: 1, tool_use: Math.max(1, turns - 1) },
  };
  if (profile === "none") return base;
  if (profile === "light") return { ...base, interruptions: 1 };
  if (profile === "growth") return { ...base, interruptions: 1, compactions: 1 };
  // heavy: interruptions + rejections + a trailing interruption (=> "interrupted" outcome proxy).
  return {
    ...base,
    interruptions: 3,
    rejections: 2,
    compactions: 1,
    lastInterruptionMs: lastTs + 1000,
    stopReasons: { tool_use: turns },
  };
}

// ---- Session planning + message expansion -------------------------------------------------------

interface ExpandedSession {
  owner: TeamMember;
  source: AgentSource;
  sessionId: string;
  project: string;
  cwd: string;
  template: SessionTemplate;
  model: string;
  secondaryModel?: string;
  dayOffset: number;
}

/** Assign each (member, project, template, instance) a session id and a spread-out day offset. */
function planSessions(rng: () => number): ExpandedSession[] {
  const planned: ExpandedSession[] = [];
  for (const member of DEMO_TEAM) {
    for (const project of member.projects) {
      project.sessions.forEach((template, ti) => {
        const instances = template.instances ?? 1;
        for (let inst = 0; inst < instances; inst++) {
          // Spread across the window with jitter so the daily chart isn't uniform.
          const dayOffset = Math.min(WINDOW_DAYS - 1, Math.floor(rng() * WINDOW_DAYS));
          planned.push({
            owner: member,
            source: project.source,
            sessionId: sessionIdFor(project.source, `${member.key}|${project.source}|${project.project}|${ti}|${inst}`),
            project: project.project,
            cwd: `${member.home}/${project.project}`,
            template,
            model: project.model,
            secondaryModel: project.secondaryModel,
            dayOffset,
          });
        }
      });
    }
  }
  return planned;
}

function buildMessages(plan: ExpandedSession, asOfMs: number, rng: () => number): MessageRecord[] {
  const turns = Math.max(3, (plan.template.turns ?? 6) + Math.round((rng() - 0.5) * 2));
  const dayStart = asOfMs - plan.dayOffset * DAY_MS;
  // Session starts somewhere in the working day; each turn a few minutes apart.
  const startTs = dayStart - Math.round((6 + 6 * rng()) * 3600_000);
  const tools = plan.template.tools ?? [];
  const files = plan.template.files ?? [];
  const skills = plan.template.skills ?? [];
  const primarySkill = skills[0];
  const grows = plan.template.friction === "growth";

  const messages: MessageRecord[] = [];
  for (let i = 0; i < turns; i++) {
    const ts = startTs + i * Math.round((2 + 8 * rng()) * 60_000);
    const model = plan.secondaryModel && i % 3 === 2 ? plan.secondaryModel : plan.model;

    let usage = baseUsage(plan.source, rng);
    if (grows) {
      // First ~40% small, last ~40% large so the last decile is >= 5x the first (token-growth rule).
      const frac = i / (turns - 1);
      const factor = frac < 0.4 ? 1 : frac > 0.6 ? 6 + 3 * rng() : 3;
      usage = scaleUsage(usage, factor);
    }

    const toolUses: ToolUse[] = [];
    // A Skill invocation on the first turn, if the session uses one.
    if (i === 0 && primarySkill) {
      toolUses.push(makeTool("Skill", { skill: primarySkill, rng }));
    }
    // Round-robin the template's other tools across turns, attaching files to file I/O.
    if (tools.length) {
      const name = tools[i % tools.length]!;
      const filePath = files.length ? files[i % files.length] : undefined;
      toolUses.push(makeTool(name, { filePath, rng }));
    }

    const isLast = i === turns - 1;
    const interrupted = plan.template.friction === "heavy" && isLast;
    const stopReason = isLast ? (interrupted ? "tool_use" : "end_turn") : "tool_use";

    messages.push({
      source: plan.source,
      sessionId: plan.sessionId,
      project: plan.project,
      cwd: plan.cwd,
      gitBranch: "",
      ts,
      date: toDateStr(ts),
      model,
      usage,
      attributionSkill: primarySkill ?? null,
      stopReason,
      toolUses,
    });
  }
  return messages;
}

/** Split n items into `parts` contiguous slice sizes, remainder on the earliest slices. */
function evenSlices(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const rem = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < rem ? 1 : 0));
}

/** How many tasks a session gets, by size: bigger sessions (more turns, so more tokens) hold more
 *  work. Capped at the template's authored task pool. */
function targetTaskCount(messageCount: number): number {
  return messageCount >= 9 ? 3 : messageCount >= 6 ? 2 : 1;
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** Follow-up prompts for a task's later interactions (its first interaction opens with the task
 *  itself). Picked deterministically by interaction seq so the demo dialogue reads like a real
 *  back-and-forth without any authored-per-session text. */
const FOLLOWUP_PROMPTS = [
  "Can you tighten that up a bit?",
  "Good start — now add the supporting detail.",
  "Double-check that against the source.",
  "Make it a little shorter.",
  "Walk me through how you got there.",
];

interface BuiltInteraction {
  seq: number;
  taskSeq: number;
  initiator: string;
  disposition: string;
  compactionCount: number;
  ts: number;
  promptText: string;
  responseText?: string;
}

/**
 * Give the session an interaction spine and tie tasks to it. This is what makes per-task metrics
 * work: usage attributes to a task through its owning interaction (usage.interaction_seq ->
 * interaction.seq -> interaction.task_seq -> task.seq), so without interactions every task shows 0
 * tokens and no tools. Each message is stamped with its interaction's seq here.
 *
 * A task spans one *or more* interactions (a real task is often several follow-up prompts). We pick
 * 1-3 tasks by session size, give each task a random 1-3 interactions (bounded so no later task is
 * starved of messages), then slice the session's messages evenly across the resulting interactions.
 * Each task takes the timestamp of its *first* interaction's first message.
 *
 * `rng` is a dedicated PRNG for the interaction split, kept separate from the message/friction stream
 * so adding this randomness doesn't shift token or task-count distributions elsewhere in the corpus.
 */
function buildInteractionsAndTasks(
  plan: ExpandedSession,
  messages: MessageRecord[],
  rng: () => number,
): { interactions: BuiltInteraction[]; tasks: TaskFact[] } {
  const pool = plan.template.tasks;
  const parts = Math.min(pool.length, targetTaskCount(messages.length), messages.length);
  if (parts === 0) return { interactions: [], tasks: [] };
  const templates = pool.slice(0, parts);

  // How many interactions each task gets (1-3), bounded so every remaining task keeps at least one
  // message (each task needs >= 1 interaction and each interaction >= 1 message).
  const perTask: number[] = [];
  let freeMessages = messages.length;
  for (let k = 0; k < parts; k++) {
    const tasksLeft = parts - k;
    const maxHere = freeMessages - (tasksLeft - 1); // reserve one message for each still-unplaced task
    const want = 1 + Math.floor(rng() * 3); // 1, 2, or 3
    const count = Math.max(1, Math.min(want, maxHere));
    perTask.push(count);
    freeMessages -= count;
  }
  const totalInteractions = perTask.reduce((n, c) => n + c, 0);
  const sizes = evenSlices(messages.length, totalInteractions); // messages per interaction

  const pos = (record: number, item: number) => ({
    originKey: `demo:${plan.sessionId}`,
    recordIndex: record,
    itemIndex: item,
  });

  // Sessions whose friction carries a compaction (heavy/growth on a friction-bearing source) get
  // exactly one, attributed to the final interaction, so the interaction spine sums to the session's
  // compaction count (frictionFor sets compactions: 1). Anything else stays at 0.
  const hasCompaction =
    FRICTION_SOURCES.has(plan.source) &&
    (plan.template.friction === "heavy" || plan.template.friction === "growth");
  const lastInteractionSeq = totalInteractions - 1;

  const interactions: BuiltInteraction[] = [];
  const tasks: TaskFact[] = [];
  let mi = 0;
  let seq = 0;
  for (let k = 0; k < parts; k++) {
    const taskFirstMsg = mi;
    const t = templates[k]!;
    const lastInInteraction = perTask[k]! - 1;
    for (let n = 0; n < perTask[k]!; n++) {
      const start = mi;
      for (let j = 0; j < sizes[seq]!; j++) messages[mi++]!.interactionSeq = seq;
      // Only the session's very last interaction can be interrupted (heavy friction) or carry the
      // compaction — so the spine reconciles with the session-level friction totals.
      const isLast = seq === lastInteractionSeq;
      const interrupted = plan.template.friction === "heavy" && isLast;
      const promptText = n === 0 ? `${capitalize(t.description)}.` : FOLLOWUP_PROMPTS[seq % FOLLOWUP_PROMPTS.length]!;
      const responseText =
        n === lastInInteraction ? t.evidence : `On it — I'll ${lowerFirst(t.description)}.`;
      interactions.push({
        seq,
        taskSeq: k,
        initiator: "human",
        disposition: interrupted ? "interrupted" : "completed",
        compactionCount: hasCompaction && isLast ? 1 : 0,
        ts: messages[start]!.ts,
        promptText,
        ...(interrupted ? {} : { responseText }),
      });
      seq++;
    }

    tasks.push({
      id: `${plan.sessionId}#task-${k}`,
      source: plan.source,
      sourceSessionId: plan.sessionId,
      timestampMs: messages[taskFirstMsg]!.ts,
      description: t.description,
      evidence: t.evidence,
      evidenceKind: "llm_inference",
      outcome: t.outcome,
      frustration: t.frustration,
      signals: t.signals,
      outcomeReason: t.outcomeReason,
      position: pos(taskFirstMsg, 2),
    });
  }
  return { interactions, tasks };
}

// ---- Row serialization --------------------------------------------------------------------------

/** Serialize one planned session's in-memory expansion into the client-mirror `Uploaded*` rows. */
function rowsForSession(
  plan: ExpandedSession,
  messages: MessageRecord[],
  interactions: BuiltInteraction[],
  tasks: TaskFact[],
  friction: SessionFriction | undefined,
): {
  session: UploadedSession;
  usage: UploadedUsage[];
  taskRows: UploadedTask[];
  interactionRows: UploadedInteraction[];
  invocations: UploadedInvocation[];
} {
  const sid = plan.sessionId;
  const firstTs = messages[0]!.ts;
  const lastTs = messages[messages.length - 1]!.ts;

  // Agent messages are the assistant turns. User messages are the user-role records: the human turn
  // each assistant reply answers, plus the tool results returned into the conversation, so tool-heavy
  // sessions show more user messages than agent ones.
  const toolCalls = messages.reduce((n, m) => n + m.toolUses.length, 0);
  const agentMessages = messages.length;
  const userMessages = messages.length + toolCalls;

  const meta: SessionMeta = {
    source: plan.source,
    sessionId: sid,
    project: plan.project,
    cwd: plan.cwd,
    filePath: `${plan.cwd}/session-${sid}.jsonl`,
    firstPrompt: plan.template.title,
    rawTurns: messages.length,
    userMessages,
    agentMessages,
    ...(friction ? { friction } : {}),
  };

  const session: UploadedSession = {
    session_id: sid,
    source: plan.source,
    project: plan.project,
    cwd: plan.cwd,
    first_ts: firstTs,
    last_ts: lastTs,
    message_count: messages.length,
    first_prompt: plan.template.title,
    archived: 0,
    friction_interruptions: friction ? friction.interruptions : null,
    friction_rejections: friction ? friction.rejections : null,
    friction_compactions: friction ? friction.compactions : null,
    friction_turns: friction ? friction.turns : null,
    last_interruption_ms: friction?.lastInterruptionMs ?? null,
    title: plan.template.title,
    summary: plan.template.summary,
    meta_json: JSON.stringify(meta),
  };

  const usage: UploadedUsage[] = messages.map((m, seq) => ({
    session_id: sid,
    seq,
    source: plan.source,
    ts: m.ts,
    date: m.date,
    cwd: m.cwd,
    project: m.project,
    record_json: JSON.stringify(m),
    input_tokens: m.usage.input,
    output_tokens: m.usage.output,
    cache_read: m.usage.cacheRead,
    cache_write_5m: m.usage.cacheWrite5m,
    cache_write_1h: m.usage.cacheWrite1h,
    model: m.model,
    attribution_skill: m.attributionSkill,
    stop_reason: m.stopReason ?? null,
    interaction_seq: m.interactionSeq ?? null,
  }));

  const taskRows: UploadedTask[] = tasks.map((t, seq) => ({
    session_id: sid,
    seq,
    source: plan.source,
    ts: t.timestampMs ?? null,
    task_json: JSON.stringify(t),
  }));

  const interactionRows: UploadedInteraction[] = interactions.map((it) => ({
    session_id: sid,
    seq: it.seq,
    source: plan.source,
    ts: it.ts,
    initiator: it.initiator,
    disposition: it.disposition,
    compaction_count: it.compactionCount,
    task_seq: it.taskSeq,
    interaction_json: JSON.stringify(it),
  }));

  // One invocation row per tool use, in message order, carrying the message's interaction seq so the
  // friction-on-tools join (usage.interaction_seq = invocation.interaction_seq) and per-tool rollups
  // populate. `seq` is a running index unique within the session (its primary key).
  const invocations: UploadedInvocation[] = [];
  let invSeq = 0;
  for (const m of messages) {
    for (const tu of m.toolUses) {
      invocations.push({
        session_id: sid,
        seq: invSeq++,
        source: plan.source,
        interaction_seq: m.interactionSeq ?? null,
        tool: tu.name,
        category: tu.category,
        mcp_server: tu.mcpServer ?? null,
        mcp_tool: tu.mcpTool ?? null,
        skill: tu.skill ?? null,
        file_path: tu.filePath ?? null,
        date: m.date,
        cwd: m.cwd,
        args: tu.args ?? null,
        approx_result_tokens: tu.approxResultTokens ?? 0,
      });
    }
  }

  return { session, usage, taskRows, interactionRows, invocations };
}

/** The fingerprint key the auto-mapper reads an email from, by the person's (single) source. Gemini
 *  has no oauth-email fingerprint in this schema, so those users resolve by `git.user.name` only. */
function oauthEmailKey(source: AgentSource): string | null {
  if (source === "codex") return "codex.oauth.email";
  if (source === "claude" || source === "cowork") return "claude.oauth.email";
  return null; // gemini
}

// ---- Top-level -----------------------------------------------------------------------------------

/** Expand the authored scenarios into a full, deterministic per-member demo dataset. */
export function generateDemoData(opts: GenerateOptions): DemoData {
  const rng = makeRng(opts.seed);
  // A second, independent stream for the task/interaction split so its draws don't perturb the
  // message and friction randomness (which the corpus's token/task-count invariants depend on).
  const groupRng = makeRng(opts.seed ^ 0x9e3779b9);
  const plans = planSessions(rng);
  const fpTsMs = opts.asOfMs - WINDOW_DAYS * DAY_MS; // stable observation time, before any session

  // Accumulate per member (keyed by member.key, in DEMO_TEAM order).
  const byMember = new Map<string, DemoMember>();
  for (const member of DEMO_TEAM) {
    // A person's source is uniform across their projects, so read it off the first project for the
    // oauth-email fingerprint key.
    const primarySource = member.projects[0]!.source;
    const fingerprint: UploadedFingerprintEntry[] = [
      { key: "git.user.name", value: member.name, tsMs: fpTsMs },
    ];
    const emailKey = oauthEmailKey(primarySource);
    if (emailKey) fingerprint.push({ key: emailKey, value: member.email, tsMs: fpTsMs });
    byMember.set(member.key, {
      member,
      clientId: `client-${deterministicUuid(`client|${member.key}`)}`,
      fingerprint,
      rows: { sessions: [], usage: [], tasks: [], interactions: [], invocations: [], labels: [] },
      stats: { sessions: 0, messages: 0, tasks: 0, invocations: 0 },
    });
  }

  const bySource: Record<string, number> = {};
  let totalMessages = 0;
  let totalTasks = 0;

  for (const plan of plans) {
    const messages = buildMessages(plan, opts.asOfMs, rng);
    const { interactions, tasks } = buildInteractionsAndTasks(plan, messages, groupRng);
    const lastTs = messages[messages.length - 1]!.ts;
    const friction = FRICTION_SOURCES.has(plan.source)
      ? frictionFor(plan.template.friction ?? "none", messages.length, lastTs, rng)
      : undefined;

    const built = rowsForSession(plan, messages, interactions, tasks, friction);
    const dm = byMember.get(plan.owner.key)!;
    dm.rows.sessions.push(built.session);
    dm.rows.usage.push(...built.usage);
    dm.rows.tasks.push(...built.taskRows);
    dm.rows.interactions.push(...built.interactionRows);
    dm.rows.invocations.push(...built.invocations);
    dm.stats.sessions += 1;
    dm.stats.messages += messages.length;
    dm.stats.tasks += tasks.length;
    dm.stats.invocations += built.invocations.length;

    bySource[plan.source] = (bySource[plan.source] ?? 0) + 1;
    totalMessages += messages.length;
    totalTasks += tasks.length;
  }

  const members = DEMO_TEAM.map((m) => byMember.get(m.key)!);
  return {
    members,
    plugins: { marketplace: PLUGIN_MARKETPLACE, catalog: PLUGIN_CATALOG },
    stats: { sessions: plans.length, messages: totalMessages, tasks: totalTasks, bySource },
  };
}
