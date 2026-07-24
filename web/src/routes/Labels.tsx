import { Plus, Tag, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Modal } from "../components/Modal";
import { useCreateLabel, useDeleteLabel, useLabels, type HubLabel } from "../lib/labels";

/** Hub-level task labels: created and applied directly by a hub admin. Distinct from Argus
 *  client task labels — see ARGUS_HUB_LABELS_PLAN.md. */
export function Labels() {
  const labelsQuery = useLabels();
  const deleteLabel = useDeleteLabel();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<HubLabel | null>(null);

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
                <th className="num">Tasks</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {labels.map((label) => (
                <tr key={label.labelId}>
                  <td>
                    <span className="table-link" style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                      <Tag size={13} strokeWidth={2} aria-hidden /> {label.name}
                    </span>
                  </td>
                  <td className="num">{label.taskCount}</td>
                  <td>
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

      {creating && <CreateLabelDialog onClose={() => setCreating(false)} />}
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

function CreateLabelDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const createLabel = useCreateLabel();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createLabel.mutate(name.trim(), { onSuccess: onClose });
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
        <p className="modal-copy">
          Labels aren't applied automatically — apply them to individual tasks from the Tasks page.
        </p>
        {createLabel.isError && <p className="modal-error">{(createLabel.error as Error).message}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={!name.trim() || createLabel.isPending}>
            {createLabel.isPending ? "Creating…" : "Create label"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

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
