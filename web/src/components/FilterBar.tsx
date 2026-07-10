import { RotateCcw } from "lucide-react";
import { useUsers } from "../lib/users";
import { KNOWN_SOURCES, type FilterValues } from "../lib/filters";

const SOURCE_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  cowork: "Cowork",
};

interface Props {
  since: string;
  until: string;
  source: string;
  userId?: string;
  /** Show the user/client-scope pill (only relevant for org-wide views). */
  showUser?: boolean;
  loading?: boolean;
  onChange: (patch: Partial<FilterValues>) => void;
  onReset: () => void;
  resettable: boolean;
}

/** Global date-range + source (+ optional user scope) filter bar, pinned above every data view
 *  that opts in. Fully controlled — the owning route is responsible for URL search-param sync. */
export function FilterBar({ since, until, source, userId, showUser, loading, onChange, onReset, resettable }: Props) {
  const usersQuery = useUsers();

  return (
    <div className="filter-bar">
      {loading && <RotateCcw className="filter-spinner" size={14} strokeWidth={2} aria-label="Loading" />}
      {showUser && (
        <div className="select-wrap">
          <select
            className="filter-input"
            aria-label="Filter by user"
            value={userId ?? ""}
            onChange={(e) => onChange({ userId: e.target.value || undefined })}
          >
            <option value="">All users</option>
            {usersQuery.data?.map((u) => (
              <option key={u.userId} value={u.userId}>{u.displayName}</option>
            ))}
          </select>
        </div>
      )}
      <div className="select-wrap">
        <select
          className="filter-input"
          aria-label="Filter by source"
          value={source}
          onChange={(e) => onChange({ source: e.target.value || undefined })}
        >
          <option value="">All sources</option>
          {KNOWN_SOURCES.map((s) => (
            <option key={s} value={s}>{SOURCE_LABELS[s] ?? s}</option>
          ))}
        </select>
      </div>
      <div className="filter-dates">
        <input
          className="filter-input"
          type="date"
          aria-label="Since"
          value={since}
          max={until}
          onChange={(e) => onChange({ since: e.target.value || undefined })}
        />
        <span className="filter-dash">→</span>
        <input
          className="filter-input"
          type="date"
          aria-label="Until"
          value={until}
          min={since}
          onChange={(e) => onChange({ until: e.target.value || undefined })}
        />
      </div>
      <button
        type="button"
        className="filter-reset"
        title="Reset filters"
        aria-label="Reset filters"
        disabled={!resettable}
        onClick={onReset}
      >
        <RotateCcw size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
