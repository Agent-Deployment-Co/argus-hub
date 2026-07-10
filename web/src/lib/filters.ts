// Shared date-range + source (+ optional user scope) filter state, used by the global FilterBar
// and every view that reads it (Activity, UserActivity, Sessions).

export const KNOWN_SOURCES = ["claude", "codex", "gemini", "cowork"] as const;

export interface FilterValues {
  since?: string;
  until?: string;
  source?: string;
  /** Scope to one user's data. Omit for the org-wide team rollup. */
  userId?: string;
}

export function sanitizedSource(source: string | undefined): string | null {
  return source && (KNOWN_SOURCES as readonly string[]).includes(source) ? source : null;
}

export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const DEFAULT_SINCE = () => daysAgo(30);
export const DEFAULT_UNTIL = () => daysAgo(0);

/** True if any filter differs from the default (unscoped) state — drives the reset button. */
export function isFilterActive(filters: FilterValues, defaults: { since: string; until: string }): boolean {
  return (
    (filters.since ?? defaults.since) !== defaults.since ||
    (filters.until ?? defaults.until) !== defaults.until ||
    !!sanitizedSource(filters.source) ||
    !!filters.userId
  );
}
