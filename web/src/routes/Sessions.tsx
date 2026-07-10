import { getRouteApi, Link, Outlet, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { FilterBar } from "../components/FilterBar";
import { compactProject, dayStamp, fmt, usd } from "../lib/format";
import { DEFAULT_SINCE, DEFAULT_UNTIL, isFilterActive } from "../lib/filters";
import { useSessionList, type SessionsSearch } from "../lib/sessions";
import type { SessionListItem, SessionSort } from "../types";

const PAGE_SIZE = 50;

const SORT_OPTIONS: { key: SessionSort; label: string }[] = [
  { key: "recent", label: "Most recent" },
  { key: "tokens", label: "Most tokens" },
  { key: "cost", label: "Highest cost" },
];

function sourceLabel(source: string): string {
  return source.charAt(0).toUpperCase() + source.slice(1);
}

const routeApi = getRouteApi("/sessions");

/** Sessions inbox: a searchable, filterable, sortable list backed by GET /api/sessions, with a
 *  detail pane (the route's Outlet) alongside it — matches Argus's own two-pane sessions view. */
export function Sessions() {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const params = useParams({ strict: false }) as { sessionId?: string };
  const activeId = params.sessionId;

  const since = search.since ?? DEFAULT_SINCE();
  const until = search.until ?? DEFAULT_UNTIL();
  const source = search.source ?? "";
  const userId = search.user;
  const sort = search.sort ?? "recent";
  const q = search.q ?? "";
  const [draft, setDraft] = useState(q);
  const [limit, setLimit] = useState(PAGE_SIZE);

  useEffect(() => setDraft(q), [q]);
  useEffect(() => setLimit(PAGE_SIZE), [since, until, source, userId, sort, q]);

  useEffect(() => {
    const trimmed = draft.trim();
    if (trimmed === q) return;
    const handle = setTimeout(() => {
      navigate({ to: ".", search: (prev: SessionsSearch) => ({ ...prev, q: trimmed || undefined }), replace: true });
    }, 300);
    return () => clearTimeout(handle);
  }, [draft, q, navigate]);

  const query = useSessionList({ since, until, source, userId, sort, q, limit, offset: 0 });
  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;

  const searchInputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef(new Map<string, HTMLAnchorElement>());

  const openSession = (sessionId: string) =>
    navigate({ to: "/sessions/$sessionId", params: { sessionId }, search: (prev: SessionsSearch) => prev });

  // j/k row stepping + "/" and Cmd/Ctrl+K to focus search, matching Argus's own sessions list.
  useEffect(() => {
    function isTypingTarget(el: EventTarget | null): boolean {
      const node = el as HTMLElement | null;
      const tag = node?.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!node?.isContentEditable;
    }

    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (e.target === searchInputRef.current) {
        if (e.key === "Enter" && rows.length > 0) {
          e.preventDefault();
          openSession(rows[0]!.sessionId);
          searchInputRef.current?.blur();
        }
        return;
      }
      if (e.key === "/" && !isTypingTarget(e.target)) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (isTypingTarget(e.target)) return;
      if (e.key !== "j" && e.key !== "k") return;
      if (rows.length === 0) return;
      e.preventDefault();
      const idx = rows.findIndex((r) => r.sessionId === activeId);
      const nextIdx =
        e.key === "j" ? (idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1)) : idx < 0 ? 0 : Math.max(0, idx - 1);
      const next = rows[nextIdx]!;
      openSession(next.sessionId);
      itemRefs.current.get(next.sessionId)?.scrollIntoView({ block: "nearest" });
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rows, activeId]);

  const patchFilters = (patch: Partial<{ since: string; until: string; source: string; userId: string }>) =>
    navigate({
      to: ".",
      search: (prev: SessionsSearch) => ({
        ...prev,
        since: patch.since !== undefined ? patch.since || undefined : prev.since,
        until: patch.until !== undefined ? patch.until || undefined : prev.until,
        source: "source" in patch ? patch.source || undefined : prev.source,
        user: "userId" in patch ? patch.userId || undefined : prev.user,
      }),
      replace: true,
    });

  const resetFilters = () => {
    setDraft("");
    navigate({ to: ".", search: {}, replace: true });
  };

  return (
    <>
      <FilterBar
        since={since}
        until={until}
        source={source}
        userId={userId}
        showUser
        loading={query.isFetching}
        onChange={patchFilters}
        onReset={resetFilters}
        resettable={isFilterActive(search, { since: DEFAULT_SINCE(), until: DEFAULT_UNTIL() }) || !!q}
      />
      <div className="sessions-split">
        <div className="session-list">
          <div className="session-list-head">
            <div className="session-search-row">
              <input
                ref={searchInputRef}
                className="session-search"
                type="search"
                placeholder="Search sessions… (try file:path/to/file)"
                aria-label="Search sessions"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <select
                className="session-sort"
                aria-label="Sort sessions"
                value={sort}
                onChange={(e) => navigate({ to: ".", search: (prev: SessionsSearch) => ({ ...prev, sort: e.target.value as SessionSort }), replace: true })}
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
            </div>
            <span className="session-count">
              {query.isPending ? "Loading…" : total === 1 ? "1 session" : `${fmt(total)} sessions`}
            </span>
          </div>
          <ul className="session-items">
            {query.isError ? (
              <li className="session-empty-row">{(query.error as Error).message}</li>
            ) : query.isPending ? (
              <li className="session-empty-row">Loading…</li>
            ) : rows.length === 0 ? (
              <li className="session-empty-row">No sessions found.</li>
            ) : (
              rows.map((row) => (
                <SessionListRow
                  key={row.sessionId}
                  row={row}
                  active={row.sessionId === activeId}
                  userId={userId}
                  linkRef={(el) => {
                    if (el) itemRefs.current.set(row.sessionId, el);
                    else itemRefs.current.delete(row.sessionId);
                  }}
                />
              ))
            )}
          </ul>
          {rows.length < total && (
            <button
              type="button"
              className="session-load-more"
              disabled={query.isFetching}
              onClick={() => setLimit((n) => n + PAGE_SIZE)}
            >
              {query.isFetching ? "Loading…" : `Load more (${fmt(total - rows.length)} remaining)`}
            </button>
          )}
        </div>
        <div className="session-detail">
          <Outlet />
        </div>
      </div>
    </>
  );
}

function SessionListRow({
  row,
  active,
  userId,
  linkRef,
}: {
  row: SessionListItem;
  active: boolean;
  userId?: string;
  linkRef: (el: HTMLAnchorElement | null) => void;
}) {
  return (
    <li>
      <Link
        ref={linkRef}
        to="/sessions/$sessionId"
        params={{ sessionId: row.sessionId }}
        search={(prev: SessionsSearch) => prev}
        className={`session-item${active ? " active" : ""}`}
        title={row.firstPrompt ?? undefined}
      >
        <div className="session-item-title">{row.firstPrompt || "(no prompt captured)"}</div>
        <div className="session-item-meta">
          <span className="pill">{sourceLabel(row.source)}</span>
          <span className="muted truncate">{compactProject(row.project)}</span>
        </div>
        {row.matchSource === "file" && row.matchedFile && (
          <div className="session-item-match">Matched file: <code>{row.matchedFile}</code></div>
        )}
        {(row.matchSource === "project" || row.matchSource === "source") && (
          <div className="session-item-match">Matched on {row.matchSource}</div>
        )}
        <div className="session-item-stats">
          <span>{dayStamp(row.end)}</span>
          <span>{fmt(row.total)} tok</span>
          <span>{usd(row.cost)}</span>
          {!userId && <span className="muted">{row.userMessages ?? 0} msgs</span>}
        </div>
      </Link>
    </li>
  );
}
