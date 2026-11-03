import { technicalQa } from "../qa/technical.ts";
import { StageError, type PipelineContext, type Stage } from "./types.ts";

/** Technical QA on final.mp4 (creative QA arrives in S5). Failing QA fails the run. */
export const evaluationStage: Stage = {
  name: "qa",
  state: "EVALUATING",
  doneState: "FINALIZED",
  async run({ store, runId }: PipelineContext) {
    const technical = await technicalQa(store.artifactPath(runId, "final"));
    await store.writeArtifact(runId, "qa", { technical });
    if (!technical.valid) {
      throw new StageError("qa", `Technical QA failed: ${technical.reasons.join("; ")}`, { reasons: technical.reasons, technical });
    }
  },
};
