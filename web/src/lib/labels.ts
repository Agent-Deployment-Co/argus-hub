import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface HubLabel {
  labelId: string;
  orgId: string;
  name: string;
  description: string | null;
  createdAt: number;
  taskCount: number;
}

export interface TaskRef {
  clientId: string;
  sessionId: string;
  taskSeq: number;
}

async function readError(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => null) as { error?: string } | null;
  return new Error(body?.error ?? fallback);
}

async function fetchLabels(): Promise<HubLabel[]> {
  const res = await fetch("/api/labels");
  if (!res.ok) throw await readError(res, `Failed to load labels (${res.status})`);
  const body = await res.json() as { labels: HubLabel[] };
  return body.labels;
}

export function useLabels() {
  return useQuery({ queryKey: ["labels"], queryFn: fetchLabels, staleTime: 30_000 });
}

function invalidateLabelsAndTasks(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ["labels"] });
  queryClient.invalidateQueries({ queryKey: ["tasks"] });
}

export function useCreateLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, description }: { name: string; description?: string }) => {
      const res = await fetch("/api/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      if (!res.ok) throw await readError(res, `Failed to create label (${res.status})`);
      return (await res.json() as { label: HubLabel }).label;
    },
    onSuccess: () => invalidateLabelsAndTasks(queryClient),
  });
}

export function useDeleteLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (labelId: string) => {
      const res = await fetch(`/api/labels/${encodeURIComponent(labelId)}`, { method: "DELETE" });
      if (!res.ok) throw await readError(res, `Failed to delete label (${res.status})`);
    },
    onSuccess: () => invalidateLabelsAndTasks(queryClient),
  });
}

/** Apply (applied: true) or remove (applied: false) one label on one task. */
export function useSetTaskLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ labelId, ref, applied }: { labelId: string; ref: TaskRef; applied: boolean }) => {
      const res = await fetch("/api/task-labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelId, ...ref, applied }),
      });
      if (!res.ok) throw await readError(res, `Failed to update task label (${res.status})`);
    },
    onSuccess: () => invalidateLabelsAndTasks(queryClient),
  });
}
