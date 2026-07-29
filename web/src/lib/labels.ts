import { useCallback, useRef, useState } from "react";
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

/** One row of the auto-apply review wizard's preview table. `pending` is true until the
 *  classifier's verdict for this task has arrived. */
export interface LabelPreviewRow extends LabelPreviewTask {
  pending: boolean;
}

type PreviewLine =
  | { type: "tasks"; tasks: LabelPreviewTask[] }
  | { type: "result"; clientId: string; sessionId: string; taskSeq: number; matched: boolean; reasoning?: string }
  | { type: "error"; error: string };

function previewRowKey(ref: TaskRef): string {
  return `${ref.clientId}:${ref.sessionId}:${ref.taskSeq}`;
}

/** Streams which of the org's last 10 tasks an LLM would match against a candidate label
 *  name/description. No DB writes — backs the "Apply automatically" review wizard. The task
 *  table populates immediately (all rows `pending: true`), then each row's verdict fills in as
 *  its classification completes, since POST /api/labels/preview streams newline-delimited JSON
 *  rather than waiting for every task to finish. */
export function useLabelPreviewStream(): {
  tasks: LabelPreviewRow[] | null;
  isPending: boolean;
  error: Error | null;
  run: (input: { name: string; description?: string }) => void;
} {
  const [tasks, setTasks] = useState<LabelPreviewRow[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isPending, setIsPending] = useState(false);
  const runId = useRef(0);

  const run = useCallback((input: { name: string; description?: string }) => {
    const thisRun = ++runId.current;
    setTasks(null);
    setError(null);
    setIsPending(true);

    const handleLine = (line: string) => {
      if (!line.trim() || thisRun !== runId.current) return;
      const msg = JSON.parse(line) as PreviewLine;
      if (msg.type === "tasks") {
        setTasks(msg.tasks.map((t) => ({ ...t, matched: false, reasoning: undefined, pending: true })));
      } else if (msg.type === "result") {
        const key = previewRowKey(msg);
        setTasks((prev) => prev?.map((t) => (
          previewRowKey(t) === key ? { ...t, matched: msg.matched, reasoning: msg.reasoning, pending: false } : t
        )) ?? prev);
      } else {
        setError(new Error(msg.error));
      }
    };

    (async () => {
      try {
        const res = await fetch("/api/labels/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!res.ok || !res.body) throw await readError(res, `Failed to preview label matches (${res.status})`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) handleLine(line);
        }
        handleLine(buffer);
      } catch (err) {
        if (thisRun === runId.current) setError(err instanceof Error ? err : new Error("Failed to preview label matches"));
      } finally {
        if (thisRun === runId.current) setIsPending(false);
      }
    })();
  }, []);

  return { tasks, isPending, error, run };
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
