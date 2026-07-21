import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface HubGroup {
  groupId: string;
  orgId: string;
  name: string;
  createdAt: number;
  memberCount: number;
}

async function readError(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => null) as { error?: string } | null;
  return new Error(body?.error ?? fallback);
}

async function fetchGroups(): Promise<HubGroup[]> {
  const res = await fetch("/api/groups");
  if (!res.ok) throw await readError(res, `Failed to load groups (${res.status})`);
  const body = await res.json() as { groups: HubGroup[] };
  return body.groups;
}

export function useGroups() {
  return useQuery({ queryKey: ["groups"], queryFn: fetchGroups, staleTime: 30_000 });
}

/** Invalidated by every mutation below: creating/renaming/deleting a group, or moving users in
 *  or out of one, changes both the group list (memberCount) and the user roster (groupId/Name). */
function invalidateGroupsAndUsers(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ["groups"] });
  queryClient.invalidateQueries({ queryKey: ["users"] });
}

export function useCreateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw await readError(res, `Failed to create group (${res.status})`);
      return (await res.json() as { group: HubGroup }).group;
    },
    onSuccess: () => invalidateGroupsAndUsers(queryClient),
  });
}

export function useRenameGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ groupId, name }: { groupId: string; name: string }) => {
      const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw await readError(res, `Failed to rename group (${res.status})`);
    },
    onSuccess: () => invalidateGroupsAndUsers(queryClient),
  });
}

export function useDeleteGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (groupId: string) => {
      const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
      if (!res.ok) throw await readError(res, `Failed to delete group (${res.status})`);
    },
    onSuccess: () => invalidateGroupsAndUsers(queryClient),
  });
}

/** Set (or clear, with `groupId: null`) a single user's group. */
export function useSetUserGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, groupId }: { userId: string; groupId: string | null }) => {
      const res = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId }),
      });
      if (!res.ok) throw await readError(res, `Failed to update user (${res.status})`);
    },
    onSuccess: () => invalidateGroupsAndUsers(queryClient),
  });
}

/** Bulk-assign (or clear, with `groupId: null`) many users' group at once. The DELETE route
 *  ungroups by userId alone (it doesn't need to know which group a user was in), so the path
 *  segment is a placeholder for that case — only the POST (add) path validates it. */
export function useSetUsersGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userIds, groupId }: { userIds: string[]; groupId: string | null }) => {
      const res = await fetch(`/api/groups/${encodeURIComponent(groupId ?? "_")}/members`, {
        method: groupId ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds }),
      });
      if (!res.ok) throw await readError(res, `Failed to update group membership (${res.status})`);
    },
    onSuccess: () => invalidateGroupsAndUsers(queryClient),
  });
}
