# Demo data

`scripts/demo.ts` stands up a realistic, reproducible **Hub** demo in a sandbox and (optionally) opens
the dashboard on it. It exists for two things: **live demos** and **stable screenshots** for the docs.
This file is the contract for how the demo data works, so you can tweak it later without re-deriving the
approach. Read it before changing `scenarios.ts` or `generate.ts`.

It's the Hub counterpart to the client's `argus/scripts/demo`, adapted to Hub's multi-tenant shape:
Hub is client-centric, so the corpus is a **team**, not one persona.

## Quick start

```bash
bun run demo                                   # seed into .demo/ and open the dashboard
bun run scripts/demo.ts --no-serve             # seed only, print the serve command
bun run scripts/demo.ts --as-of 2026-07-01 --seed 42   # pin date + seed for reproducible screenshots
bun test test/demo.test.ts                     # the invariants below, as tests
```

Flags: `--out <dir>` (default `.demo/`, gitignored), `--as-of <YYYY-MM-DD>` (default today),
`--seed <n>` (default 42), `--serve`/`--no-serve`, `--port <n>` (default 4343).

## The personas and world (keep this grounded)

All demo content is one coherent, obviously-fake company — a small go-to-market **team** at **Tyrell
Corporation**, extending the client demo's single-persona world (Rachel is still here, now one of five):

| Person | Role | Source | Home |
| --- | --- | --- | --- |
| Rachel Nguyen | Account Executive | `cowork` | `/Users/rachel` |
| Priya Shah | Content Marketing Lead | `cowork` | `/Users/priya` |
| Marcus Bell | RevOps Analyst | `codex` | `/Users/marcus` |
| Dana Okafor | GTM AI-ops Engineer | `claude` | `/Users/dana` |
| Tom Alvarez | Sales Development Rep | `gemini` | `/Users/tom` |

- Everyone does **go-to-market knowledge work** (sales, marketing, revops, AI-ops), never software of
  their own, and researches plausible, invented companies (Wallace Corp, Rosen Associates, Sebastian
  Design, Meridian Software).
- **Keep everything grounded and realistic.** Tyrell/Rachel is a deliberately subtle nod — the
  teammates have plain, realistic names. Do **not** add overt sci-fi ("Deckard", "Nexus-6",
  "replicants", etc.). If a name would tip off a casual reader that this is a theme, don't use it.
- **Public-repo safety:** no real paths, names, emails, tokens, or transcript text. Real MCP/product
  names (hubspot, salesforce, notion, ...) are public and fine; the content around them is invented.

Multiple people is the point: it's what makes the multi-tenant views (`Team`, `UserActivity`, the
per-user rollups in `Activity`) non-empty. Every source Hub knows about is represented, and the team is
sized to clear the ranking cohort floor (`MIN_COHORT_FOR_RANKINGS`).

## Approach and why

Seed a synthetic `hub.db` **directly through the store's client seams** — for each person:
`upsertClient` → `recordFingerprintObservations` → `resolveUserForClient` → `upsertClientSessions`.
These are the exact calls `/api/sync` makes. We do **not** build `HubUploadPayload` wire objects and
POST them to a running server, and we do **not** commit a prebuilt `.db`.

- Direct seeding is deterministic with no network and no server, and reproduces the auto-mapper's
  client→user resolution exactly (which is what fills the per-user views).
- It uses the real `Uploaded*` row types, so any store-contract change fails `bun run typecheck` or the
  tests instead of rotting silently (which a committed binary would).
- The generator is the committed source of truth; the `.db` is regenerated on demand into a gitignored
  sandbox (`.demo/`), so the developer's real Hub store (`data/hub.db`) is never touched.

## Files

- **`scenarios.ts`** — the authored, reviewable data: `DEMO_TEAM` (each person's GTM projects, session
  templates, and task pools) and `PLUGIN_CATALOG`. Edit this to change *what* the demo shows.
- **`generate.ts`** — the deterministic expander: turns the team scenarios into per-member
  `HubUploadRows` + fingerprint observations (the `Uploaded*` shapes a client uploads). Edit this to
  change *how* sessions are shaped. Holds the invariants below.
- **`../demo.ts`** — orchestration: opens the sandbox store, seeds each person through the client seams,
  prints the summary + credentials, spawns `serve`.

## How to tweak

- **Add a person:** append a `TeamMember` to `DEMO_TEAM` (`key`, `name`, `email`, `home`, `role`, and
  their `projects`). `name`/`email` become the fingerprint identity the auto-mapper folds on, so keep
  them distinct — that's what yields a distinct user.
- **Add a project:** append a `ProjectScenario` to a person's `projects` (slug, `source`, `model`,
  optional `secondaryModel`, and `sessions`).
- **Add a session:** add a `SessionTemplate` (opening `title`, one-to-two sentence `summary`, `tools`,
  `skills`, `files`, `turns`, `friction`, `tasks`, optional `instances` to repeat it across dates).
- **Add tasks:** each template's `tasks` is a **pool**; the generator takes 1-3 by session size. Author
  the pool oldest-first; put the messiest/least-resolved task last.

## Invariants the generator guarantees (don't break these)

These keep every view populated and correct. If you change `generate.ts`, keep them true (the tests
check them):

- **Distinct users from distinct clients.** Each person is one client that resolves to one user, so the
  `Team`/`UserActivity`/per-user rollups populate. `name`/`email` drive the resolution (`git.user.name`
  + `<source>.oauth.email`); Gemini has no oauth-email fingerprint, so that person resolves by name (and
  shows by name rather than email — faithful to production).
- **Sources and their traits.** Only `claude` (Claude Code) and `cowork` (Cowork) carry friction;
  `codex` and `gemini` leave every friction column null (not zero). Unlike the client demo, Hub
  **includes `gemini`** for source-rollup coverage.
- **Only priced models.** Every `model` must match a pricing family in `src/pricing.ts` (opus / sonnet
  / haiku / gpt-5.x / gemini-*). No unpriced models — cost must be fully accounted.
- **Session ids** are `<source>:<uuid>`, except Claude Code, which is a **bare `<uuid>`** for legacy
  parity with the client. Ids are derived deterministically from a stable per-session key.
- **Tasks tie to interactions.** Each task spans one to three interactions; usage attributes to a task
  through its interaction (`usage.interaction_seq` → `interaction.seq` → `interaction.task_seq` →
  `task.seq`), and each invocation carries its `interaction_seq`. Without this, per-task token/tool
  metrics are 0 and the friction-on-tools join is empty.
- **Titles and summaries.** Every session row carries an authored `title` (its opening prompt) and
  `summary`, so the session-title/summary and search views aren't blank.
- **Task count scales with size:** 1-3 tasks per session, more for larger (higher-token) sessions,
  capped by the authored pool.
- **Recommendation coverage.** The corpus is tuned to trip `token-growth`, `high-interruptions`,
  `rejections`, and `frequent-compactions` (via friction profiles). Note Hub has **no unused-plugins
  rule** — it has no install manifest, only observed usage (`src/api/recommendations.ts`). If you
  rebalance friction, re-check the four still fire (they need an interruption avg ≥ 1/session, ≥ 5
  rejections, a compaction rate ≥ 30%, and ≥ 1 high-growth session).
- **Determinism.** The seeded rows flow entirely from `--seed` + `--as-of`; no `Date.now()` or
  `Math.random()` in `generate.ts`. The org/user uuids the store mints are random per run and are *not*
  part of the guarantee — the reproducible content is the `Uploaded*` rows (what screenshots show).

## Isolation

`--out` (default `.demo/`) holds the sandbox; seeding writes `<out>/hub.db` directly. `demo.ts` wipes
`hub.db*` in the sandbox on each run for a clean, reproducible seed. `serve` runs as a child process
with `--data-dir <out>` and a shared `ADMIN_PASSWORD`, so the printed admin password is the one that
works. `.demo/` is gitignored and the real store (`data/hub.db`) is never touched.

## Tests

`test/demo.test.ts` is the executable form of this contract: it seeds a temp store through the client
seams and asserts the multi-tenant breakdowns, the four recommendations, distinct-user mapping, per-task
metrics, task-count-by-size, id format, friction-source rules, determinism, and public-repo safety. Run
it after any change here.
