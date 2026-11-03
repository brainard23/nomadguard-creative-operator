import { rm } from "node:fs/promises";
import { join } from "node:path";
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
import { AwaitingInputError, InterruptedError, StageError, type PipelineContext, type Stage } from "./types.ts";

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
  /** Scene ids whose shot is regenerated/re-imported; assembly and QA rerun. Works on finished runs too. */
  redo?: string[];
  /** Keep every shot and rerun only assembly + QA (e.g. after editing storyboard overlay/trimStart). */
  reassemble?: boolean;
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

/** Notes written when a run parks in AWAITING_CLIPS; stale once it moves on. */
const AWAITING_NOTE = /^awaiting clips for /;

/**
 * Prepares a finished (or failed) run for `--redo` / `--reassemble`: resets the named shots to
 * PENDING and deletes their imported clips, drops final.mp4 + qa.json, and parks the job at PLANNED
 * so the stages rerun (generation skips untouched shots, assembly and QA always run).
 */
export async function prepareRerun(store: JobStore, runId: string, redo: string[], reassemble: boolean): Promise<Job> {
  const job = await store.get(runId);
  const unknown = redo.filter((id) => !job.shots.some((s) => s.sceneId === id));
  if (unknown.length) {
    throw new Error(`Cannot redo ${unknown.join(", ")}: run ${runId} has no such shot (shots: ${job.shots.map((s) => s.sceneId).join(", ") || "none"}).`);
  }
  for (const id of redo) {
    const shot = job.shots.find((s) => s.sceneId === id)!;
    if (shot.clipPath) await rm(join(store.runDir(runId), shot.clipPath), { force: true });
    await store.updateShot(runId, id, { state: "PENDING", attempts: 0, providerJobId: undefined, clipPath: undefined, error: undefined });
  }
  await rm(store.artifactPath(runId, "final"), { force: true });
  await rm(store.artifactPath(runId, "qa"), { force: true });
  const { final: _final, qa: _qa, ...artifacts } = (await store.get(runId)).artifacts;
  const what = [redo.length ? `redo ${redo.join(", ")}` : "", reassemble ? "reassemble" : ""].filter(Boolean).join(" + ");
  return store.update(runId, {
    state: "PLANNED",
    error: undefined,
    artifacts,
    notes: [...(await store.get(runId)).notes, `${what}: assembly and QA will rerun`],
  });
}

/**
 * Continues an existing job: finished stages are skipped, a FAILED run restarts at the stage
 * it failed in, and generation re-polls (never resubmits) shots already submitted to the provider.
 * Terminal jobs are returned untouched.
 */
export async function resumePipeline(options: ResumeOptions): Promise<Job> {
  const { store, runId } = options;
  const job = await store.get(runId);
  const rerun = (options.redo?.length ?? 0) > 0 || options.reassemble === true;
  if (!rerun && (TERMINAL_STATES as readonly string[]).includes(job.state)) return job;
  const planOnly = !options.provider;
  if (!planOnly) await ensureMediaTools();
  let brief: Brief;
  try {
    brief = await readArtifact(store, runId, "brief", BriefSchema);
  } catch (err) {
    throw new Error(`Cannot resume ${runId}: brief.json is missing or invalid (${(err as Error).message})`);
  }
  if (rerun) await prepareRerun(store, runId, options.redo ?? [], options.reassemble === true);
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
    let job = await store.get(runId);
    // Leaving AWAITING_CLIPS: its "awaiting clips for ..." notes are stale (generation re-adds one if it pauses again).
    if (job.notes.some((n) => AWAITING_NOTE.test(n))) {
      job = await store.update(runId, { notes: job.notes.filter((n) => !AWAITING_NOTE.test(n)) });
    }
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
    if (err instanceof AwaitingInputError) {
      const job = await store.get(runId);
      return store.update(runId, {
        state: "AWAITING_CLIPS",
        notes: [...job.notes, `awaiting clips for ${err.sceneIds.join(", ")}: ${err.message}`],
      });
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
