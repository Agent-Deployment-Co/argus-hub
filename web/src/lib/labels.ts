import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface HubLabel {
  labelId: string;
  orgId: string;
  name: string;
  description: string | null;
  autoApply: boolean;
  createdAt: number;
  taskCount: number;
}

export interface TaskRef {
  clientId: string;
  sessionId: string;
  taskSeq: number;
}

/** One task from the auto-apply review wizard's preview, with the classifier's verdict. */
export interface LabelPreviewTask extends TaskRef {
  description: string;
  matched: boolean;
  reasoning?: string;
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

export interface CreateLabelInput {
  name: string;
  description?: string;
  autoApply?: boolean;
  taskRefs?: TaskRef[];
}

export function useCreateLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, description, autoApply, taskRefs }: CreateLabelInput) => {
      const res = await fetch("/api/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, autoApply, taskRefs }),
      });
      if (!res.ok) throw await readError(res, `Failed to create label (${res.status})`);
      return (await res.json() as { label: HubLabel }).label;
    },
    onSuccess: () => invalidateLabelsAndTasks(queryClient),
  });
}

export interface UpdateLabelInput {
  labelId: string;
  name?: string;
  description?: string | null;
  autoApply?: boolean;
  taskRefs?: TaskRef[];
}

export function useUpdateLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ labelId, ...fields }: UpdateLabelInput) => {
      const res = await fetch(`/api/labels/${encodeURIComponent(labelId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (!res.ok) throw await readError(res, `Failed to update label (${res.status})`);
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

/** Preview which of the org's last 10 tasks an LLM would match against a candidate label
 *  name/description. No DB writes — backs the "Apply automatically" review wizard. */
export function useLabelPreview() {
  return useMutation({
    mutationFn: async ({ name, description }: { name: string; description?: string }) => {
      const res = await fetch("/api/labels/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      if (!res.ok) throw await readError(res, `Failed to preview label matches (${res.status})`);
      return (await res.json() as { tasks: LabelPreviewTask[] }).tasks;
    },
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
