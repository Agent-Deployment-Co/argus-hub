import { Check, FolderInput, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { createPortal } from "react-dom";
import { useCreateGroup, useGroups, useSetUserGroup, type HubGroup } from "../lib/groups";

const VIEWPORT_MARGIN = 8;

/** A single user's group assignment, styled after argus's label-popover (search/create input +
 *  a pickable row list in a floating panel) but single-select: picking a group replaces whatever
 *  was previously assigned, and there's no tri-state/"mixed" concept since this is one user. */
export function GroupPicker({
  userId,
  userLabel,
  groupId,
  groupName,
}: {
  userId: string;
  userLabel: string;
  groupId: string | null;
  groupName: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const groupsQuery = useGroups();
  const setUserGroup = useSetUserGroup();
  const createGroup = useCreateGroup();

  // Positioned via a fixed-coordinate portal to document.body rather than an absolutely
  // positioned child, since this trigger sits inside the group table's `.scroll` container
  // (overflow: auto) — an absolute child would get clipped to that container's viewport.
  // Clamped against the viewport (flipping above the trigger, or pinning to an edge) so the
  // panel never renders partly off-screen — before the panel exists we don't know its real
  // size, so the first pass uses its CSS width and a generous height guess; `attachPanel`
  // below re-runs this once the panel is actually in the DOM and its true size is known.
  const clampPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const panelWidth = panelRef.current?.offsetWidth ?? 240;
    const panelHeight = panelRef.current?.offsetHeight ?? 360;

    let left = Math.min(rect.left, window.innerWidth - panelWidth - VIEWPORT_MARGIN);
    left = Math.max(left, VIEWPORT_MARGIN);

    let top = rect.bottom + 6;
    if (top + panelHeight > window.innerHeight - VIEWPORT_MARGIN) {
      const above = rect.top - panelHeight - 6;
      top = above >= VIEWPORT_MARGIN ? above : Math.max(VIEWPORT_MARGIN, window.innerHeight - panelHeight - VIEWPORT_MARGIN);
    }

    setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
  }, []);

  // Fires the moment the portaled panel mounts, so we can re-clamp against its real
  // dimensions instead of the width/height guess used for the first paint.
  const attachPanel = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    if (node) clampPosition();
  }, [clampPosition]);

  useEffect(() => {
    if (!open) return;
    clampPosition();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", clampPosition, true);
    window.addEventListener("resize", clampPosition);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", clampPosition, true);
      window.removeEventListener("resize", clampPosition);
    };
  }, [open, clampPosition]);

  const pick = (nextGroupId: string | null) => {
    setUserGroup.mutate({ userId, groupId: nextGroupId === groupId ? null : nextGroupId });
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn-secondary group-move-btn"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        aria-label={`Move ${userLabel} to a different group (currently ${groupName ?? "Ungrouped"})`}
      >
        <FolderInput size={13} strokeWidth={2} aria-hidden />
        <span>Move</span>
      </button>

      {open && pos && createPortal(
        <GroupPopoverPanel
          panelRef={attachPanel}
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          groups={groupsQuery.data ?? []}
          loading={groupsQuery.isPending}
          selectedGroupId={groupId}
          busy={setUserGroup.isPending || createGroup.isPending}
          error={(setUserGroup.error ?? createGroup.error) as Error | null}
          onPick={pick}
          onCreate={async (name) => {
            const group = await createGroup.mutateAsync(name);
            pick(group.groupId);
          }}
        />,
        document.body,
      )}
    </>
  );
}

function GroupPopoverPanel({
  panelRef,
  style,
  groups,
  loading,
  selectedGroupId,
  busy,
  error,
  onPick,
  onCreate,
}: {
  panelRef: Ref<HTMLDivElement>;
  style: CSSProperties;
  groups: HubGroup[];
  loading: boolean;
  selectedGroupId: string | null;
  busy: boolean;
  error: Error | null;
  onPick: (groupId: string | null) => void;
  onCreate: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = query.trim();
  // Alphabetical, full stop — the selected group is marked with a check but doesn't jump to
  // the top. "Ungrouped" isn't a row here — clearing the group happens via the "Clear" link.
  const rows = [...groups].sort((a, b) => a.name.localeCompare(b.name));
  const filtered = trimmed ? rows.filter((r) => r.name.toLowerCase().includes(trimmed.toLowerCase())) : rows;
  const exactMatch = rows.some((r) => r.name.toLowerCase() === trimmed.toLowerCase());
  const canCreate = trimmed.length > 0 && !exactMatch;

  const submitCreate = () => {
    if (!canCreate) return;
    onCreate(trimmed);
    setQuery("");
  };

  return (
    <div className="group-popover" role="dialog" aria-label="Change group" ref={panelRef} style={style}>
      <div className="group-popover-head">
        <button
          type="button"
          className="group-popover-clear"
          onClick={() => onPick(null)}
          disabled={busy || selectedGroupId === null}
        >
          Clear
        </button>
      </div>

      <input
        ref={inputRef}
        className="group-popover-input"
        placeholder="Find or create a group…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submitCreate();
        }}
      />

      {error && <div className="group-popover-error" role="alert">{error.message}</div>}

      <div className="group-popover-list">
        {loading ? (
          <div className="group-popover-empty">Loading…</div>
        ) : groups.length === 0 ? (
          <div className="group-popover-empty">No groups exist yet.</div>
        ) : filtered.length === 0 && !canCreate ? (
          <div className="group-popover-empty">No matching groups.</div>
        ) : (
          filtered.map((group) => (
            <button
              key={group.groupId}
              type="button"
              className={`group-popover-pick${group.groupId === selectedGroupId ? " is-applied" : ""}`}
              onClick={() => onPick(group.groupId)}
              disabled={busy}
            >
              <span className="group-popover-check">
                {group.groupId === selectedGroupId && <Check size={13} strokeWidth={2.25} aria-hidden />}
              </span>
              <span className="group-popover-name">{group.name}</span>
            </button>
          ))
        )}

        {canCreate && (
          <button type="button" className="group-popover-create" onClick={submitCreate} disabled={busy}>
            <Plus size={13} strokeWidth={2} aria-hidden />
            <span>Create &amp; apply “{trimmed}”</span>
          </button>
        )}
      </div>
    </div>
  );
}
