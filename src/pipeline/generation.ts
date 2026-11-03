import { join, relative } from "node:path";
import { z } from "zod";
import { readArtifact } from "./artifacts.ts";
import { StageError, type PipelineContext, type Stage } from "./types.ts";

const PromptsFileSchema = z.object({
  shots: z.array(
    z.object({ scene_id: z.string(), duration: z.number(), prompt: z.string(), negative_prompt: z.string() }),
  ),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Generation: submit every shot to the provider, poll until done, record per-shot state in job.json. */
export const generationStage: Stage = {
  name: "generation",
  state: "GENERATING",
  async run(ctx: PipelineContext) {
    const { store, runId, provider } = ctx;
    if (!provider) throw new StageError("generation", "No video provider configured.");
    const { shots } = await readArtifact(store, runId, "prompts", PromptsFileSchema);
    const outputDir = join(store.runDir(runId), "clips");

    for (const shot of shots) await store.updateShot(runId, shot.scene_id, { state: "PENDING", attempts: 0 });

    const results = await Promise.allSettled(
      shots.map(async (shot) => {
        const id = shot.scene_id;
        try {
          const { providerJobId } = await provider.generate({
            sceneId: id,
            prompt: shot.prompt,
            negativePrompt: shot.negative_prompt,
            durationSeconds: shot.duration,
            aspectRatio: "9:16",
            outputDir,
          });
          await store.updateShot(runId, id, { state: "SUBMITTED", providerJobId, attempts: 1 });

          const deadline = Date.now() + ctx.pollTimeoutMs;
          let running = false;
          for (;;) {
            const status = await provider.getStatus(providerJobId);
            if (status.state === "succeeded") break;
            if (status.state === "failed") {
              const error = status.error ?? { message: "Provider reported failure", retryable: false };
              await store.updateShot(runId, id, { state: "FAILED", error });
              throw new StageError("generation", `Shot ${id} failed: ${error.message}`, { sceneId: id, providerJobId, ...error });
            }
            if (!running) {
              running = true;
              await store.updateShot(runId, id, { state: "RUNNING" });
            }
            if (Date.now() > deadline) {
              const error = { message: `Timed out waiting for provider after ${ctx.pollTimeoutMs}ms`, retryable: true, code: "POLL_TIMEOUT" };
              await store.updateShot(runId, id, { state: "FAILED", error });
              throw new StageError("generation", `Shot ${id} failed: ${error.message}`, { sceneId: id, providerJobId, ...error });
            }
            await sleep(ctx.pollIntervalMs);
          }
          const { clipPath } = await provider.getResult(providerJobId);
          await store.updateShot(runId, id, { state: "SUCCEEDED", clipPath: relative(store.runDir(runId), clipPath) });
        } catch (err) {
          if (err instanceof StageError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          await store.updateShot(runId, id, { state: "FAILED", error: { message } });
          throw new StageError("generation", `Shot ${id} failed: ${message}`, { sceneId: id }, { cause: err });
        }
      }),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  },
};
