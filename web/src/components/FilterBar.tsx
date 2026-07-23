import { Calendar, FilterX, Layers, RotateCw, User, Users } from "lucide-react";
import { useUsers } from "../lib/users";
import { useGroups } from "../lib/groups";
import {
  DATE_PRESETS, SORTED_SOURCES, UNGROUPED_SENTINEL, daysAgo, formatDateShort, sourceLabel, type FilterValues,
} from "../lib/filters";
import { FilterDropdown, FilterDropdownOption } from "./FilterDropdown";

interface Props {
  since: string;
  until: string;
  source: string;
  userId?: string;
  groupId?: string;
  /** Show the user/client-scope pill (only relevant for org-wide views). */
  showUser?: boolean;
  /** Show the group-scope pill. */
  showGroup?: boolean;
  loading?: boolean;
  onChange: (patch: Partial<FilterValues>) => void;
  onReset: () => void;
  resettable: boolean;
}

/** Global date-range + source (+ optional user/group scope) filter bar, pinned above every data
 *  view that opts in. Fully controlled — the owning route is responsible for URL search-param
 *  sync. Pill/dropdown shape borrowed from the /sessions-inbox toolbar (FilterDropdown) so every
 *  data view reads as one filter system. */
export function FilterBar({
  since, until, source, userId, groupId, showUser, showGroup, loading, onChange, onReset, resettable,
}: Props) {
  const usersQuery = useUsers();
  const groupsQuery = useGroups();

  const today = daysAgo(0);
  const dateIsDefault = since === daysAgo(30) && until === today;
  const dateSummary = `${formatDateShort(since)} → ${formatDateShort(until)}`;
  const sourcesSummary = source ? sourceLabel(source) : "All sources";
  const userSummary = userId ? (usersQuery.data?.find((u) => u.userId === userId)?.displayName ?? "1 user") : "All users";
  const groupSummary = groupId
    ? (groupId === UNGROUPED_SENTINEL ? "Ungrouped" : (groupsQuery.data?.find((g) => g.groupId === groupId)?.name ?? "1 group"))
    : "All groups";

  const setSince = (v: string) => v && onChange({ since: v > today ? today : v > until ? until : v });
  const setUntil = (v: string) => v && onChange({ until: v > today ? today : v < since ? since : v });

  return (
    <div className="filter-bar" role="group" aria-label="Dashboard filters">
      {showUser && (
        <FilterDropdown
          icon={<User size={14} strokeWidth={2} aria-hidden />}
          label="User"
          summary={userSummary}
          active={Boolean(userId)}
          onClear={userId ? () => onChange({ userId: undefined }) : undefined}
          align="right"
        >
          {(close) => (
            <div className="filter-dropdown-list" role="listbox" aria-label="Users">
              {usersQuery.data?.map((u) => (
                <FilterDropdownOption
                  key={u.userId}
                  label={u.displayName}
                  selected={userId === u.userId}
                  onToggle={() => {
                    onChange({ userId: userId === u.userId ? undefined : u.userId });
                    close();
                  }}
                />
              ))}
              {!usersQuery.data?.length && <p className="filter-dropdown-empty">No users yet.</p>}
            </div>
          )}
        </FilterDropdown>
      )}

      {showGroup && (
        <FilterDropdown
          icon={<Users size={14} strokeWidth={2} aria-hidden />}
          label="Group"
          summary={groupSummary}
          active={Boolean(groupId)}
          onClear={groupId ? () => onChange({ groupId: undefined }) : undefined}
          align="right"
        >
          {(close) => (
            <div className="filter-dropdown-list" role="listbox" aria-label="Groups">
              <FilterDropdownOption
                label="Ungrouped"
                selected={groupId === UNGROUPED_SENTINEL}
                onToggle={() => {
                  onChange({ groupId: groupId === UNGROUPED_SENTINEL ? undefined : UNGROUPED_SENTINEL });
                  close();
                }}
              />
              {groupsQuery.data?.map((g) => (
                <FilterDropdownOption
                  key={g.groupId}
                  label={g.name}
                  selected={groupId === g.groupId}
                  onToggle={() => {
                    onChange({ groupId: groupId === g.groupId ? undefined : g.groupId });
                    close();
                  }}
                />
              ))}
            </div>
          )}
        </FilterDropdown>
      )}

      <FilterDropdown
        icon={<Calendar size={14} strokeWidth={2} aria-hidden />}
        label="Date"
        summary={dateSummary}
        active={!dateIsDefault}
        onClear={dateIsDefault ? undefined : () => onChange({ since: undefined, until: undefined })}
        clearLabel="Reset"
        align="right"
      >
        {(close) => (
          <>
            <div className="filter-dropdown-presets">
              {DATE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={`filter-dropdown-preset${since === daysAgo(p.days) && until === today ? " active" : ""}`}
                  onClick={() => {
                    onChange({ since: daysAgo(p.days), until: today });
                    close();
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="filter-dropdown-dates">
              <input
                type="date"
                className="filter-input"
                aria-label="From date"
                value={since}
                max={until}
                onChange={(e) => setSince(e.target.value)}
              />
              <span className="filter-dash" aria-hidden>
                –
              </span>
              <input
                type="date"
                className="filter-input"
                aria-label="To date"
                value={until}
                min={since}
                max={today}
                onChange={(e) => setUntil(e.target.value)}
              />
            </div>
          </>
        )}
      </FilterDropdown>

      <FilterDropdown
        icon={<Layers size={14} strokeWidth={2} aria-hidden />}
        label="Sources"
        summary={sourcesSummary}
        active={Boolean(source)}
        onClear={source ? () => onChange({ source: undefined }) : undefined}
        align="right"
      >
        {(close) => (
          <div className="filter-dropdown-list" role="listbox" aria-label="Sources">
            {SORTED_SOURCES.map((s) => (
              <FilterDropdownOption
                key={s}
                label={sourceLabel(s)}
                selected={source === s}
                onToggle={() => {
                  onChange({ source: source === s ? undefined : s });
                  close();
                }}
              />
            ))}
          </div>
        )}
      </FilterDropdown>

      <button
        type="button"
        className="inbox-filter-reset"
        disabled={!resettable}
        onClick={onReset}
        title="Reset filters"
        aria-label="Reset filters"
      >
        {loading ? (
          <RotateCw className="filter-spinner" size={16} strokeWidth={2} aria-label="Loading" />
        ) : (
          <FilterX size={16} strokeWidth={1.75} aria-hidden />
        )}
      </button>
    </div>
  );
}
