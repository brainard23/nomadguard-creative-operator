import type { Brief } from "../brief/schema.ts";
import type { JobStore } from "../jobs/jobStore.ts";
import type { JobState } from "../jobs/types.ts";
import type { LlmClient } from "../llm/types.ts";
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
  /** Skip creative (vision) QA; technical QA still runs. */
  skipCreativeQa?: boolean;
}

/** A pipeline stage: `state` is set while it runs, `doneState` (optional) once it completes. */
export interface Stage {
  name: string;
  state: JobState;
  doneState?: JobState;
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
