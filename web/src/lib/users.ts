import { useQuery } from "@tanstack/react-query";

export interface HubUser {
  userId: string;
  displayName: string;
  email: string | null;
  lastSyncMs: number;
  sessionCount: number;
  clientCount: number;
  groupId: string | null;
  groupName: string | null;
  totalTokens: number;
  cost: number;
}

async function fetchUsers(): Promise<HubUser[]> {
  const res = await fetch("/api/users");
  if (!res.ok) throw new Error(`Failed to load users (${res.status})`);
  const body = await res.json() as { users: HubUser[] };
  return body.users;
}

export function useUsers() {
  return useQuery({ queryKey: ["users"], queryFn: fetchUsers, staleTime: 30_000 });
}

export interface UserInfo { userId: string; email: string; orgId: string; orgName: string; displayName: string }

async function fetchUserInfo(userId: string): Promise<UserInfo> {
  const res = await fetch(`/api/user/${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error(`Failed to load user (${res.status})`);
  return res.json();
}

export function useUserInfo(userId: string, enabled = true) {
  return useQuery({ queryKey: ["user-info", userId], queryFn: () => fetchUserInfo(userId), staleTime: 60_000, enabled });
}
