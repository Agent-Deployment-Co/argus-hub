// Shared query-parameter parsing for the Hub's read APIs.
//
// Both the REST routes (src/api/serve.ts) and the MCP tools (src/api/mcp.ts) turn a bag of
// caller-supplied string params into the same ResolvedQuery / scope / filter shapes. They pull
// those params from different places — Hono's `c.req.query(...)` for REST, a JSON args object for
// MCP — so these parsers take a `QueryGetter` lookup instead of a Context, and both callers adapt
// to it. Keeping the vocabulary in one module is the anti-drift guarantee: the two surfaces can't
// interpret `source`/`outcome`/`user` differently.

import type { ResolvedQuery } from "../types.ts";
import type { TaskOutcomeFilter } from "./task-list.ts";

/** Look up a single query param by name; undefined when absent. */
export type QueryGetter = (key: string) => string | undefined;

export const VALID_SOURCES = new Set(["claude", "codex", "gemini", "cowork"]);
export const VALID_SORTS = new Set<string>(["recent", "tokens", "cost"]);
export const VALID_OUTCOMES = new Set<TaskOutcomeFilter>(["success", "failure", "unknown"]);
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function parseIntOr(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse since/until/project/source into a ResolvedQuery. Returns an error string on bad input. */
export function parseResolvedQuery(get: QueryGetter): ResolvedQuery | string {
  const source = get("source");
  if (source && !VALID_SOURCES.has(source)) return `Unknown source "${source}".`;
  const q: ResolvedQuery = {};
  const since = get("since");
  const until = get("until");
  const project = get("project");
  if (since) q.since = since;
  if (until) q.until = until;
  if (project) q.projectSubstring = project;
  if (source) q.sources = [source as "claude" | "codex" | "gemini" | "cowork"];
  return q;
}

/** Parse the `user` param. Returns undefined (all users) or the specific userId. */
export function parseUserScope(get: QueryGetter): string | undefined {
  return get("user")?.trim() || undefined;
}

/** Parse the `group` param. Returns undefined (all groups) or the caller-supplied filter value
 *  (matched by the caller against a user's groupId or groupName). */
export function parseGroupScope(get: QueryGetter): string | undefined {
  return get("group")?.trim() || undefined;
}

/** Parse the `outcome` param (comma-separated success/failure/unknown). Returns undefined (no
 *  filter) or an error string on an unrecognized value. */
export function parseOutcomeFilter(get: QueryGetter): TaskOutcomeFilter[] | string | undefined {
  const raw = get("outcome");
  if (!raw) return undefined;
  const values = raw.split(",").map((v) => v.trim()).filter(Boolean);
  for (const v of values) {
    if (!VALID_OUTCOMES.has(v as TaskOutcomeFilter)) return `Unknown outcome "${v}".`;
  }
  return values.length ? (values as TaskOutcomeFilter[]) : undefined;
}
