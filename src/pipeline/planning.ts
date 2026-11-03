import { buildPrompts } from "../creative/promptBuilder.ts";
import { developStrategy } from "../creative/strategist.ts";
import { writeStoryboard } from "../creative/storyboardWriter.ts";
import { LlmOutputError } from "../llm/types.ts";
import { StageError, type PipelineContext, type Stage } from "./types.ts";

/** Planning: brief, strategy, storyboard, prompts. Each artifact is written before the next step. */
export const planningStage: Stage = {
  name: "planning",
  state: "PLANNING",
  doneState: "PLANNED",
  async run({ store, runId, brief, llm }: PipelineContext) {
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof StageError) throw err;
        const details =
          err instanceof LlmOutputError
            ? { task: err.task, issues: err.issues, rawOutput: err.rawOutput }
            : { type: (err as Error)?.name, ...(codeOf(err) ? { code: codeOf(err) } : {}) };
        throw new StageError(name, err instanceof Error ? err.message : String(err), details, { cause: err });
      }
    };

    await step("brief", () => store.writeArtifact(runId, "brief", brief));

    const strategy = await step("strategy", async () => {
      const s = await developStrategy(llm, brief);
      await store.writeArtifact(runId, "strategy", s);
      return s;
    });

    const { storyboard, adjustments } = await step("storyboard", async () => {
      const angle = strategy.angles.find((a) => a.name === strategy.selection.selected_angle);
      if (!angle) throw new Error(`Selected angle "${strategy.selection.selected_angle}" not found.`);
      const result = await writeStoryboard(llm, brief, angle);
      await store.writeArtifact(runId, "storyboard", result.storyboard);
      return result;
    });

    await step("prompts", () => store.writeArtifact(runId, "prompts", buildPrompts(storyboard)));
    await store.update(runId, { notes: adjustments.map((a) => `storyboard normalized: ${a}`) });
  },
};

function codeOf(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}
