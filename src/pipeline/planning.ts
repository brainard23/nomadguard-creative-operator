import type { Brief } from "../brief/schema.ts";
import { buildPrompts } from "../creative/promptBuilder.ts";
import { developStrategy } from "../creative/strategist.ts";
import { writeStoryboard } from "../creative/storyboardWriter.ts";
import type { JobStore } from "../jobs/jobStore.ts";
import type { Job, JobError } from "../jobs/types.ts";
import { LlmOutputError, type LlmClient } from "../llm/types.ts";

export interface PlanningDeps {
  store: JobStore;
  llm: LlmClient;
  brief: Brief;
}

type Stage = "brief" | "strategy" | "storyboard" | "prompts";

/**
 * Planning stage: CREATED -> PLANNING -> PLANNED. Each artifact is written before the
 * state advances. Any error is persisted as FAILED (stage + message + details) and the
 * failed job is returned; this function does not throw for stage errors.
 */
export async function runPlanning({ store, llm, brief }: PlanningDeps): Promise<Job> {
  const created = await store.create();
  const { runId } = created;
  let stage: Stage = "brief";
  try {
    await store.writeArtifact(runId, "brief", brief);
    await store.update(runId, { state: "PLANNING" });

    stage = "strategy";
    const strategy = await developStrategy(llm, brief);
    await store.writeArtifact(runId, "strategy", strategy);

    stage = "storyboard";
    const angle = strategy.angles.find((a) => a.name === strategy.selection.selected_angle);
    if (!angle) throw new Error(`Selected angle "${strategy.selection.selected_angle}" not found.`);
    const { storyboard, adjustments } = await writeStoryboard(llm, brief, angle);
    await store.writeArtifact(runId, "storyboard", storyboard);

    stage = "prompts";
    await store.writeArtifact(runId, "prompts", buildPrompts(storyboard));

    return await store.update(runId, {
      state: "PLANNED",
      notes: adjustments.map((a) => `storyboard normalized: ${a}`),
    });
  } catch (err) {
    return store.update(runId, { state: "FAILED", error: toJobError(stage, err) });
  }
}

function toJobError(stage: string, err: unknown): JobError {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof LlmOutputError) {
    return { stage, message, details: { task: err.task, issues: err.issues, rawOutput: err.rawOutput } };
  }
  const code = (err as { code?: unknown } | null)?.code;
  return { stage, message, details: { type: (err as Error)?.name, ...(code ? { code } : {}) } };
}
