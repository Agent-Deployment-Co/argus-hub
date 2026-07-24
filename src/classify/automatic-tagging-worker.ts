import type { SecretCipher } from "../secrets.ts";
import type { AutomaticTaggingJob, HubStore } from "../store/hub-store.ts";
import type { ExecuteCommand } from "../llm/index.ts";
import { resolveTaskLlmConfig, sanitizeLlmError } from "../llm/resolve.ts";
import { createProviderClassifier, searchCandidates } from "./task-labeler.ts";

export interface AutomaticTaggingWorkerOptions {
  secretCipher?: SecretCipher;
  fetch?: typeof fetch;
  executeCommand?: ExecuteCommand;
  timeoutMs?: number;
  batchSize?: number;
  pollIntervalMs?: number;
}

export class AutomaticTaggingWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly store: HubStore,
    private readonly options: AutomaticTaggingWorkerOptions = {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.wake();
  }

  wake(): void {
    if (this.stopped || this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.runOneCycle()
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          this.running = undefined;
          if (!this.stopped) this.schedulePoll();
        });
    }, 0);
  }

  private schedulePoll(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.wake();
    }, this.options.pollIntervalMs ?? 5_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async runOneCycle(now = Date.now()): Promise<number> {
    const jobs = await this.store.claimAutomaticTaggingJobs(now, this.options.batchSize ?? 20);
    const byOrg = new Map<string, AutomaticTaggingJob[]>();
    for (const job of jobs) {
      const list = byOrg.get(job.orgId);
      if (list) list.push(job); else byOrg.set(job.orgId, [job]);
    }
    for (const [orgId, orgJobs] of byOrg) {
      await this.processOrg(orgId, orgJobs, now);
    }
    return jobs.length;
  }

  private async processOrg(orgId: string, jobs: AutomaticTaggingJob[], now: number): Promise<void> {
    const settings = await this.store.readTaskLlmSettings(orgId);
    if (!settings.automaticTaggingEnabled) {
      await this.store.releaseAutomaticTaggingJobs(jobs, now);
      return;
    }
    const labels = (await this.store.listLabels(orgId)).filter((label) => label.kind === "auto");
    if (!labels.length) {
      await this.store.completeAutomaticTaggingJobs(jobs.map((job) => job.jobId), now);
      return;
    }
    let config;
    try {
      config = await resolveTaskLlmConfig(this.store, orgId, this.options.secretCipher);
    } catch {
      await this.store.releaseAutomaticTaggingJobs(jobs, now);
      return;
    }
    try {
      const classifier = createProviderClassifier(
        config,
        { fetch: this.options.fetch, executeCommand: this.options.executeCommand },
        this.options.timeoutMs,
      );
      const tasks = jobs.map((job) => ({
        ref: job.jobId,
        description: job.description,
        ...(job.outcome ? { outcome: job.outcome } : {}),
      }));
      const byId = new Map(jobs.map((job) => [job.jobId, job]));
      for (const label of labels) {
        const results = await searchCandidates(label.name, label.description ?? "", tasks, classifier);
        const matches = results
          .filter((result) => result.match)
          .map((result) => byId.get(result.ref))
          .filter((job): job is AutomaticTaggingJob => job !== undefined);
        await this.store.applyLabelToTasks(orgId, label.labelId, matches, "auto", now);
      }
      await this.store.completeAutomaticTaggingJobs(jobs.map((job) => job.jobId), now);
    } catch (error) {
      const safe = sanitizeLlmError(
        error instanceof Error ? error.message : undefined,
        undefined,
        config.provider,
        config.apiKey,
      );
      await this.store.failAutomaticTaggingJobs(jobs, safe, now);
    } finally {
      config.apiKey = undefined;
    }
  }
}
