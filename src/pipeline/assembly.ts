import { join } from "node:path";
import { assemble } from "../assembly/assembler.ts";
import { StoryboardSchema } from "../creative/schemas.ts";
import { readArtifact } from "./artifacts.ts";
import { StageError, type PipelineContext, type Stage } from "./types.ts";

export const assemblyStage: Stage = {
  name: "assembly",
  state: "ASSEMBLING",
  async run({ store, runId, brief }: PipelineContext) {
    const job = await store.get(runId);
    const storyboard = await readArtifact(store, runId, "storyboard", StoryboardSchema);
    const runDir = store.runDir(runId);

    // Assemble in storyboard order, not completion order.
    const clips = storyboard.scenes.map((scene) => {
      const shot = job.shots.find((s) => s.sceneId === scene.id);
      if (shot?.state !== "SUCCEEDED" || !shot.clipPath) {
        throw new StageError("assembly", `Shot ${scene.id} has no finished clip.`, { sceneId: scene.id });
      }
      return join(runDir, shot.clipPath);
    });

    try {
      await assemble({
        clips,
        endCard: { ...storyboard.end_card, brand: brief.brand },
        workDir: runDir,
        output: store.artifactPath(runId, "final"),
      });
    } catch (err) {
      throw new StageError("assembly", err instanceof Error ? err.message : String(err), undefined, { cause: err });
    }
    await store.registerArtifact(runId, "final");
  },
};

