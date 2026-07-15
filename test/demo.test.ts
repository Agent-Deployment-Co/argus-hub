// The Hub demo generator must keep producing a corpus that fills every major multi-tenant view. It
// seeds a real HubStore through the same seams /api/sync uses (upsertClient ->
// recordFingerprintObservations -> resolveUserForClient -> upsertClientSessions), so this also guards
// against store-contract drift: if the Uploaded* row shapes or the fact types change, this fails to
// typecheck or run. Asserts the invariants documented in scripts/demo/README.md.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHubStore, type HubStore } from "../src/store/hub-store.ts";
import { assembleDashboard } from "../src/reporting/snapshot.ts";
import { assembleActivityReport, previousWindow, MIN_COHORT_FOR_RANKINGS } from "../src/reporting/activity.ts";
import { computeRecommendations } from "../src/api/recommendations.ts";
import { cost } from "../src/pricing.ts";
import { emptyUsage } from "../src/types.ts";
import { generateDemoData } from "../scripts/demo/generate.ts";
import { DEMO_TEAM } from "../scripts/demo/scenarios.ts";

const ANCHOR = Date.parse("2026-07-15T00:00:00Z");
const DAY_MS = 86_400_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Seed a fresh temp store with the demo corpus and read back the views the serve endpoints build. */
async function seedAndRead(seed = 42) {
  const data = generateDemoData({ asOfMs: ANCHOR, seed });
  const dir = mkdtempSync(join(tmpdir(), "hub-demo-test-"));
  dirs.push(dir);

  const store: HubStore = await openHubStore(dir, ANCHOR);
  const orgId = (await store.getDefaultOrgId())!;
  for (const dm of data.members) {
    await store.upsertClient(orgId, dm.clientId, ANCHOR);
    await store.recordFingerprintObservations(dm.clientId, dm.fingerprint);
    await store.resolveUserForClient(orgId, dm.clientId, ANCHOR);
    await store.upsertClientSessions(orgId, dm.clientId, dm.rows, ANCHOR);
  }

  try {
    // /api/snapshot: dashboard + recommendations over the full window.
    const aggregates = await store.readDashboardAggregates({ orgId }, {});
    const dashboard = assembleDashboard(aggregates, new Map());
    const recommendations = computeRecommendations(dashboard);

    // /api/activity: user/source rollups over a window covering the seed.
    const since = new Date(ANCHOR - 42 * DAY_MS).toISOString().slice(0, 10);
    const until = new Date(ANCHOR).toISOString().slice(0, 10);
    const pw = previousWindow(since, until);
    const scope = { orgId };
    const [currentTotals, previousTotals, daily, byUser, bySource, curTasks, prevTasks] = await Promise.all([
      store.readActivityTotals(scope, { since, until }),
      store.readActivityTotals(scope, { since: pw.since, until: pw.until }),
      store.readActivityDaily(scope, { since, until }),
      store.readActivityUserRollup(scope, { since, until }),
      store.readActivitySourceRollup(scope, { since, until }),
      store.readTaskFacts(scope, { since, until }),
      store.readTaskFacts(scope, { since: pw.since, until: pw.until }),
    ]);
    const activity = assembleActivityReport({
      since, until, previousSince: pw.since, previousUntil: pw.until,
      currentTotals, previousTotals, daily, byUser, bySource,
      currentTasks: curTasks.map((r) => ({ task: r.task, userId: r.userId })),
      previousTasks: prevTasks.map((r) => ({ task: r.task })),
      nowMs: ANCHOR,
    });

    const users = await store.listUsers(orgId);
    const clients = await store.listClients(orgId);
    return { data, dashboard, recommendations, activity, users, clients };
  } finally {
    await store.close();
  }
}

/** Every session row flattened across members, with its owning source. */
function allSessions(data: Awaited<ReturnType<typeof seedAndRead>>["data"]) {
  return data.members.flatMap((m) => m.rows.sessions);
}

test("the demo corpus fills every major multi-tenant view", async () => {
  const { data, dashboard, activity } = await seedAndRead();

  expect(dashboard.totals.sessions).toBe(data.stats.sessions);
  expect(dashboard.totals.messages).toBe(data.stats.messages);
  expect(dashboard.totals.cost).toBeGreaterThan(0);

  // All four Hub sources are represented (Hub, unlike the client demo, includes gemini).
  const sources = new Set(dashboard.bySource.map((r) => r.name));
  for (const s of ["claude", "cowork", "codex", "gemini"]) expect(sources.has(s)).toBe(true);

  expect(dashboard.byModel.length).toBeGreaterThanOrEqual(4);
  expect(dashboard.byProject.length).toBeGreaterThanOrEqual(8);
  expect(dashboard.byTool.length).toBeGreaterThan(0);
  expect(dashboard.byMcpServer.length).toBeGreaterThan(0);
  expect(dashboard.bySkill.some((s) => s.name !== "(none)")).toBe(true);
  expect(dashboard.highTokenGrowthSessions).toBeGreaterThanOrEqual(1);

  // The multi-tenant views are the point: several distinct days, every user ranked, every source.
  expect(activity.daily.length).toBeGreaterThan(5);
  expect(activity.totals.activeUsers).toBe(DEMO_TEAM.length);
  expect(activity.byUser.length).toBe(DEMO_TEAM.length);
  expect(new Set(activity.bySource.map((r) => r.source)).size).toBe(4);
});

test("at least two users map from distinct clients so per-user views populate", async () => {
  const { users, clients } = await seedAndRead();
  // One distinct client per person, each resolved to its own user.
  expect(clients.length).toBe(DEMO_TEAM.length);
  expect(new Set(clients.map((c) => c.clientId)).size).toBe(DEMO_TEAM.length);
  expect(users.length).toBeGreaterThanOrEqual(2);
  expect(users.length).toBe(DEMO_TEAM.length);
  const mappedUsers = new Set(clients.map((c) => c.userId).filter(Boolean));
  expect(mappedUsers.size).toBe(DEMO_TEAM.length);
  // Enough users to clear the ranking cohort floor (so Activity/Tasks rankings aren't guarded off).
  expect(users.length).toBeGreaterThanOrEqual(MIN_COHORT_FOR_RANKINGS);
});

test("every model used matches a pricing family, so cost is fully accounted", async () => {
  const { data, dashboard, activity } = await seedAndRead();
  const models = new Set<string>();
  for (const m of data.members) for (const u of m.rows.usage) if (u.model) models.add(u.model);
  expect(models.size).toBeGreaterThanOrEqual(4);
  for (const model of models) {
    expect(cost({ ...emptyUsage(), input: 1000 }, model)).toBeGreaterThan(0);
  }
  // No unpriced-models notice either place cost is summarized.
  expect(dashboard.unpriced).toEqual([]);
  expect(activity.unpriced).toEqual([]);
});

test("session ids follow the per-source convention", async () => {
  const { data } = await seedAndRead();
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const s of allSessions(data)) {
    if (s.source === "claude") {
      // Claude Code ids are a bare uuid (legacy parity with the client).
      expect(s.session_id).toMatch(UUID);
    } else {
      expect(s.session_id.startsWith(`${s.source}:`)).toBe(true);
      expect(s.session_id.slice(s.source.length + 1)).toMatch(UUID);
    }
    expect(s.message_count).toBeGreaterThan(0);
  }
});

test("friction is present only on claude/cowork sessions", async () => {
  const { data } = await seedAndRead();
  for (const s of allSessions(data)) {
    if (s.source === "claude" || s.source === "cowork") {
      expect(s.friction_interruptions).not.toBeNull();
      expect(s.friction_turns).not.toBeNull();
    } else {
      // codex / gemini leave every friction column null (not zero).
      expect(s.friction_interruptions).toBeNull();
      expect(s.friction_rejections).toBeNull();
      expect(s.friction_compactions).toBeNull();
    }
  }
});

test("the corpus triggers exactly the recommendations Hub supports", async () => {
  const { recommendations } = await seedAndRead();
  const ids = new Set(recommendations.map((r) => r.id));
  for (const id of ["token-growth", "high-interruptions", "rejections", "frequent-compactions"]) {
    expect(ids.has(id)).toBe(true);
  }
  // Hub has no install manifest, so it must NOT emit an unused-plugins recommendation.
  expect(ids.has("unused-plugins")).toBe(false);
});

test("task outcomes span success, failure, and unclear for view variety", async () => {
  const { data } = await seedAndRead();
  const outcomes = new Set<string>();
  for (const m of data.members) {
    for (const t of m.rows.tasks) outcomes.add((JSON.parse(t.task_json) as { outcome?: string }).outcome ?? "");
  }
  for (const o of ["success", "failure", "unclear"]) expect(outcomes.has(o)).toBe(true);
});

test("every session carries a non-empty title and summary", () => {
  const data = generateDemoData({ asOfMs: ANCHOR, seed: 42 });
  for (const s of allSessions(data)) {
    expect((s.title ?? "").length).toBeGreaterThan(0);
    expect((s.summary ?? "").length).toBeGreaterThan(0);
  }
});

test("task counts are 1-3 per session and scale with session size", () => {
  const data = generateDemoData({ asOfMs: ANCHOR, seed: 42 });
  const tokensByCount: Record<number, number[]> = { 1: [], 2: [], 3: [] };
  for (const m of data.members) {
    const msgTokensBySession = new Map<string, number>();
    for (const u of m.rows.usage) {
      const t = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read ?? 0) + (u.cache_write_5m ?? 0) + (u.cache_write_1h ?? 0);
      msgTokensBySession.set(u.session_id, (msgTokensBySession.get(u.session_id) ?? 0) + t);
    }
    const taskCounts = new Map<string, number>();
    for (const t of m.rows.tasks) taskCounts.set(t.session_id, (taskCounts.get(t.session_id) ?? 0) + 1);
    for (const s of m.rows.sessions) {
      const n = taskCounts.get(s.session_id) ?? 0;
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(3);
      tokensByCount[n]!.push(msgTokensBySession.get(s.session_id) ?? 0);
    }
  }
  const multiTask = tokensByCount[2]!.length + tokensByCount[3]!.length;
  expect(multiTask).toBeGreaterThanOrEqual(15);
  expect(tokensByCount[3]!.length).toBeGreaterThan(0);
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  expect(avg(tokensByCount[2]!)).toBeGreaterThan(avg(tokensByCount[1]!));
  expect(avg(tokensByCount[3]!)).toBeGreaterThan(avg(tokensByCount[2]!));
});

test("tasks tie to interactions so per-task token metrics aren't zero", () => {
  const data = generateDemoData({ asOfMs: ANCHOR, seed: 42 });
  let checkedTasks = 0;
  for (const m of data.members) {
    // Group rows per session.
    const bySession = new Map<string, { usage: typeof m.rows.usage; ints: typeof m.rows.interactions; tasks: typeof m.rows.tasks }>();
    const get = (sid: string) => {
      let e = bySession.get(sid);
      if (!e) { e = { usage: [], ints: [], tasks: [] }; bySession.set(sid, e); }
      return e;
    };
    for (const u of m.rows.usage) get(u.session_id).usage.push(u);
    for (const it of m.rows.interactions) get(it.session_id).ints.push(it);
    for (const t of m.rows.tasks) get(t.session_id).tasks.push(t);

    for (const [, e] of bySession) {
      // interaction seq -> its task_seq
      const taskSeqOfInteraction = new Map<number, number | null>();
      for (const it of e.ints) taskSeqOfInteraction.set(it.seq, it.task_seq);
      // usage.interaction_seq must reference a real interaction; interaction.task_seq a real task.
      const taskSeqs = new Set(e.tasks.map((t) => t.seq));
      for (const u of e.usage) if (u.interaction_seq != null) expect(taskSeqOfInteraction.has(u.interaction_seq)).toBe(true);
      for (const it of e.ints) if (it.task_seq != null) expect(taskSeqs.has(it.task_seq)).toBe(true);
      // Every task accrues tokens from the usage of its interactions' messages.
      const tokensByTask = new Map<number, number>();
      for (const u of e.usage) {
        if (u.interaction_seq == null) continue;
        const ts = taskSeqOfInteraction.get(u.interaction_seq);
        if (ts == null) continue;
        const tot = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read ?? 0) + (u.cache_write_5m ?? 0) + (u.cache_write_1h ?? 0);
        tokensByTask.set(ts, (tokensByTask.get(ts) ?? 0) + tot);
      }
      for (const t of e.tasks) {
        expect(tokensByTask.get(t.seq) ?? 0).toBeGreaterThan(0);
        checkedTasks++;
      }
    }
  }
  expect(checkedTasks).toBeGreaterThan(0);
});

test("interaction compaction counts reconcile with session-level friction", () => {
  const data = generateDemoData({ asOfMs: ANCHOR, seed: 42 });
  for (const m of data.members) {
    const compBySession = new Map<string, number>();
    for (const it of m.rows.interactions) {
      compBySession.set(it.session_id, (compBySession.get(it.session_id) ?? 0) + it.compaction_count);
    }
    for (const s of m.rows.sessions) {
      const sessionCompactions = s.friction_compactions ?? 0;
      expect(compBySession.get(s.session_id) ?? 0).toBe(sessionCompactions);
    }
  }
});

test("generation is deterministic for a fixed seed + as-of", () => {
  const a = generateDemoData({ asOfMs: ANCHOR, seed: 42 });
  const b = generateDemoData({ asOfMs: ANCHOR, seed: 42 });
  // The seeded rows (the screenshot-relevant content) are byte-identical across runs. Store-level ids
  // (org/user uuids) are random per seed run and intentionally not part of this guarantee.
  expect(JSON.stringify(a.members)).toBe(JSON.stringify(b.members));
  expect(a.stats).toEqual(b.stats);
});

test("public-repo safety: no real paths, names, emails, or tokens", () => {
  const data = generateDemoData({ asOfMs: ANCHOR, seed: 42 });
  const homes = new Set(DEMO_TEAM.map((m) => m.home));
  // Every authored email is on the obviously-fake example domain.
  for (const m of DEMO_TEAM) {
    expect(m.email.endsWith("@tyrell.example")).toBe(true);
    expect(m.home.startsWith("/Users/")).toBe(true);
  }
  // Every file path lives under one of the demo homes — no stray real paths leaked in.
  const blob = JSON.stringify(data.members);
  for (const match of blob.matchAll(/\/Users\/[a-z]+/g)) {
    expect(homes.has(match[0]!)).toBe(true);
  }
  // No real credential-looking material or the maintainer's own domain.
  for (const forbidden of ["@gmail.", "@agentdeployment", "sk-ant-", "sk-proj-", "ghp_", "AKIA", "-----BEGIN"]) {
    expect(blob.includes(forbidden)).toBe(false);
  }
});
