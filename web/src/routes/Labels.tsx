import { LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Modal } from "../components/Modal";
import {
  useCreateLabel, useDeleteLabel, useLabelPreviewStream, useLabels, useUpdateLabel,
  type HubLabel, type TaskRef,
} from "../lib/labels";

/** Hub-level task labels: created and applied directly by a hub admin, or auto-applied via an
 *  LLM classifier reviewed through the wizard below. Distinct from Argus client task labels —
 *  see AUTO_LABEL_PLAN.md. */
export function Labels() {
  const labelsQuery = useLabels();
  const deleteLabel = useDeleteLabel();
  const [creating, setCreating] = useState(false);
  const [creatingManual, setCreatingManual] = useState(false);
  const [editing, setEditing] = useState<HubLabel | null>(null);
  const [deleting, setDeleting] = useState<HubLabel | null>(null);
  const [reviewing, setReviewing] = useState<ReviewState | null>(null);

  const labels = labelsQuery.data ?? [];

  if (reviewing) {
    return <ReviewLabelPage state={reviewing} onClose={() => setReviewing(null)} />;
  }

  return (
    <>
      <div className="page-head">
        <h1>Labels</h1>
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
          <Plus size={14} strokeWidth={2.5} aria-hidden /> New label
        </button>
      </div>

      {labelsQuery.isPending ? (
        <div className="center-state">Loading…</div>
      ) : labelsQuery.isError ? (
        <div className="center-state">Couldn't load labels: {(labelsQuery.error as Error).message}</div>
      ) : labels.length === 0 ? (
        <p className="muted">
          No labels yet. Create one, then apply it to tasks from the Tasks page.
        </p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Automated</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {labels.map((label) => (
                <tr key={label.labelId}>
                  <td>{label.name}</td>
                  <td>{label.autoApply ? "Yes" : "No"}</td>
                  <td className="right">
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => {
                        if (label.autoApply) {
                          setReviewing({
                            mode: "edit",
                            labelId: label.labelId,
                            name: label.name,
                            description: label.description ?? "",
                          });
                        } else {
                          setEditing(label);
                        }
                      }}
                      aria-label={`Edit ${label.name}`}
                    >
                      <Pencil size={14} strokeWidth={2} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setDeleting(label)}
                      aria-label={`Delete ${label.name}`}
                    >
                      <Trash2 size={14} strokeWidth={2} aria-hidden />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <ChooseLabelTypeDialog
          onClose={() => setCreating(false)}
          onManual={() => {
            setCreating(false);
            setCreatingManual(true);
          }}
          onAutomatic={() => {
            setCreating(false);
            setReviewing({ mode: "create", name: "", description: "" });
          }}
        />
      )}
      {creatingManual && <ManualLabelDialog onClose={() => setCreatingManual(false)} />}
      {editing && (
        <EditLabelDialog
          label={editing}
          onClose={() => setEditing(null)}
          onReview={(name, description) => {
            setEditing(null);
            setReviewing({ mode: "edit", labelId: editing.labelId, name, description });
          }}
        />
      )}
      {deleting && (
        <DeleteLabelDialog
          label={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => deleteLabel.mutate(deleting.labelId, { onSuccess: () => setDeleting(null) })}
          pending={deleteLabel.isPending}
          error={deleteLabel.error as Error | null}
        />
      )}
    </>
  );
}

// ---- Create ------------------------------------------------------------------------------
//
// "New label" first asks manual vs. automatic. Manual goes to a plain name/description dialog
// that saves immediately. Automatic hands off straight to the full-page ReviewLabelPage, which
// collects name/description itself and drives the classifier — see AUTO_LABEL_PLAN.md.

function ChooseLabelTypeDialog({
  onClose, onManual, onAutomatic,
}: {
  onClose: () => void;
  onManual: () => void;
  onAutomatic: () => void;
}) {
  return (
    <Modal title="New label" onClose={onClose} size="wide">
      <div className="label-type-cards">
        <button type="button" className="label-type-card" onClick={onManual}>
          <h3>Manual label</h3>
          <p>You apply it yourself, task by task, from the Tasks page.</p>
        </button>
        <button type="button" className="label-type-card" onClick={onAutomatic}>
          <h3>Automatic label</h3>
          <p>An LLM classifies tasks for you. You review its judgment before anything is saved.</p>
        </button>
      </div>
    </Modal>
  );
}

function ManualLabelDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const createLabel = useCreateLabel();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createLabel.mutate({ name: name.trim(), description: description.trim() }, { onSuccess: onClose });
  };

  return (
    <Modal title="New manual label" onClose={onClose}>
      <form className="modal-form" onSubmit={onSubmit}>
        <label className="modal-field">
          <span>Name</span>
          <input
            className="filter-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Needs review"
            autoFocus
          />
        </label>
        <label className="modal-field">
          <span>Description (optional)</span>
          <textarea
            className="filter-input filter-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this label means."
            rows={3}
          />
        </label>
        {createLabel.isError && <p className="modal-error">{(createLabel.error as Error).message}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={!name.trim() || createLabel.isPending}>
            {createLabel.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Edit ----------------------------------------------------------------------------------

function EditLabelDialog({
  label, onClose, onReview,
}: {
  label: HubLabel;
  onClose: () => void;
  onReview: (name: string, description: string) => void;
}) {
  const [name, setName] = useState(label.name);
  const [description, setDescription] = useState(label.description ?? "");
  const [autoApply, setAutoApply] = useState(label.autoApply);
  const updateLabel = useUpdateLabel();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    // Only route through the review wizard if auto-apply is newly turned on, or the admin
    // wants to re-review an already-auto label. Plain renames/redescriptions of a manual label
    // (autoApply stays off) save immediately — no review step needed.
    if (autoApply) {
      onReview(name.trim(), description.trim());
      return;
    }
    updateLabel.mutate(
      { labelId: label.labelId, name: name.trim(), description: description.trim(), autoApply: false },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal title={`Edit "${label.name}"`} onClose={onClose}>
      <form className="modal-form" onSubmit={onSubmit}>
        <label className="modal-field">
          <span>Name</span>
          <input
            className="filter-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        <label className="modal-field">
          <span>Description (optional)</span>
          <textarea
            className="filter-input filter-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this label means. A few example tasks helps the classifier if you turn on Apply automatically below."
            rows={3}
          />
        </label>
        <AutoApplyToggle checked={autoApply} onChange={setAutoApply} />
        {updateLabel.isError && <p className="modal-error">{(updateLabel.error as Error).message}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={!name.trim() || updateLabel.isPending}>
            {updateLabel.isPending ? "Saving…" : autoApply ? "Review" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AutoApplyToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="modal-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        Apply automatically
        <small>An LLM decides which tasks get this label. You'll review its judgment on the
          last 10 tasks before anything is saved.</small>
      </span>
    </label>
  );
}

// ---- Review wizard -----------------------------------------------------------------------

interface ReviewState {
  mode: "create" | "edit";
  labelId?: string;
  name: string;
  description: string;
}

function ReviewLabelPage({ state, onClose }: { state: ReviewState; onClose: () => void }) {
  const preview = useLabelPreviewStream();
  const createLabel = useCreateLabel();
  const updateLabel = useUpdateLabel();
  const [name, setName] = useState(state.name);
  const [description, setDescription] = useState(state.description);
  // The name/description the last preview/rerun was classified against — lets the rerun action
  // enable only once the fields have actually drifted from what's on screen.
  const [lastReviewed, setLastReviewed] = useState<{ name: string; description: string } | null>(null);

  const { tasks } = preview;

  const confirming = createLabel.isPending || updateLabel.isPending;
  const confirmError = (createLabel.error ?? updateLabel.error) as Error | null;

  const runPreview = () => {
    if (!name.trim()) return;
    setLastReviewed({ name: name.trim(), description: description.trim() });
    preview.run({ name: name.trim(), description: description.trim() });
  };

  const isDirty = lastReviewed !== null
    && (name.trim() !== lastReviewed.name || description.trim() !== lastReviewed.description);
  const hasRun = lastReviewed !== null;

  const onConfirm = () => {
    const taskRefs: TaskRef[] = (tasks ?? [])
      .filter((t) => t.matched)
      .map((t) => ({ clientId: t.clientId, sessionId: t.sessionId, taskSeq: t.taskSeq }));

    if (state.mode === "create") {
      createLabel.mutate(
        { name: name.trim(), description: description.trim(), autoApply: true, taskRefs },
        { onSuccess: onClose },
      );
    } else {
      updateLabel.mutate(
        { labelId: state.labelId!, name: name.trim(), description: description.trim(), autoApply: true, taskRefs },
        { onSuccess: onClose },
      );
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>{state.mode === "create" ? "New automatic label" : `Edit "${state.name}"`}</h1>
      </div>

      <div className="modal-form review-fields">
        <label className="modal-field">
          <span>Name</span>
          <input
            className="filter-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Needs review"
            autoFocus
          />
        </label>
        <label className="modal-field">
          <span>Description (optional)</span>
          <textarea
            className="filter-input filter-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this label means. A few example tasks helps the classifier."
            rows={3}
          />
        </label>
        <div className="review-action-row">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={hasRun ? "btn-secondary" : "btn-primary"}
            disabled={hasRun ? !isDirty || preview.isPending : !name.trim() || preview.isPending}
            onClick={runPreview}
          >
            {preview.isPending ? "Running preview…" : hasRun ? "Rerun Preview" : "Preview"}
          </button>
          {tasks && (
            <button type="button" className="btn-primary" disabled={confirming || preview.isPending} onClick={onConfirm}>
              {confirming ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>

      {preview.error && <p className="modal-error">{preview.error.message}</p>}
      {confirmError && <p className="modal-error">{confirmError.message}</p>}
      {tasks && (
        <>
          <p className="modal-copy">
            The classifier's judgment on your org's last {tasks.length} tasks. Matching tasks will
            receive the label when you save.
          </p>
          <div className="scroll review-task-table-wrap">
            <table className="review-task-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Task</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => {
                  const key = taskKey(task);
                  return (
                    <tr key={key}>
                      <td>
                        {task.pending ? (
                          <LoaderCircle size={14} className="spin" aria-label="Classifying" />
                        ) : (
                          <input
                            type="checkbox"
                            checked={task.matched}
                            disabled
                            aria-label={task.matched ? "Label will be applied" : "Label will not be applied"}
                          />
                        )}
                      </td>
                      <td>
                        <div className="review-task-description">{task.description}</div>
                        {task.pending ? (
                          <div className="review-task-reasoning review-task-reasoning-placeholder" aria-hidden />
                        ) : (
                          <div className="review-task-reasoning">{task.reasoning ?? "—"}</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function taskKey(task: TaskRef): string {
  return `${task.clientId}:${task.sessionId}:${task.taskSeq}`;
}

// ---- Delete ------------------------------------------------------------------------------

function DeleteLabelDialog({
  label, onClose, onConfirm, pending, error,
}: {
  label: HubLabel; onClose: () => void; onConfirm: () => void; pending: boolean; error: Error | null;
}) {
  return (
    <Modal title={`Delete "${label.name}"?`} onClose={onClose}>
      <p className="modal-copy">
        This removes the label and every application of it from tasks it was applied to.
      </p>
      {error && <p className="modal-error">{error.message}</p>}
      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-danger" disabled={pending} onClick={onConfirm}>
          {pending ? "Deleting…" : "Delete label"}
        </button>
      </div>
    </Modal>
  );
}
