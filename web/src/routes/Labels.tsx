import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "../components/Modal";
import {
  useCreateLabel, useDeleteLabel, useLabelPreview, useLabels, useUpdateLabel,
  type HubLabel, type LabelPreviewTask, type TaskRef,
} from "../lib/labels";

/** Hub-level task labels: created and applied directly by a hub admin, or auto-applied via an
 *  LLM classifier reviewed through the wizard below. Distinct from Argus client task labels —
 *  see AUTO_LABEL_PLAN.md. */
export function Labels() {
  const labelsQuery = useLabels();
  const deleteLabel = useDeleteLabel();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<HubLabel | null>(null);
  const [deleting, setDeleting] = useState<HubLabel | null>(null);
  const [reviewing, setReviewing] = useState<ReviewState | null>(null);

  const labels = labelsQuery.data ?? [];

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
                      onClick={() => setEditing(label)}
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
        <CreateLabelDialog
          onClose={() => setCreating(false)}
          onReview={(name, description) => {
            setCreating(false);
            setReviewing({ mode: "create", name, description, tasks: null });
          }}
        />
      )}
      {editing && (
        <EditLabelDialog
          label={editing}
          onClose={() => setEditing(null)}
          onReview={(name, description) => {
            setEditing(null);
            setReviewing({ mode: "edit", labelId: editing.labelId, name, description, tasks: null });
          }}
        />
      )}
      {reviewing && (
        <ReviewLabelDialog
          state={reviewing}
          onClose={() => setReviewing(null)}
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

// ---- Create / Edit ----------------------------------------------------------------------
//
// Both dialogs share the same fields (name, description, "Apply automatically" toggle). With
// the toggle off, submitting saves immediately. With it on, the submit button reads "Review"
// and hands off to ReviewLabelDialog instead of saving directly — see AUTO_LABEL_PLAN.md.

function CreateLabelDialog({
  onClose, onReview,
}: {
  onClose: () => void;
  onReview: (name: string, description: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [autoApply, setAutoApply] = useState(false);
  const createLabel = useCreateLabel();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (autoApply) {
      onReview(name.trim(), description.trim());
      return;
    }
    createLabel.mutate({ name: name.trim(), description: description.trim() }, { onSuccess: onClose });
  };

  return (
    <Modal title="New label" onClose={onClose}>
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
            placeholder="What this label means. A few example tasks helps the classifier if you turn on Apply automatically below."
            rows={3}
          />
        </label>
        <AutoApplyToggle checked={autoApply} onChange={setAutoApply} />
        {createLabel.isError && <p className="modal-error">{(createLabel.error as Error).message}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={!name.trim() || createLabel.isPending}>
            {createLabel.isPending ? "Creating…" : autoApply ? "Review" : "Create label"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

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
  tasks: LabelPreviewTask[] | null;
}

function ReviewLabelDialog({ state, onClose }: { state: ReviewState; onClose: () => void }) {
  const preview = useLabelPreview();
  const createLabel = useCreateLabel();
  const updateLabel = useUpdateLabel();
  const [tasks, setTasks] = useState<LabelPreviewTask[] | null>(state.tasks);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const { mutate: runPreview } = preview;

  useEffect(() => {
    runPreview(
      { name: state.name, description: state.description },
      {
        onSuccess: (result) => {
          setTasks(result);
          setChecked(new Set(result.filter((t) => t.matched).map(taskKey)));
        },
      },
    );
    // Runs once when the wizard opens for this name/description — re-running on every
    // keystroke isn't wanted, and the dialog is remounted fresh each time it's opened anyway.
  }, []);

  const toggle = (key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const confirming = createLabel.isPending || updateLabel.isPending;
  const confirmError = (createLabel.error ?? updateLabel.error) as Error | null;

  const onConfirm = () => {
    const taskRefs: TaskRef[] = (tasks ?? [])
      .filter((t) => checked.has(taskKey(t)))
      .map((t) => ({ clientId: t.clientId, sessionId: t.sessionId, taskSeq: t.taskSeq }));

    if (state.mode === "create") {
      createLabel.mutate(
        { name: state.name, description: state.description, autoApply: true, taskRefs },
        { onSuccess: onClose },
      );
    } else {
      updateLabel.mutate(
        { labelId: state.labelId!, name: state.name, description: state.description, autoApply: true, taskRefs },
        { onSuccess: onClose },
      );
    }
  };

  return (
    <Modal title={`Review "${state.name}"`} onClose={onClose} size="wide">
      <div className="modal-form">
        {preview.isPending && <p className="modal-copy">Classifying the last 10 tasks…</p>}
        {preview.isError && (
          <p className="modal-error">{(preview.error as Error).message}</p>
        )}
        {tasks && (
          <>
            <p className="modal-copy">
              The classifier's judgment on your org's last {tasks.length} tasks. Uncheck any it
              got wrong, or check ones it missed — only checked tasks get the label.
            </p>
            <ul className="review-task-list">
              {tasks.map((task) => {
                const key = taskKey(task);
                return (
                  <li key={key} className="review-task-row">
                    <label>
                      <input
                        type="checkbox"
                        checked={checked.has(key)}
                        onChange={() => toggle(key)}
                      />
                      <span className="review-task-description">{task.description}</span>
                    </label>
                    {task.reasoning && <p className="review-task-reasoning">{task.reasoning}</p>}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {confirmError && <p className="modal-error">{confirmError.message}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn-primary"
            disabled={!tasks || confirming}
            onClick={onConfirm}
          >
            {confirming ? "Saving…" : "Confirm"}
          </button>
        </div>
      </div>
    </Modal>
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
