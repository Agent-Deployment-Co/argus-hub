// Authored demo corpus for Hub: a small go-to-market **team** at Tyrell Corporation and the agent
// sessions each person runs. This is the reviewable *data* half of the demo generator; `generate.ts`
// expands it deterministically into `Uploaded*` store rows and `demo.ts` seeds them per-person through
// the `HubStore` client seams (`upsertClient` -> `recordFingerprintObservations` -> `resolveUserForClient`
// -> `upsertClientSessions`).
//
// Why a team, not one persona: Hub is multi-tenant. Data is scoped by org/client and clients fold into
// users, so a single-persona corpus would leave `Team`, `UserActivity`, and every per-user rollup
// (`ActivityUserRankings`, `readActivityUserRollup`, `readUserStats`) empty. Multiple people mapped from
// distinct clients is the point.
//
// This extends the single-user client demo's world (see argus/scripts/demo/README.md) rather than
// inventing a new one: still Tyrell Corporation, still go-to-market knowledge work (sales, marketing,
// revops, AI-ops), Rachel is still here — she's just one of five now.
//
// Keep everything grounded and realistic (see argus docs/contributing/voice-and-tone.md): the
// Tyrell/Rachel nod is deliberately subtle — do NOT add overt sci-fi names (no "Deckard", "Nexus-6",
// "replicants"); the teammates have plain, realistic names. No real paths, names, emails, tokens, or
// transcript text. MCP/product names (hubspot, notion, ...) are public and fine; the content is invented.
// Full rules: scripts/demo/README.md.

import type { AgentSource } from "../../src/types.ts";

/** Task outcome/frustration vocabularies. Hub has no exported store-contract enum for these (it stores
 *  them as free strings and classifies at read time via `classifyOutcome`/`classifyFrustration` in
 *  `src/api/task-list.ts`), so we pin the authored vocabulary here. `unclear` classifies as `unknown`. */
export type TaskOutcome = "success" | "failure" | "unclear";
export type TaskFrustration = "none" | "moderate" | "high";

/** How much friction a session shows. Only Claude Code (`claude`) and Cowork (`cowork`) sessions carry
 *  friction at all; the generator ignores this for `codex`/`gemini`. `growth` also drives
 *  rapid context growth (token-growth + compaction recommendations). */
export type FrictionProfile = "none" | "light" | "heavy" | "growth";

export interface TaskTemplate {
  /** What the person was trying to do, in their voice. */
  description: string;
  outcome: TaskOutcome;
  frustration: TaskFrustration;
  /** Short evidence tags for the outcome call. */
  signals?: string[];
  /** One-line rationale for the outcome. */
  outcomeReason: string;
  /** A supporting excerpt (invented). */
  evidence: string;
}

export interface SessionTemplate {
  /** The person's opening prompt; stored as the session's first prompt and reused as the interpreted
   *  session title (the demo has no live interpreter to generate one). */
  title: string;
  /** A one-to-two sentence session summary — the interpreted summary the demo would otherwise get from
   *  the model. Spans the session's tasks, in the person's world/voice. */
  summary: string;
  /** Documents the agent read or wrote, under the owner's home. */
  files?: string[];
  /** Raw tool names used, e.g. "Read", "WebSearch", "mcp__hubspot__search_contacts". */
  tools?: string[];
  /** Skills invoked (plugin:skill or a bare skill), e.g. "gtm-research:account-brief". */
  skills?: string[];
  /** Roughly how many model responses the session took. The generator varies this a little. */
  turns?: number;
  friction?: FrictionProfile;
  /** One to three tasks the agent worked through. Authored oldest-first; put the messiest last. */
  tasks: TaskTemplate[];
  /** Instantiate this template more than once (across different dates) for volume. Default 1. */
  instances?: number;
}

export interface ProjectScenario {
  /** Project slug, i.e. the folder the agent worked in (relative to the owner's home). */
  project: string;
  source: AgentSource;
  /** Primary model for the project. */
  model: string;
  /** Some sessions mix in this model too, so cost is re-walked per message. */
  secondaryModel?: string;
  sessions: SessionTemplate[];
}

/** A synthetic teammate: one client that resolves to one user. `name`/`email` become the fingerprint
 *  identity the auto-mapper folds on (`git.user.name`, `<source>.oauth.email` — see
 *  `resolveUserForClient`), so each distinct person yields a distinct user. */
export interface TeamMember {
  /** Stable, human-readable client-id suffix (the demo namespaces it per org). Also seeds this
   *  person's deterministic ids, so keep it unique and stable. */
  key: string;
  /** Display name; authored into the `git.user.name` fingerprint. */
  name: string;
  /** Company email; authored into the `<source>.oauth.email` fingerprint and folded on by the mapper. */
  email: string;
  /** Home directory root for this person's files. */
  home: string;
  /** GTM function — flavor/readability only. */
  role: "sales" | "marketing" | "revops" | "ai-ops" | "sdr";
  projects: ProjectScenario[];
}

export const DEMO_COMPANY = "Tyrell Corporation";

// GTM MCP servers the team's agents lean on. Public product names; invented usage.
const HUBSPOT = "mcp__hubspot__search_contacts";
const HUBSPOT_DEALS = "mcp__hubspot__list_deals";
const SALESFORCE = "mcp__salesforce__soql_query";
const GONG = "mcp__gong__list_calls";
const NOTION = "mcp__notion__search";
const GDRIVE = "mcp__gdrive__read_document";
const SLACK = "mcp__slack__post_message";
const GMAIL = "mcp__gmail__create_draft";

const doc = (home: string, p: string) => `${home}/${p}`;

// ================================================================================================
// The team. Five people, five distinct clients -> five users, spanning every source Hub knows about
// (claude, cowork, codex, gemini) so `ActivitySourceRankings` / `SourceComparison` and the per-user
// rollups all populate. Friction lands only on the `claude`/`cowork` people (Dana, Rachel, Priya);
// `codex`/`gemini` sessions leave friction undefined.
// ================================================================================================

// ---- Rachel — Account Executive (Cowork) -------------------------------------------------------
const RACHEL: TeamMember = {
  key: "rachel",
  name: "Rachel Nguyen",
  email: "rachel@tyrell.example",
  home: "/Users/rachel",
  role: "sales",
  projects: [
    {
      project: "wallace-corp-expansion",
      source: "cowork",
      model: "claude-sonnet-4-6",
      sessions: [
        {
          title: "Draft the Wallace Corp expansion account brief",
          summary:
            "Pulled Wallace Corp's org chart and recent calls into a one-page account brief, recapped the last three Gong calls, and drafted a mutual action plan for the expansion.",
          files: ["gtm/wallace-corp/account-brief.md", "gtm/wallace-corp/org-chart.md"].map((p) => doc("/Users/rachel", p)),
          tools: ["Read", "Write", HUBSPOT, GONG, "WebSearch"],
          skills: ["gtm-research:account-brief"],
          turns: 9,
          friction: "light",
          instances: 4,
          tasks: [
            {
              description: "Pull Wallace Corp's org chart and recent activity into a one-page brief",
              outcome: "success",
              frustration: "none",
              signals: ["clear ask", "confirmed complete"],
              outcomeReason: "Brief was written and Rachel moved on to the next account.",
              evidence: "Wrote account-brief.md covering stakeholders, spend, and last three calls.",
            },
            {
              description: "Summarize the last three Gong calls with Wallace Corp",
              outcome: "success",
              frustration: "moderate",
              signals: ["one re-ask for a shorter version"],
              outcomeReason: "Delivered after a follow-up asking to trim it to five bullets.",
              evidence: "Condensed three call transcripts into a five-bullet recap.",
            },
            {
              description: "Draft a mutual action plan for the expansion",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Rachel exported the plan to share with the champion.",
              evidence: "Outlined a mutual action plan with owners and target dates.",
            },
          ],
        },
        {
          title: "Prep me for the Wallace Corp renewal call",
          summary:
            "Gathered the open support tickets that could threaten the renewal and started assembling talking points, but the call prep was left unfinished after repeated redirects.",
          files: [doc("/Users/rachel", "gtm/wallace-corp/call-prep.md")],
          tools: ["Read", GONG, SALESFORCE, "WebFetch"],
          turns: 6,
          friction: "heavy",
          instances: 3,
          tasks: [
            {
              description: "Pull the open support tickets that could threaten the renewal",
              outcome: "success",
              frustration: "moderate",
              signals: ["declined a Salesforce write"],
              outcomeReason: "Got the ticket list after declining an auto-update to the record.",
              evidence: "Listed four open support tickets tied to the account.",
            },
            {
              description: "Assemble talking points and open risks ahead of the renewal call",
              outcome: "unclear",
              frustration: "high",
              signals: ["repeated re-asks", "interrupted twice", "declined a Salesforce write"],
              outcomeReason: "Rachel kept redirecting and stopped before a final version was agreed.",
              evidence: "Several drafts of talking points; last turn was interrupted mid-answer.",
            },
          ],
        },
      ],
    },
    {
      project: "enterprise-deal-desk",
      source: "cowork",
      model: "claude-sonnet-4-6",
      sessions: [
        {
          title: "What discount can I offer Rosen Associates at 200 seats?",
          summary:
            "Worked out the approved volume-discount tier and the sign-off needed to quote a 200-seat Rosen Associates deal.",
          turns: 4,
          instances: 3,
          tasks: [
            {
              description: "Work out the approved discount for a 200-seat Rosen Associates deal",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Rachel got the tier and threshold she needed to quote.",
              evidence: "Explained the 200-seat volume tier and the sign-off needed above it.",
            },
          ],
        },
        {
          title: "Rewrite this proposal intro to sound less templated",
          summary:
            "Reworked the proposal opening over two passes so it reads as written specifically for Rosen Associates and names their expansion goal.",
          turns: 3,
          instances: 4,
          tasks: [
            {
              description: "Make the proposal opening feel written for Rosen Associates specifically",
              outcome: "success",
              frustration: "moderate",
              signals: ["one re-ask for a warmer tone"],
              outcomeReason: "Second pass landed the tone Rachel wanted.",
              evidence: "Reworked the intro twice; kept the version naming their expansion goal.",
            },
          ],
        },
      ],
    },
  ],
};

// ---- Priya — Content Marketing Lead (Cowork) ---------------------------------------------------
const PRIYA: TeamMember = {
  key: "priya",
  name: "Priya Shah",
  email: "priya@tyrell.example",
  home: "/Users/priya",
  role: "marketing",
  projects: [
    {
      project: "q3-launch-campaign",
      source: "cowork",
      model: "claude-opus-4-1",
      secondaryModel: "claude-haiku-4-5-20251001",
      sessions: [
        {
          title: "Draft the Q3 launch campaign brief",
          summary:
            "Turned the positioning doc into a full Q3 campaign brief, proposed three headline options, and mapped the messaging to the three target segments.",
          files: ["marketing/q3-launch/campaign-brief.md", "marketing/q3-launch/messaging.md"].map((p) => doc("/Users/priya", p)),
          tools: ["Read", "Write", NOTION, "WebSearch", GDRIVE],
          skills: ["content-studio:blog-draft"],
          turns: 12,
          friction: "growth",
          instances: 3,
          tasks: [
            {
              description: "Turn the positioning doc into a full campaign brief",
              outcome: "success",
              frustration: "moderate",
              signals: ["long session", "context compacted once"],
              outcomeReason: "Brief finished, though the session grew large before wrapping.",
              evidence: "Expanded messaging.md into a brief with audience, channels, and timeline.",
            },
            {
              description: "Draft three headline options for the launch",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Priya picked one of the three headlines.",
              evidence: "Proposed three headlines; the second was marked as the pick.",
            },
            {
              description: "Map the campaign messaging to the three target segments",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Segment map approved and folded into the brief.",
              evidence: "Added a segment-to-message map to the brief.",
            },
          ],
        },
        {
          title: "Write the launch blog post from the campaign brief",
          summary:
            "Drafted a 900-word launch blog post in Tyrell's voice from the campaign brief, plus its title tag and meta description.",
          files: [doc("/Users/priya", "marketing/q3-launch/blog-post.md")],
          tools: ["Read", "Write", GDRIVE, "WebFetch"],
          skills: ["content-studio:blog-draft"],
          turns: 8,
          friction: "light",
          instances: 4,
          tasks: [
            {
              description: "Draft a 900-word launch blog post in Tyrell's voice",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Draft delivered at length and saved to the docs folder.",
              evidence: "Wrote blog-post.md at ~900 words following the brief's outline.",
            },
            {
              description: "Write the meta description and title tag for the post",
              outcome: "success",
              frustration: "none",
              outcomeReason: "SEO fields drafted and saved with the post.",
              evidence: "Produced a 155-character meta description and a title tag.",
            },
          ],
        },
        {
          title: "Turn the blog post into a week of social copy",
          summary:
            "Produced five social posts with a posting schedule and two LinkedIn thought-leadership variants, then shared the plan to Slack.",
          files: [doc("/Users/priya", "marketing/q3-launch/social-calendar.md")],
          tools: ["Read", "Write", SLACK],
          skills: ["content-studio:social-copy"],
          turns: 6,
          friction: "none",
          tasks: [
            {
              description: "Produce five social posts and a posting schedule",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Calendar and posts were saved and shared to the channel.",
              evidence: "Created five posts and a schedule; posted the plan to Slack.",
            },
            {
              description: "Draft two LinkedIn thought-leadership variants",
              outcome: "success",
              frustration: "moderate",
              signals: ["one re-ask for a less salesy tone"],
              outcomeReason: "Second pass toned down the pitch.",
              evidence: "Wrote two LinkedIn variants; kept the softer one.",
            },
          ],
        },
      ],
    },
    {
      project: "competitive-research",
      source: "cowork",
      model: "claude-sonnet-4-6",
      sessions: [
        {
          title: "How does Meridian Software position against us?",
          summary:
            "Compared Meridian Software's positioning and pricing tiers to Tyrell's and called out two gaps to exploit.",
          turns: 5,
          instances: 5,
          tasks: [
            {
              description: "Compare Meridian Software's positioning and pricing to Tyrell's",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Priya got a clear side-by-side she could paste into a doc.",
              evidence: "Laid out positioning, pricing tiers, and two gaps to exploit.",
            },
          ],
        },
        {
          title: "What's Meridian Software's enterprise pricing?",
          summary:
            "Searched Meridian Software's site and public sources for enterprise pricing but found it gated and unpublished, so no figure could be given.",
          turns: 4,
          instances: 2,
          tasks: [
            {
              description: "Find Meridian Software's exact enterprise pricing",
              outcome: "failure",
              frustration: "high",
              signals: ["information not public", "repeated re-asks"],
              outcomeReason: "Meridian doesn't publish enterprise pricing, so no figure could be found.",
              evidence: "Checked their site and public sources; enterprise pricing is gated.",
            },
          ],
        },
      ],
    },
  ],
};

// ---- Marcus — RevOps Analyst (Codex / GPT-5.x, no friction) ------------------------------------
const MARCUS: TeamMember = {
  key: "marcus",
  name: "Marcus Bell",
  email: "marcus@tyrell.example",
  home: "/Users/marcus",
  role: "revops",
  projects: [
    {
      project: "quarterly-forecast",
      source: "codex",
      model: "gpt-5.4",
      secondaryModel: "gpt-5",
      sessions: [
        {
          title: "Build the Q3 forecast model from the pipeline export",
          summary:
            "Reconciled the pipeline export against the CRM totals and built a weighted Q3 forecast with its assumptions documented alongside.",
          files: ["revops/forecast/q3-forecast.csv", "revops/forecast/assumptions.md"].map((p) => doc("/Users/marcus", p)),
          tools: ["read_file", "write_file", "run_shell_command"],
          skills: ["revops-toolkit:forecast"],
          turns: 9,
          instances: 3,
          tasks: [
            {
              description: "Reconcile the pipeline export against the CRM totals",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Totals matched after fixing a currency column.",
              evidence: "Aligned the export sums with the CRM within rounding.",
            },
            {
              description: "Turn the pipeline export into a weighted Q3 forecast",
              outcome: "success",
              frustration: "moderate",
              signals: ["one re-run after fixing a stage weight"],
              outcomeReason: "Forecast produced after correcting a stage-probability weight.",
              evidence: "Computed a weighted forecast and wrote assumptions.md alongside it.",
            },
            {
              description: "Document the forecast assumptions for the readout",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Assumptions written alongside the model.",
              evidence: "Wrote assumptions.md covering weights and cutoffs.",
            },
          ],
        },
        {
          title: "Rebalance territories so reps are within 15% of quota",
          summary:
            "Summarized the current per-rep quota load but couldn't find a territory split that satisfied both the geography and quota constraints.",
          files: [doc("/Users/marcus", "revops/forecast/territory-plan.csv")],
          tools: ["read_file", "write_file"],
          turns: 7,
          tasks: [
            {
              description: "Summarize the current quota load per rep",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Marcus got the current per-rep load table.",
              evidence: "Produced a per-rep quota-load summary.",
            },
            {
              description: "Propose a territory split that evens out quota load",
              outcome: "failure",
              frustration: "high",
              signals: ["repeated re-asks", "constraints conflicted"],
              outcomeReason: "No split satisfied both the geography and quota constraints Marcus set.",
              evidence: "Several attempts; each left at least one rep >15% off quota.",
            },
          ],
        },
      ],
    },
    {
      project: "rev-reporting",
      source: "codex",
      model: "gpt-5.5",
      sessions: [
        {
          title: "Generate the weekly revenue dashboard export",
          summary: "Generated the weekly revenue and pipeline dashboard CSV in the standard column format.",
          files: [doc("/Users/marcus", "revops/reporting/weekly-dashboard.csv")],
          tools: ["read_file", "write_file", "run_shell_command"],
          turns: 5,
          instances: 8,
          tasks: [
            {
              description: "Produce the weekly revenue and pipeline dashboard CSV",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Export generated and matched last week's format.",
              evidence: "Wrote weekly-dashboard.csv with the standard columns.",
            },
          ],
        },
        {
          title: "Reconcile the revenue export with the billing system",
          summary:
            "Lined up the revenue export against the billing totals period by period, but a persistent variance was never traced to a source.",
          files: [doc("/Users/marcus", "revops/reporting/reconciliation.csv")],
          tools: ["read_file", "write_file", "run_shell_command"],
          turns: 7,
          tasks: [
            {
              description: "Pull the revenue export and the billing totals side by side",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Both datasets were loaded and aligned by period.",
              evidence: "Produced a period-by-period comparison table.",
            },
            {
              description: "Reconcile the export against the billing system totals",
              outcome: "failure",
              frustration: "high",
              signals: ["totals never matched", "repeated re-runs"],
              outcomeReason: "A persistent variance remained that couldn't be traced to a source.",
              evidence: "Multiple passes still left an unexplained gap.",
            },
          ],
        },
      ],
    },
  ],
};

// ---- Dana — GTM AI-ops Engineer (Claude Code; the friction-heavy operator) ---------------------
const DANA: TeamMember = {
  key: "dana",
  name: "Dana Okafor",
  email: "dana@tyrell.example",
  home: "/Users/dana",
  role: "ai-ops",
  projects: [
    {
      project: "sales-agent-ops",
      source: "claude",
      model: "claude-sonnet-4-6",
      sessions: [
        {
          title: "Set up the HubSpot MCP server for the outreach agent",
          summary:
            "Connected the outreach agent to HubSpot, confirmed a test contact lookup after approving the read scope, and wrote setup notes a teammate can follow.",
          files: ["agent-ops/outreach-agent/config.md", "agent-ops/outreach-agent/prompt.md"].map((p) => doc("/Users/dana", p)),
          tools: ["Read", "Write", "Edit", "Bash", HUBSPOT, "WebFetch"],
          turns: 8,
          friction: "heavy",
          instances: 3,
          tasks: [
            {
              description: "Connect the outreach agent to HubSpot and confirm it can read contacts",
              outcome: "success",
              frustration: "moderate",
              signals: ["one permission declined", "one interruption"],
              outcomeReason: "Connection worked after Dana approved the contact-read scope.",
              evidence: "Configured the server; a test contact lookup returned results.",
            },
            {
              description: "Write setup notes so a teammate can reproduce the config",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Notes saved to config.md.",
              evidence: "Documented the MCP setup steps in config.md.",
            },
          ],
        },
        {
          title: "Tune the outreach agent's tone so it stops sounding pushy",
          summary:
            "Added a worked example and softened the outreach agent's system prompt over many iterations; the tone improved but wasn't signed off as final.",
          files: [doc("/Users/dana", "agent-ops/outreach-agent/prompt.md")],
          tools: ["Read", "Edit", "Bash"],
          turns: 12,
          friction: "growth",
          instances: 3,
          tasks: [
            {
              description: "Add a worked example of a good outreach reply to the prompt",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Example added to the prompt.",
              evidence: "Inserted a worked example into prompt.md.",
            },
            {
              description: "Compare the before and after tone on five sample leads",
              outcome: "unclear",
              frustration: "moderate",
              signals: ["hard to judge the improvement"],
              outcomeReason: "The change looked real but was hard to quantify.",
              evidence: "Ran five before/after comparisons; results were mixed.",
            },
            {
              description: "Revise the system prompt to soften the outreach tone",
              outcome: "unclear",
              frustration: "high",
              signals: ["long session", "compacted twice", "repeated re-asks"],
              outcomeReason: "Tone improved but Dana wasn't ready to call it final.",
              evidence: "Iterated on the prompt many times; results were closer but not signed off.",
            },
          ],
        },
        {
          title: "Stop the outreach agent from inventing account details",
          summary:
            "Added guardrails against fabricated account facts, which cut the invented details down but didn't stop the agent making up figures in testing.",
          files: [doc("/Users/dana", "agent-ops/outreach-agent/prompt.md")],
          tools: ["Read", "Edit", "Bash"],
          turns: 8,
          friction: "heavy",
          instances: 2,
          tasks: [
            {
              description: "Add guardrails against fabricated account facts",
              outcome: "success",
              frustration: "moderate",
              signals: ["one interruption"],
              outcomeReason: "Added constraints that cut down the invented details.",
              evidence: "Edited prompt.md to forbid unverified claims.",
            },
            {
              description: "Get the agent to stop inventing account details entirely",
              outcome: "failure",
              frustration: "high",
              signals: ["repeated re-asks", "problem persisted"],
              outcomeReason: "The agent still fabricated figures in testing despite the guardrails.",
              evidence: "Several prompt revisions; test replies still made up numbers.",
            },
          ],
        },
      ],
    },
    {
      project: "agent-eval-harness",
      source: "claude",
      model: "claude-sonnet-4-6",
      secondaryModel: "claude-haiku-4-5-20251001",
      sessions: [
        {
          title: "Run the outreach agent against the eval set and score it",
          summary:
            "Scored the outreach agent's replies against the eval rubric and flagged the six failing cases for follow-up.",
          files: ["agent-ops/evals/eval-set.md", "agent-ops/evals/results.csv"].map((p) => doc("/Users/dana", p)),
          tools: ["Read", "Write", "Bash"],
          skills: ["deep-research"],
          turns: 7,
          friction: "light",
          instances: 4,
          tasks: [
            {
              description: "Score the outreach agent's replies against the eval rubric",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Scores written to results.csv for review.",
              evidence: "Ran the eval set and recorded per-case scores.",
            },
            {
              description: "Flag the eval cases the agent failed",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Failing cases listed for follow-up.",
              evidence: "Marked six failing cases in results.csv.",
            },
          ],
        },
      ],
    },
  ],
};

// ---- Tom — Sales Development Rep (Gemini; source-rollup coverage, no friction) -----------------
const TOM: TeamMember = {
  key: "tom",
  name: "Tom Alvarez",
  email: "tom@tyrell.example",
  home: "/Users/tom",
  role: "sdr",
  projects: [
    {
      project: "prospect-research",
      source: "gemini",
      model: "gemini-2.5-pro",
      secondaryModel: "gemini-3-flash",
      sessions: [
        {
          title: "Research the top five accounts in this week's inbound list",
          summary:
            "Built a short qualification snapshot for each of the week's five inbound accounts — size, likely budget owner, and a hook — from public sources.",
          files: [doc("/Users/tom", "sdr/inbound/account-snapshots.md")],
          tools: ["google_search", "read_file", "write_file"],
          turns: 6,
          instances: 6,
          tasks: [
            {
              description: "Build a qualification snapshot for each inbound account",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Tom got a one-line hook and budget-owner guess per account.",
              evidence: "Wrote five snapshots with size, likely owner, and a hook each.",
            },
          ],
        },
        {
          title: "Draft a first-touch email for the Wallace Corp inbound lead",
          summary:
            "Drafted a short, specific first-touch email for the Wallace Corp inbound lead that references their expansion note.",
          files: [doc("/Users/tom", "sdr/inbound/wallace-corp-first-touch.md")],
          tools: ["google_search", "write_file"],
          turns: 4,
          instances: 3,
          tasks: [
            {
              description: "Draft a specific first-touch email for the Wallace Corp lead",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Tom sent the draft after a light edit.",
              evidence: "Produced a four-sentence first-touch email naming their expansion note.",
            },
          ],
        },
      ],
    },
    {
      project: "outbound-list-building",
      source: "gemini",
      model: "gemini-3-flash",
      sessions: [
        {
          title: "Find 20 lookalike accounts to Rosen Associates",
          summary:
            "Assembled a 20-row lookalike list to Rosen Associates by industry and size, but couldn't confirm the named contact for six of them.",
          files: [doc("/Users/tom", "sdr/outbound/rosen-lookalikes.csv")],
          tools: ["google_search", "write_file"],
          turns: 7,
          instances: 2,
          tasks: [
            {
              description: "Assemble 20 lookalike accounts by industry and size",
              outcome: "success",
              frustration: "none",
              outcomeReason: "Tom got the 20-row list he asked for.",
              evidence: "Wrote rosen-lookalikes.csv with 20 accounts matched on industry and size.",
            },
            {
              description: "Attach a named contact to each lookalike account",
              outcome: "unclear",
              frustration: "moderate",
              signals: ["contacts unverifiable for some rows"],
              outcomeReason: "Six of the twenty rows couldn't be matched to a confirmed contact.",
              evidence: "Named contacts for 14 of 20; flagged the rest as unverified.",
            },
          ],
        },
      ],
    },
  ],
};

export const DEMO_TEAM: TeamMember[] = [RACHEL, PRIYA, MARCUS, DANA, TOM];

// ---- Plugin catalog -----------------------------------------------------------------------------
// Hub can't read install/enable state — it only sees *observed* usage (a plugin is "used" if one of its
// skills was invoked; see PluginRow in src/types.ts). This catalog is the world these people install
// from; the generator drives which skills actually fire. The first three own skills the team's sessions
// invoke; `meeting-notes` and `seo-optimizer` are installed but their skills are never used across the
// whole org (feeds the unused/underused signal); `legacy-crm` is disabled.

/** The marketplace the team's plugins come from (invented). */
export const PLUGIN_MARKETPLACE = "tyrell-hub";

export interface PluginCatalogEntry {
  /** Plugin name; the part before ":" in a `plugin:skill` id. */
  name: string;
  enabled: boolean;
  version: string;
  /** How long ago it was installed, relative to the demo anchor date. */
  installedDaysAgo: number;
}

export const PLUGIN_CATALOG: PluginCatalogEntry[] = [
  { name: "gtm-research", enabled: true, version: "2.4.0", installedDaysAgo: 120 },
  { name: "content-studio", enabled: true, version: "1.9.2", installedDaysAgo: 90 },
  { name: "revops-toolkit", enabled: true, version: "3.1.0", installedDaysAgo: 60 },
  { name: "meeting-notes", enabled: true, version: "1.2.0", installedDaysAgo: 150 },
  { name: "seo-optimizer", enabled: true, version: "0.8.1", installedDaysAgo: 45 },
  { name: "legacy-crm", enabled: false, version: "1.0.0", installedDaysAgo: 300 },
];
