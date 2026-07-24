import { Plus, Sparkles, Tag, Trash2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Modal } from "../components/Modal";
import {
  useCreateAutoLabel, useCreateManualLabel, useDeleteLabel, useLabelCandidates, useLabels,
  type HubLabel, type LabelCandidate,
} from "../lib/labels";
import { useSettingsQuery } from "../lib/settings";

/** Hub-level task labels: manual (created + applied directly) and auto (seeded by an LLM
 *  candidate search over existing tasks, reviewed before being applied). Distinct from Argus
 *  client task labels — see ARGUS_HUB_LABELS_PLAN.md. */
export function Labels() {
  const labelsQuery = useLabels();
  const settingsQuery = useSettingsQuery();
  const deleteLabel = useDeleteLabel();
  const [creatingManual, setCreatingManual] = useState(false);
  const [creatingAuto, setCreatingAuto] = useState(false);
  const [deleting, setDeleting] = useState<HubLabel | null>(null);

  const labels = labelsQuery.data ?? [];
  const automaticEnabled = settingsQuery.data?.categories[0].sections[0].settings
    .find((setting) => setting.path === "automaticTaggingEnabled")?.value === true;

  return (
    <>
      <div className="page-head">
        <h1>Labels</h1>
        <div className="page-head-actions">
          <button type="button" className="btn-secondary" onClick={() => setCreatingManual(true)}>
            <Plus size={14} strokeWidth={2.5} aria-hidden /> Manual label
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!automaticEnabled}
            title={automaticEnabled ? undefined : "Enable automatic task tagging in Tasks settings first."}
            onClick={() => setCreatingAuto(true)}
          >
            <Sparkles size={14} strokeWidth={2.5} aria-hidden /> Auto label
          </button>
        </div>
      </div>
      {!automaticEnabled && !settingsQuery.isPending && (
        <p className="muted">
          Automatic labels are off.{" "}
          <Link to="/settings/$category" params={{ category: "tasks" }}>Enable them in Tasks settings</Link>.
        </p>
      )}

      {labelsQuery.isPending ? (
        <div className="center-state">Loading…</div>
      ) : labelsQuery.isError ? (
        <div className="center-state">Couldn't load labels: {(labelsQuery.error as Error).message}</div>
      ) : labels.length === 0 ? (
        <p className="muted">
          No labels yet. Create a manual label to apply by hand, or an auto label to have the hub
          find matching tasks for you.
        </p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Description</th>
                <th className="num">Tasks</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {labels.map((label) => (
                <tr key={label.labelId}>
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                      <Tag size={13} strokeWidth={2} aria-hidden /> {label.name}
                    </span>
                  </td>
                  <td>
                    <span className={`pill label-kind-pill label-kind-${label.kind}`}>{label.kind}</span>
                  </td>
                  <td className="muted">{label.description ?? "—"}</td>
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

      {creatingManual && <CreateManualLabelDialog onClose={() => setCreatingManual(false)} />}
      {creatingAuto && <CreateAutoLabelDialog onClose={() => setCreatingAuto(false)} />}
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

function CreateManualLabelDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const createLabel = useCreateManualLabel();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createLabel.mutate(name.trim(), { onSuccess: onClose });
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
        <p className="modal-copy">
          Manual labels aren't applied automatically — apply them to individual tasks from the
          Tasks page.
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

type AutoLabelStep = "describe" | "review";

/** Create-auto-label flow: describe → candidate search (LLM) → review (remove non-matches) →
 *  create, which commits the label and backfills it onto the reviewed tasks in one call. */
function CreateAutoLabelDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<AutoLabelStep>("describe");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [candidates, setCandidates] = useState<LabelCandidate[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [meta, setMeta] = useState<{ consideredCount: number; truncated: boolean } | null>(null);

  const search = useLabelCandidates();
  const createLabel = useCreateAutoLabel();

  const candidateKey = (c: LabelCandidate) => `${c.clientId}:${c.sessionId}:${c.taskSeq}`;
  const kept = candidates.filter((c) => !removed.has(candidateKey(c)));

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !description.trim()) return;
    search.mutate(
      { name: name.trim(), description: description.trim() },
      {
        onSuccess: (result) => {
          setCandidates(result.candidates);
          setRemoved(new Set());
          setMeta({ consideredCount: result.consideredCount, truncated: result.truncated });
          setStep("review");
        },
      },
    );
  };

  const onCommit = () => {
    createLabel.mutate(
      {
        name: name.trim(),
        description: description.trim(),
        taskRefs: kept.map((c) => ({ clientId: c.clientId, sessionId: c.sessionId, taskSeq: c.taskSeq })),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal title="New auto label" onClose={onClose} className="auto-label-modal">
      {step === "describe" ? (
        <form className="modal-form" onSubmit={onSearch}>
          <p className="auto-label-intro">
            Describe the label and Argus will suggest matching tasks for you to review.
          </p>
          <label className="modal-field">
            <span>Name</span>
            <input
              className="filter-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Bug fix"
              autoFocus
            />
          </label>
          <label className="modal-field">
            <span>Description</span>
            <textarea
              className="filter-input"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Which tasks belong under this label?"
            />
          </label>
          {search.isError && <p className="modal-error">{(search.error as Error).message}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button
              type="submit"
              className="btn-primary"
              disabled={!name.trim() || !description.trim() || search.isPending}
            >
              {search.isPending ? "Searching…" : "Find candidates"}
            </button>
          </div>
        </form>
      ) : (
        <div className="modal-form">
          <div className="auto-label-summary">
            <div>
              <strong>{kept.length} selected</strong>
              <span> from {candidates.length} suggestion{candidates.length === 1 ? "" : "s"}</span>
            </div>
            <span className="muted">
              {meta?.consideredCount ?? 0} tasks searched{meta?.truncated ? " · recent tasks only" : ""}
            </span>
          </div>
          {candidates.length === 0 ? (
            <p className="muted">No matching tasks found.</p>
          ) : (
            <div className="auto-label-candidates">
              <ul>
                {candidates.map((c) => {
                  const key = candidateKey(c);
                  const isRemoved = removed.has(key);
                  return (
                    <li key={key}>
                      <label className={isRemoved ? "label-candidate-removed" : ""}>
                        <input
                          type="checkbox"
                          checked={!isRemoved}
                          onChange={() =>
                            setRemoved((prev) => {
                              const next = new Set(prev);
                              if (next.has(key)) next.delete(key); else next.add(key);
                              return next;
                            })
                          }
                        />
                        <span>{c.description}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {createLabel.isError && <p className="modal-error">{(createLabel.error as Error).message}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setStep("describe")}>Back</button>
            <button type="button" className="btn-primary" onClick={onCommit} disabled={createLabel.isPending}>
              {createLabel.isPending ? "Creating…" : "Create label"}
            </button>
          </div>
        </div>
      )}
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
