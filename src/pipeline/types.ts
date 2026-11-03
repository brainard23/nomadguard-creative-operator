import type { Brief } from "../brief/schema.ts";
import type { JobStore } from "../jobs/jobStore.ts";
import type { JobState } from "../jobs/types.ts";
import type { LlmClient } from "../llm/types.ts";
import type { BackoffPolicy } from "../util/retry.ts";
import type { VideoProvider } from "../video/types.ts";

export interface PipelineContext {
  store: JobStore;
  runId: string;
  brief: Brief;
  llm: LlmClient;
  /** Absent for plan-only runs. */
  provider?: VideoProvider;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  /** Backoff / max attempts for provider calls and shot resubmission. */
  retry?: Partial<BackoffPolicy>;
  /** Aborted on SIGINT: stages stop at the next safe point and the job keeps its state. */
  signal?: AbortSignal;
  /** Skip creative (vision) QA; technical QA still runs. */
  skipCreativeQa?: boolean;
}

/** A pipeline stage: `state` is set while it runs, `doneState` (optional) once it completes. */
export interface Stage {
  name: string;
  state: JobState;
  doneState?: JobState;
  /** Extra stage names (as recorded in job.error.stage) that belong to this stage. */
  aliases?: string[];
  /** True when this stage's output is already present, so resume can skip it. */
  isComplete?(ctx: PipelineContext): Promise<boolean>;
  run(ctx: PipelineContext): Promise<void>;
}

/** Carries the failing stage (and optional details) up to the runner, which persists FAILED. */
export class StageError extends Error {
  override name = "StageError";
  constructor(
    readonly stage: string,
    message: string,
    readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Thrown when the run is aborted (SIGINT). The job keeps its state so `resume` can continue. */
export class InterruptedError extends Error {
  override name = "InterruptedError";
  constructor(message = "Run interrupted") {
    super(message);
  }
}

/**
 * Thrown (by generation) when shots wait on external input, e.g. clips a human must add to the inbox.
 * The runner parks the job as AWAITING_CLIPS instead of failing it; `resume` continues.
 */
export class AwaitingInputError extends Error {
  override name = "AwaitingInputError";
  constructor(
    readonly sceneIds: string[],
    message: string,
  ) {
    super(message);
  }
}
