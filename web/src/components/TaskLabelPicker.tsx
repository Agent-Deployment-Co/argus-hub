import { Check, Plus, Tag } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { createPortal } from "react-dom";
import { useCreateManualLabel, useLabels, useSetTaskLabel, type HubLabel, type TaskRef } from "../lib/labels";
import type { TaskListItemLabel } from "../types";

const VIEWPORT_MARGIN = 8;

/** Toggle which of the org's hub labels apply to a single task. Positioned the same way as
 *  GroupPicker (fixed-coordinate portal, clamped to the viewport) since this trigger also lives
 *  inside a scrolling container. Unlike GroupPicker this is multi-select — labels aren't
 *  mutually exclusive. Supports find/create-and-apply for manual labels the same way
 *  GroupPicker does for groups; auto labels still only come from the /labels candidate-search
 *  flow, so a freshly typed name is always created as "manual". */
export function TaskLabelPicker({ taskRef, applied }: { taskRef: TaskRef; applied: TaskListItemLabel[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const labelsQuery = useLabels();
  const setTaskLabel = useSetTaskLabel();
  const createManualLabel = useCreateManualLabel();
  const appliedIds = new Set(applied.map((l) => l.labelId));

  const clampPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const panelWidth = panelRef.current?.offsetWidth ?? 240;
    const panelHeight = panelRef.current?.offsetHeight ?? 300;

    let left = Math.min(rect.left, window.innerWidth - panelWidth - VIEWPORT_MARGIN);
    left = Math.max(left, VIEWPORT_MARGIN);

    let top = rect.bottom + 6;
    if (top + panelHeight > window.innerHeight - VIEWPORT_MARGIN) {
      const above = rect.top - panelHeight - 6;
      top = above >= VIEWPORT_MARGIN ? above : Math.max(VIEWPORT_MARGIN, window.innerHeight - panelHeight - VIEWPORT_MARGIN);
    }

    setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
  }, []);

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
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
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

  const toggle = (label: HubLabel) => {
    setTaskLabel.mutate({ labelId: label.labelId, ref: taskRef, applied: !appliedIds.has(label.labelId) });
  };

  const clearAll = () => {
    for (const label of applied) {
      setTaskLabel.mutate({ labelId: label.labelId, ref: taskRef, applied: false });
    }
  };

  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery("");
  }, [open]);

  const allLabels = labelsQuery.data ?? [];
  const trimmed = query.trim();
  const filtered = trimmed ? allLabels.filter((l) => l.name.toLowerCase().includes(trimmed.toLowerCase())) : allLabels;
  const exactMatch = allLabels.some((l) => l.name.toLowerCase() === trimmed.toLowerCase());
  const canCreate = trimmed.length > 0 && !exactMatch;
  const busy = setTaskLabel.isPending || createManualLabel.isPending;

  const submitCreate = async () => {
    if (!canCreate) return;
    const label = await createManualLabel.mutateAsync({ name: trimmed });
    setTaskLabel.mutate({ labelId: label.labelId, ref: taskRef, applied: true });
    setQuery("");
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn-secondary task-label-btn"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label="Edit labels"
      >
        <Tag size={13} strokeWidth={2} aria-hidden />
        <span>Labels</span>
      </button>

      {open && pos && createPortal(
        <div
          className="group-popover task-label-popover"
          role="dialog"
          aria-label="Edit labels"
          ref={attachPanel as Ref<HTMLDivElement>}
          style={{ position: "fixed", top: pos.top, left: pos.left } as CSSProperties}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="group-popover-head">
            <button
              type="button"
              className="group-popover-clear"
              onClick={clearAll}
              disabled={busy || applied.length === 0}
            >
              Clear
            </button>
          </div>

          <input
            ref={inputRef}
            className="group-popover-input"
            placeholder="Find or create a label…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitCreate(); }}
          />

          {(setTaskLabel.isError || createManualLabel.isError) && (
            <div className="group-popover-error" role="alert">
              {((createManualLabel.error ?? setTaskLabel.error) as Error).message}
            </div>
          )}

          <div className="group-popover-list">
            {labelsQuery.isPending ? (
              <div className="group-popover-empty">Loading…</div>
            ) : allLabels.length === 0 ? (
              <div className="group-popover-empty">No labels yet.</div>
            ) : filtered.length === 0 && !canCreate ? (
              <div className="group-popover-empty">No matching labels.</div>
            ) : (
              filtered.map((label) => {
                const isApplied = appliedIds.has(label.labelId);
                return (
                  <button
                    key={label.labelId}
                    type="button"
                    className={`group-popover-pick${isApplied ? " is-applied" : ""}`}
                    onClick={() => toggle(label)}
                    disabled={busy}
                  >
                    <span className="group-popover-check">
                      {isApplied && <Check size={13} strokeWidth={2.25} aria-hidden />}
                    </span>
                    <span className="group-popover-name">{label.name}</span>
                    <span className={`pill label-kind-pill label-kind-${label.kind}`}>{label.kind}</span>
                  </button>
                );
              })
            )}

            {canCreate && (
              <button type="button" className="group-popover-create" onClick={submitCreate} disabled={busy}>
                <Plus size={13} strokeWidth={2} aria-hidden />
                <span>Create &amp; apply “{trimmed}”</span>
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
