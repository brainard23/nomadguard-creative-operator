import type { Brief } from "../brief/schema.ts";
import { BriefSchema } from "../brief/schema.ts";
import type { JobStore } from "../jobs/jobStore.ts";
import type { Job } from "../jobs/types.ts";
import type { LlmClient } from "../llm/types.ts";
import { ensureMediaTools } from "../media/preflight.ts";
import type { BackoffPolicy } from "../util/retry.ts";
import type { VideoProvider } from "../video/types.ts";
import { readArtifact } from "./artifacts.ts";
import { assemblyStage } from "./assembly.ts";
import { evaluationStage } from "./evaluation.ts";
import { generationStage } from "./generation.ts";
import { planningStage } from "./planning.ts";
import { InterruptedError, StageError, type PipelineContext, type Stage } from "./types.ts";

export interface PipelineOptions {
  store: JobStore;
  llm: LlmClient;
  brief: Brief;
  /** Omit for a plan-only run. */
  provider?: VideoProvider;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  retry?: Partial<BackoffPolicy>;
  signal?: AbortSignal;
  /** Called as soon as the run id exists (lets the CLI report it if the process is killed). */
  onJobCreated?: (runId: string) => void;
  skipCreativeQa?: boolean;
}

export interface ResumeOptions extends Omit<PipelineOptions, "brief" | "onJobCreated"> {
  runId: string;
}

/** Jobs in these states are done; resume has nothing to do. */
export const TERMINAL_STATES = ["FINALIZED", "NEEDS_REVIEW"] as const;

export function stagesFor(planOnly: boolean): Stage[] {
  return planOnly ? [planningStage] : [planningStage, generationStage, assemblyStage, evaluationStage];
}

function makeContext(options: PipelineOptions | ResumeOptions, runId: string, brief: Brief): PipelineContext {
  return {
    store: options.store,
    runId,
    brief,
    llm: options.llm,
    provider: options.provider,
    pollIntervalMs: options.pollIntervalMs ?? 2000,
    pollTimeoutMs: options.pollTimeoutMs ?? 15 * 60_000,
    retry: options.retry,
    signal: options.signal,
    skipCreativeQa: options.skipCreativeQa,
  };
}

/** Creates a new job and runs the stages. Returns the final job (FAILED jobs are returned, not thrown). */
export async function runPipeline(options: PipelineOptions): Promise<Job> {
  const planOnly = !options.provider;
  if (!planOnly) await ensureMediaTools();
  const job = await options.store.create();
  options.onJobCreated?.(job.runId);
  return runStages(makeContext(options, job.runId, options.brief), stagesFor(planOnly));
}

/**
 * Continues an existing job: finished stages are skipped, a FAILED run restarts at the stage
 * it failed in, and generation re-polls (never resubmits) shots already submitted to the provider.
 * Terminal jobs are returned untouched.
 */
export async function resumePipeline(options: ResumeOptions): Promise<Job> {
  const { store, runId } = options;
  const job = await store.get(runId);
  if ((TERMINAL_STATES as readonly string[]).includes(job.state)) return job;
  const planOnly = !options.provider;
  if (!planOnly) await ensureMediaTools();
  let brief: Brief;
  try {
    brief = await readArtifact(store, runId, "brief", BriefSchema);
  } catch (err) {
    throw new Error(`Cannot resume ${runId}: brief.json is missing or invalid (${(err as Error).message})`);
  }
  return runStages(makeContext(options, runId, brief), stagesFor(planOnly));
}

/**
 * Runs stages against an existing job. Never throws for run errors: anything unexpected
 * (inside or outside a stage) is persisted as FAILED with the failing stage and message.
 */
export async function runStages(ctx: PipelineContext, stages: Stage[]): Promise<Job> {
  const { store, runId } = ctx;
  let current = "pipeline";
  try {
    const job = await store.get(runId);
    const failedStage = job.state === "FAILED" ? job.error?.stage : undefined;
    const failedIndex = failedStage ? stages.findIndex((s) => s.name === failedStage || s.aliases?.includes(failedStage)) : -1;
    if (job.state === "FAILED") {
      await store.update(runId, {
        error: undefined,
        notes: [...job.notes, `resumed after failure in stage "${failedStage}": ${job.error?.message}`],
      });
    }

    for (const [i, stage] of stages.entries()) {
      current = stage.name;
      if (ctx.signal?.aborted) throw new InterruptedError();
      // Stages before the failed one are skipped when their output is present; the failed stage and later ones rerun.
      if ((failedIndex === -1 || i < failedIndex) && stage.isComplete && (await stage.isComplete(ctx))) continue;
      await store.update(runId, { state: stage.state });
      await stage.run(ctx);
      if (stage.doneState) await store.update(runId, { state: stage.doneState });
    }

    const final = await store.get(runId);
    if (final.state === "FAILED") {
      const last = stages[stages.length - 1]!;
      return store.update(runId, { state: last.doneState ?? last.state });
    }
    return final;
  } catch (err) {
    if (err instanceof InterruptedError) {
      const job = await store.get(runId).catch(() => undefined);
      const note = `interrupted during "${current}"; run "resume ${runId}" to continue`;
      return job ? store.update(runId, { notes: [...job.notes, note] }) : Promise.reject(err);
    }
    const stageErr = err instanceof StageError ? err : undefined;
    return store.update(runId, {
      state: "FAILED",
      error: {
        stage: stageErr?.stage ?? current,
        message: err instanceof Error ? err.message : String(err),
        details: stageErr?.details ?? { type: (err as Error)?.name },
      },
    });
  }
}
