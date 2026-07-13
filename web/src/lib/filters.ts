// Shared date-range + source (+ optional user scope) filter state, used by the global FilterBar
// and every view that reads it (Activity, UserActivity, Sessions).

export const KNOWN_SOURCES = ["claude", "codex", "gemini", "cowork"] as const;

const SOURCE_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  cowork: "Cowork",
};

/** Human label for a source id; falls back to the id itself for anything unmapped. */
export function sourceLabel(s: string): string {
  return SOURCE_LABELS[s] ?? s;
}

/** KNOWN_SOURCES ordered by display name, ascending alpha — the order every source picker should use. */
export const SORTED_SOURCES = [...KNOWN_SOURCES].sort((a, b) => sourceLabel(a).localeCompare(sourceLabel(b)));

/** Shared date-range presets for the FilterDropdown "Date" panel. */
export const DATE_PRESETS = [
  { label: "Today", days: 0 },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
] as const;

/** Short "Mon D" rendering of a YYYY-MM-DD date, for a FilterDropdown's pill summary. */
export function formatDateShort(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

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
