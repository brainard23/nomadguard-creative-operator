import { join } from "node:path";
import { BriefSchema } from "../brief/schema.ts";
import { StoryboardSchema, StrategySchema } from "../creative/schemas.ts";
import { decideCreativeQa, loadCreativeQaThresholds, runCreativeQa } from "../qa/creative.ts";
import { sampleFrames } from "../qa/frames.ts";
import { technicalQa } from "../qa/technical.ts";
import { readArtifact } from "./artifacts.ts";
import { StageError, type PipelineContext, type Stage } from "./types.ts";

/**
 * Evaluation: technical QA (failure fails the run), then creative QA on sampled frames.
 * The stage sets its own terminal state (FINALIZED or NEEDS_REVIEW), so it has no `doneState`.
 */
export const evaluationStage: Stage = {
  name: "qa",
  state: "EVALUATING",
  async run({ store, runId, llm, skipCreativeQa }: PipelineContext) {
    const technical = await technicalQa(store.artifactPath(runId, "final"));
    await store.writeArtifact(runId, "qa", { technical });
    if (!technical.valid) {
      throw new StageError("qa", `Technical QA failed: ${technical.reasons.join("; ")}`, { reasons: technical.reasons, technical });
    }

    if (skipCreativeQa) {
      await store.writeArtifact(runId, "qa", { technical, creative: { skipped: true } });
      await store.update(runId, { state: "FINALIZED", notes: [...(await store.get(runId)).notes, "creative QA skipped (--skip-creative-qa)"] });
      return;
    }

    const storyboard = await readArtifact(store, runId, "storyboard", StoryboardSchema);
    const strategy = await readArtifact(store, runId, "strategy", StrategySchema);
    const brief = await readArtifact(store, runId, "brief", BriefSchema);

    let frames: Awaited<ReturnType<typeof sampleFrames>> = [];
    try {
      frames = await sampleFrames(store.artifactPath(runId, "final"), join(store.runDir(runId), "qa-frames"), storyboard);
      const result = await runCreativeQa(llm, { brief, strategy, storyboard, frames });
      const decision = decideCreativeQa(result.scores, result.weakest_scene_id, loadCreativeQaThresholds());
      await store.writeArtifact(runId, "qa", { technical, creative: { ...result, frames, decision } });
      await store.update(runId, { state: decision.pass ? "FINALIZED" : "NEEDS_REVIEW" });
    } catch (err) {
      // A broken QA call says nothing about the ad: don't fail the run (the video is valid and
      // expensive) and don't finalize it unchecked. NEEDS_REVIEW keeps final.mp4 and hands the call to a human.
      const reason = `creative QA unavailable: ${err instanceof Error ? err.message : String(err)}`;
      await store.writeArtifact(runId, "qa", {
        technical,
        creative: { error: reason, frames, decision: { pass: false, reasons: [reason] } },
      });
      await store.update(runId, { state: "NEEDS_REVIEW" });
    }
  },
};
