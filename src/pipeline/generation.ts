import { access } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import type { Shot } from "../jobs/types.ts";
import { DEFAULT_RETRY_POLICY, retry, type BackoffPolicy } from "../util/retry.ts";
import { VideoProviderError, type VideoJobError } from "../video/types.ts";
import { readArtifact } from "./artifacts.ts";
import { InterruptedError, StageError, type PipelineContext, type Stage } from "./types.ts";

const PromptsFileSchema = z.object({
  shots: z.array(
    z.object({ scene_id: z.string(), duration: z.number(), prompt: z.string(), negative_prompt: z.string() }),
  ),
});

type PromptShot = z.infer<typeof PromptsFileSchema>["shots"][number];

/** One failed attempt at producing a clip, classified as transient (retry) or permanent. */
class ShotAttemptError extends Error {
  override name = "ShotAttemptError";
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code?: string,
  ) {
    super(message);
  }
}

// Only provider-declared transient errors are retried; any other thrown error is a bug or permanent.
const isTransient = (err: unknown) => err instanceof VideoProviderError && err.retryable;

function toAttemptError(err: unknown): ShotAttemptError {
  if (err instanceof ShotAttemptError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  return new ShotAttemptError(err instanceof Error ? err.message : String(err), err instanceof VideoProviderError && err.retryable, code === undefined ? undefined : String(code));
}

const fromProvider = (e: VideoJobError) => new ShotAttemptError(e.message, e.retryable, e.code);

/** Sleep that rejects with InterruptedError when the run is aborted. */
function abortableSleep(signal?: AbortSignal) {
  return (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new InterruptedError());
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new InterruptedError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
}

const exists = (p: string) => access(p).then(() => true, () => false);

async function loadPrompts(ctx: PipelineContext): Promise<PromptShot[]> {
  return (await readArtifact(ctx.store, ctx.runId, "prompts", PromptsFileSchema)).shots;
}

/**
 * Generation: for every shot, submit to the provider, poll until done and record per-shot state.
 *  - SUCCEEDED shots (clip on disk) are skipped.
 *  - SUBMITTED/RUNNING shots with a providerJobId are re-polled, never resubmitted.
 *  - Retryable failures resubmit with backoff up to maxAttempts; permanent failures stop that shot.
 *  - A failed shot never stops the others: all shots settle (and are saved) before the stage fails.
 */
export const generationStage: Stage = {
  name: "generation",
  state: "GENERATING",

  async isComplete(ctx) {
    const [shots, job] = [await loadPrompts(ctx), await ctx.store.get(ctx.runId)];
    if (shots.length === 0) return false;
    for (const p of shots) {
      const s = job.shots.find((x) => x.sceneId === p.scene_id);
      if (s?.state !== "SUCCEEDED" || !s.clipPath || !(await exists(join(ctx.store.runDir(ctx.runId), s.clipPath)))) return false;
    }
    return true;
  },

  async run(ctx: PipelineContext) {
    const { store, runId } = ctx;
    if (!ctx.provider) throw new StageError("generation", "No video provider configured.");
    const shots = await loadPrompts(ctx);
    const job = await store.get(runId);

    const existing = new Map<string, Shot>();
    for (const s of job.shots) existing.set(s.sceneId, s);
    for (const shot of shots) {
      if (!existing.has(shot.scene_id)) await store.updateShot(runId, shot.scene_id, { state: "PENDING", attempts: 0 });
    }

    const results = await Promise.allSettled(shots.map((shot) => runShot(ctx, shot, existing.get(shot.scene_id))));
    const rejections = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
    const interrupted = rejections.find((e) => e instanceof InterruptedError);
    if (interrupted) throw interrupted;
    if (rejections[0]) throw rejections[0];
  },
};

async function runShot(ctx: PipelineContext, shot: PromptShot, prior: Shot | undefined): Promise<void> {
  const { store, runId } = ctx;
  const provider = ctx.provider!;
  const id = shot.scene_id;
  const clipOk = prior?.clipPath ? await exists(join(store.runDir(runId), prior.clipPath)) : false;
  if (prior?.state === "SUCCEEDED" && clipOk) return;

  // A FAILED shot (or one whose clip vanished) gets a fresh attempt budget on resume.
  let attempts = prior && prior.state !== "FAILED" && prior.state !== "SUCCEEDED" ? prior.attempts : 0;
  let resumeJobId = prior && (prior.state === "SUBMITTED" || prior.state === "RUNNING") ? prior.providerJobId : undefined;

  const policy: BackoffPolicy = { ...DEFAULT_RETRY_POLICY, ...ctx.retry, sleep: ctx.retry?.sleep ?? abortableSleep(ctx.signal) };
  const aborted = () => {
    if (ctx.signal?.aborted) throw new InterruptedError();
  };

  const clipsDir = join(store.runDir(runId), "clips");

  const attempt = async () => {
    aborted();
    try {
      let providerJobId = resumeJobId;
      resumeJobId = undefined;
      if (!providerJobId) {
        attempts += 1;
        await store.updateShot(runId, id, { state: "PENDING", attempts, providerJobId: undefined, clipPath: undefined });
        providerJobId = (
          await provider.generate({
            sceneId: id,
            prompt: shot.prompt,
            negativePrompt: shot.negative_prompt,
            durationSeconds: shot.duration,
            aspectRatio: "9:16",
            outputDir: clipsDir,
          })
        ).providerJobId;
        await store.updateShot(runId, id, { state: "SUBMITTED", providerJobId });
      }
      await pollUntilDone(ctx, id, providerJobId, policy);
      const { clipPath } = await provider.getResult(providerJobId, { sceneId: id, outputDir: clipsDir });
      await store.updateShot(runId, id, { state: "SUCCEEDED", clipPath: relative(store.runDir(runId), clipPath) });
    } catch (err) {
      if (err instanceof InterruptedError) throw err;
      throw toAttemptError(err);
    }
  };

  try {
    await retry(attempt, {
      ...policy,
      isRetryable: (e) => e instanceof ShotAttemptError && e.retryable,
      onRetry: (e) => {
        const err = e as ShotAttemptError;
        return void store.updateShot(runId, id, { state: "PENDING", error: { message: err.message, retryable: true, code: err.code } });
      },
    });
  } catch (err) {
    if (err instanceof InterruptedError) throw err;
    const e = toAttemptError(err);
    const error = { message: e.message, retryable: e.retryable, code: e.code };
    const final = await store.updateShot(runId, id, { state: "FAILED", error });
    const providerJobId = final.shots.find((s) => s.sceneId === id)?.providerJobId;
    throw new StageError(
      "generation",
      `Shot ${id} failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${e.message}`,
      { sceneId: id, attempts, providerJobId, ...error },
      { cause: err },
    );
  }
}

/** Polls one provider job to completion. Transient getStatus errors are retried in place (no resubmit). */
async function pollUntilDone(ctx: PipelineContext, sceneId: string, providerJobId: string, policy: BackoffPolicy): Promise<void> {
  const provider = ctx.provider!;
  const deadline = Date.now() + ctx.pollTimeoutMs;
  const wait = abortableSleep(ctx.signal);
  let marked = false;
  for (;;) {
    if (ctx.signal?.aborted) throw new InterruptedError();
    const status = await retry(() => provider.getStatus(providerJobId), { ...policy, isRetryable: isTransient });
    if (status.state === "succeeded") return;
    if (status.state === "failed") {
      throw fromProvider(status.error ?? { message: "Provider reported failure without a reason", retryable: false });
    }
    if (!marked) {
      marked = true;
      await ctx.store.updateShot(ctx.runId, sceneId, { state: "RUNNING" });
    }
    if (Date.now() > deadline) {
      throw new ShotAttemptError(`Timed out waiting for provider after ${ctx.pollTimeoutMs}ms`, true, "POLL_TIMEOUT");
    }
    await wait(ctx.pollIntervalMs);
  }
}
