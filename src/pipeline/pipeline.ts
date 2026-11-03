import type { Brief } from "../brief/schema.ts";
import type { JobStore } from "../jobs/jobStore.ts";
import type { Job } from "../jobs/types.ts";
import type { LlmClient } from "../llm/types.ts";
import { ensureMediaTools } from "../media/preflight.ts";
import type { VideoProvider } from "../video/types.ts";
import { assemblyStage } from "./assembly.ts";
import { evaluationStage } from "./evaluation.ts";
import { generationStage } from "./generation.ts";
import { planningStage } from "./planning.ts";
import { StageError, type PipelineContext, type Stage } from "./types.ts";

export interface PipelineOptions {
  store: JobStore;
  llm: LlmClient;
  brief: Brief;
  /** Omit for a plan-only run. */
  provider?: VideoProvider;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export function stagesFor(planOnly: boolean): Stage[] {
  return planOnly ? [planningStage] : [planningStage, generationStage, assemblyStage, evaluationStage];
}

/** Creates a new job and runs the stages. Returns the final job (FAILED jobs are returned, not thrown). */
export async function runPipeline(options: PipelineOptions): Promise<Job> {
  const planOnly = !options.provider;
  if (!planOnly) await ensureMediaTools();
  const job = await options.store.create();
  const ctx: PipelineContext = {
    store: options.store,
    runId: job.runId,
    brief: options.brief,
    llm: options.llm,
    provider: options.provider,
    pollIntervalMs: options.pollIntervalMs ?? 2000,
    pollTimeoutMs: options.pollTimeoutMs ?? 15 * 60_000,
  };
  return runStages(ctx, stagesFor(planOnly));
}

/** Runs stages against an existing job (the entry point resume will reuse). */
export async function runStages(ctx: PipelineContext, stages: Stage[]): Promise<Job> {
  const { store, runId } = ctx;
  let current = "pipeline";
  try {
    for (const stage of stages) {
      current = stage.name;
      await store.update(runId, { state: stage.state });
      await stage.run(ctx);
      if (stage.doneState) await store.update(runId, { state: stage.doneState });
    }
    return await store.get(runId);
  } catch (err) {
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
