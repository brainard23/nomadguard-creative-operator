import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ffmpeg } from "../media/exec.ts";
import { renderLabelPng } from "../media/textImage.ts";
import { VideoProviderError, type GenerateRequest, type ResultTarget, type VideoJobError, type VideoJobStatus, type VideoProvider } from "./types.ts";

/**
 * One scripted outcome per submission of a scene (first generate call uses index 0, ...).
 * Past the end of the sequence, submissions succeed.
 *  - "ok"         renders normally
 *  - "transient"  status "failed", retryable (like a 503 / rate limit)
 *  - "permanent"  status "failed", not retryable (like a safety-filter rejection)
 *  - "network"    getStatus throws a retryable VideoProviderError (like an HTTP 503)
 *  - object       status "failed" with exactly that error
 */
export type MockStep = "ok" | "transient" | "permanent" | "network" | VideoJobError;

export interface MockProviderOptions {
  /** Polls that report "running" before the job completes. Default 1; a map sets it per scene. */
  pollsBeforeDone?: number | Record<string, number>;
  /** Failure injection: sceneId -> scripted outcomes per submission. */
  failures?: Record<string, MockStep[]>;
}

const TRANSIENT: VideoJobError = { message: "mock transient failure (503 service unavailable)", retryable: true, code: "MOCK_TRANSIENT" };
const PERMANENT: VideoJobError = { message: "mock permanent failure: prompt rejected by safety filter", retryable: false, code: "MOCK_SAFETY" };

interface MockJob {
  req: GenerateRequest;
  step: MockStep;
  polls: number;
  render: Promise<void>;
}

/**
 * Offline provider: renders a real 1080x1920 clip with audio via ffmpeg.
 * Job state lives in memory, so a job id from another process/instance is reported as
 * a retryable UNKNOWN_JOB failure (the workflow then resubmits).
 */
export class MockVideoProvider implements VideoProvider {
  private readonly jobs = new Map<string, MockJob>();
  private readonly submissions = new Map<string, number>();
  private readonly pollsBeforeDone: number | Record<string, number>;
  private readonly failures: Record<string, MockStep[]>;

  constructor(options: MockProviderOptions = {}) {
    this.pollsBeforeDone = options.pollsBeforeDone ?? 1;
    this.failures = options.failures ?? {};
  }

  async generate(req: GenerateRequest): Promise<{ providerJobId: string }> {
    const n = this.submissions.get(req.sceneId) ?? 0;
    this.submissions.set(req.sceneId, n + 1);
    const step = this.failures[req.sceneId]?.[n] ?? "ok";
    const providerJobId = `mock-${req.sceneId}-${n + 1}-${randomBytes(3).toString("hex")}`;
    const clipPath = join(req.outputDir, `${req.sceneId}.mp4`);
    const render = step === "ok" ? renderClip(req, clipPath) : Promise.resolve();
    render.catch(() => undefined); // surfaced through getStatus, avoid unhandled rejection
    this.jobs.set(providerJobId, { req, step, polls: 0, render });
    return { providerJobId };
  }

  async getStatus(providerJobId: string): Promise<VideoJobStatus> {
    const job = this.jobs.get(providerJobId);
    if (!job) {
      return { state: "failed", error: { message: `mock provider has no record of job ${providerJobId}`, retryable: true, code: "UNKNOWN_JOB" } };
    }
    job.polls += 1;
    const before =
      typeof this.pollsBeforeDone === "number" ? this.pollsBeforeDone : (this.pollsBeforeDone[job.req.sceneId] ?? 1);
    if (job.polls <= before) return { state: job.polls === 1 ? "pending" : "running" };
    if (job.step === "network") {
      throw new VideoProviderError("503 Service Unavailable", { retryable: true, code: "HTTP_503" });
    }
    if (job.step === "transient") return { state: "failed", error: TRANSIENT };
    if (job.step === "permanent") return { state: "failed", error: PERMANENT };
    if (typeof job.step === "object") return { state: "failed", error: job.step };
    try {
      await job.render;
      return { state: "succeeded" };
    } catch (err) {
      return { state: "failed", error: { message: (err as Error).message, retryable: false, code: "MOCK_RENDER_FAILED" } };
    }
  }

  async getResult(_providerJobId: string, target: ResultTarget): Promise<{ clipPath: string }> {
    return { clipPath: join(target.outputDir, `${target.sceneId}.mp4`) };
  }
}

async function renderClip(req: GenerateRequest, clipPath: string): Promise<void> {
  await mkdir(req.outputDir, { recursive: true });
  const label = join(req.outputDir, `${req.sceneId}.label.png`);
  await renderLabelPng(label, req.sceneId);
  const d = req.durationSeconds;
  try {
    await ffmpeg([
      "-f", "lavfi", "-i", `testsrc2=size=1080x1920:rate=15:duration=${d}`,
      "-loop", "1", "-framerate", "15", "-t", String(d), "-i", label,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${d}`,
      "-filter_complex", "[0:v][1:v]overlay=0:0,format=yuv420p[v]",
      "-map", "[v]", "-map", "2:a", "-ac", "2",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-t", String(d), clipPath,
    ]);
  } finally {
    await rm(label, { force: true });
  }
}
