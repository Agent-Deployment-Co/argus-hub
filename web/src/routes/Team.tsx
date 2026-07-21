import { Link } from "@tanstack/react-router";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { GroupPicker } from "../components/GroupPicker";
import { Modal } from "../components/Modal";
import { fmt, usd } from "../lib/format";
import { useUsers, type HubUser } from "../lib/users";
import {
  useCreateGroup, useDeleteGroup, useGroups, useRenameGroup, useSetUsersGroup,
  type HubGroup,
} from "../lib/groups";

/** Every team member the Hub has heard from, organized by group, with group management (create/
 *  rename/delete) and single/bulk group assignment. */
export function Team() {
  const usersQuery = useUsers();
  const groupsQuery = useGroups();
  const setUsersGroup = useSetUsersGroup();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTarget, setBulkTarget] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<HubGroup | null>(null);
  const [deleting, setDeleting] = useState<HubGroup | null>(null);

  const toggleSelected = (userId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });

  const applyBulkMove = () => {
    if (!selected.size) return;
    setUsersGroup.mutate(
      { userIds: [...selected], groupId: bulkTarget || null },
      { onSuccess: () => { setSelected(new Set()); setBulkTarget(""); } },
    );
  };

  const isPending = usersQuery.isPending || groupsQuery.isPending;
  const error = (usersQuery.error ?? groupsQuery.error) as Error | undefined;
  const users = usersQuery.data ?? [];
  const groups = groupsQuery.data ?? [];

  return (
    <>
      <div className="page-head">
        <h1>Team</h1>
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
          <Plus size={14} strokeWidth={2.5} aria-hidden /> New group
        </button>
      </div>
      {isPending ? (
        <div className="center-state">Loading…</div>
      ) : error ? (
        <div className="center-state">Couldn't load data: {error.message}</div>
      ) : users.length === 0 ? (
        <p className="muted">No users yet. Run <code>argus sync</code> from a client to ingest data.</p>
      ) : (
        <>
          {selected.size > 0 && (
            <div className="bulk-toolbar">
              <span>{selected.size} selected</span>
              <select
                className="filter-input"
                value={bulkTarget}
                onChange={(e) => setBulkTarget(e.target.value)}
                aria-label="Move selected users to group"
              >
                <option value="">Ungrouped</option>
                {groups.map((g) => (
                  <option key={g.groupId} value={g.groupId}>{g.name}</option>
                ))}
              </select>
              <button type="button" className="btn-primary" onClick={applyBulkMove} disabled={setUsersGroup.isPending}>
                Move
              </button>
              <button type="button" className="btn-secondary" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </div>
          )}
          {buildSections(users, groups).map((section) => (
            <GroupSection
              key={section.id}
              section={section}
              selected={selected}
              onToggle={toggleSelected}
              onRename={section.group ? () => setRenaming(section.group) : undefined}
              onDelete={section.group ? () => setDeleting(section.group) : undefined}
            />
          ))}
        </>
      )}
      {creating && <CreateGroupDialog onClose={() => setCreating(false)} />}
      {renaming && <RenameGroupDialog group={renaming} onClose={() => setRenaming(null)} />}
      {deleting && <DeleteGroupDialog group={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}

// ---- Grouping -----------------------------------------------------------------------------

interface GroupSectionData {
  id: string;
  name: string;
  group: HubGroup | null;
  users: HubUser[];
}

/** Named groups sorted alphabetically, plus a trailing "Ungrouped" bucket for users with no
 *  group_id (omitted only when every group is empty and there's nothing ungrouped either, which
 *  can't happen once users exist, but keeps this honest about what it hides). Users within each
 *  section are sorted alphabetically by display name. */
function buildSections(users: HubUser[], groups: HubGroup[]): GroupSectionData[] {
  const byGroup = new Map<string, HubUser[]>();
  for (const u of users) {
    const key = u.groupId ?? "";
    const list = byGroup.get(key);
    if (list) list.push(u); else byGroup.set(key, [u]);
  }
  const byName = (a: HubUser, b: HubUser) => a.displayName.localeCompare(b.displayName);
  const named = [...groups]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => ({ id: g.groupId, name: g.name, group: g, users: (byGroup.get(g.groupId) ?? []).sort(byName) }));
  const ungrouped = (byGroup.get("") ?? []).sort(byName);
  if (ungrouped.length === 0 && named.length > 0) return named;
  return [...named, { id: "", name: "Ungrouped", group: null, users: ungrouped }];
}

function GroupSection({
  section, selected, onToggle, onRename, onDelete,
}: {
  section: GroupSectionData;
  selected: Set<string>;
  onToggle: (userId: string) => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  return (
    <section className="group-section">
      <div className="group-section-head">
        <h2>
          {section.name} <span className="group-count">{section.users.length}</span>
        </h2>
        {section.group && (
          <div className="group-section-actions">
            <button type="button" className="icon-btn" onClick={onRename} aria-label={`Rename ${section.name}`}>
              <Pencil size={14} strokeWidth={2} aria-hidden />
            </button>
            <button type="button" className="icon-btn" onClick={onDelete} aria-label={`Delete ${section.name}`}>
              <Trash2 size={14} strokeWidth={2} aria-hidden />
            </button>
          </div>
        )}
      </div>
      {section.users.length === 0 ? (
        <p className="muted group-empty">No members.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th className="checkbox-col" aria-hidden />
                <th>User</th>
                <th className="num">Sessions</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
                <th>Last synced</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {section.users.map((u) => (
                <tr key={u.userId}>
                  <td className="checkbox-col">
                    <input
                      type="checkbox"
                      checked={selected.has(u.userId)}
                      onChange={() => onToggle(u.userId)}
                      aria-label={`Select ${u.displayName}`}
                    />
                  </td>
                  <td>
                    <Link to="/users/$userId" params={{ userId: u.userId }} className="table-link">
                      {u.displayName}
                    </Link>
                  </td>
                  <td className="num">{u.sessionCount}</td>
                  <td className="num">{fmt(u.totalTokens)}</td>
                  <td className="num">{usd(u.cost)}</td>
                  <td className="nowrap">{new Date(u.lastSyncMs).toLocaleDateString()}</td>
                  <td>
                    <GroupPicker
                      userId={u.userId}
                      userLabel={u.displayName}
                      groupId={u.groupId}
                      groupName={u.groupName}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---- Group management dialogs -------------------------------------------------------------

function CreateGroupDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const createGroup = useCreateGroup();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createGroup.mutate(name.trim(), { onSuccess: onClose });
  };

  return (
    <Modal title="New group" onClose={onClose}>
      <form className="modal-form" onSubmit={onSubmit}>
        <label className="modal-field">
          <span>Name</span>
          <input
            className="filter-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Engineering"
            autoFocus
          />
        </label>
        {createGroup.isError && <p className="modal-error">{(createGroup.error as Error).message}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={!name.trim() || createGroup.isPending}>
            {createGroup.isPending ? "Creating…" : "Create group"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RenameGroupDialog({ group, onClose }: { group: HubGroup; onClose: () => void }) {
  const [name, setName] = useState(group.name);
  const renameGroup = useRenameGroup();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    renameGroup.mutate({ groupId: group.groupId, name: name.trim() }, { onSuccess: onClose });
  };

  return (
    <Modal title={`Rename "${group.name}"`} onClose={onClose}>
      <form className="modal-form" onSubmit={onSubmit}>
        <label className="modal-field">
          <span>Name</span>
          <input className="filter-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        {renameGroup.isError && <p className="modal-error">{(renameGroup.error as Error).message}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={!name.trim() || renameGroup.isPending}>
            {renameGroup.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteGroupDialog({ group, onClose }: { group: HubGroup; onClose: () => void }) {
  const deleteGroup = useDeleteGroup();

  return (
    <Modal title={`Delete "${group.name}"?`} onClose={onClose}>
      <p className="modal-copy">
        This deletes the group itself, and all members will be ungrouped.
      </p>
      {deleteGroup.isError && <p className="modal-error">{(deleteGroup.error as Error).message}</p>}
      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="btn-danger"
          disabled={deleteGroup.isPending}
          onClick={() => deleteGroup.mutate(group.groupId, { onSuccess: onClose })}
        >
          {deleteGroup.isPending ? "Deleting…" : "Delete group"}
        </button>
      </div>
    </Modal>
  );
}
