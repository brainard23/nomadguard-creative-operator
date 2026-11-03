import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ffmpeg } from "../media/exec.ts";
import { renderLabelPng } from "../media/textImage.ts";
import type { GenerateRequest, ResultTarget, VideoJobError, VideoJobStatus, VideoProvider } from "./types.ts";

export interface MockProviderOptions {
  /** Polls that report "running" before the job completes. Default 1. */
  pollsBeforeDone?: number;
  /** Failure injection: sceneId -> error reported by getStatus instead of success. */
  failures?: Record<string, VideoJobError>;
}

interface MockJob {
  req: GenerateRequest;
  polls: number;
  clipPath: string;
  render: Promise<void>;
}

/** Offline provider: renders a real 1080x1920 clip with audio via ffmpeg. */
export class MockVideoProvider implements VideoProvider {
  private readonly jobs = new Map<string, MockJob>();
  private readonly pollsBeforeDone: number;
  private readonly failures: Record<string, VideoJobError>;

  constructor(options: MockProviderOptions = {}) {
    this.pollsBeforeDone = options.pollsBeforeDone ?? 1;
    this.failures = options.failures ?? {};
  }

  async generate(req: GenerateRequest): Promise<{ providerJobId: string }> {
    const providerJobId = `mock-${req.sceneId}-${randomBytes(3).toString("hex")}`;
    const clipPath = join(req.outputDir, `${req.sceneId}.mp4`);
    const render = this.failures[req.sceneId] ? Promise.resolve() : renderClip(req, clipPath);
    render.catch(() => undefined); // surfaced through getStatus, avoid unhandled rejection
    this.jobs.set(providerJobId, { req, polls: 0, clipPath, render });
    return { providerJobId };
  }

  async getStatus(providerJobId: string): Promise<VideoJobStatus> {
    const job = this.job(providerJobId);
    job.polls += 1;
    if (job.polls <= this.pollsBeforeDone) return { state: job.polls === 1 ? "pending" : "running" };
    const injected = this.failures[job.req.sceneId];
    if (injected) return { state: "failed", error: injected };
    try {
      await job.render;
      return { state: "succeeded" };
    } catch (err) {
      return { state: "failed", error: { message: (err as Error).message, retryable: false, code: "MOCK_RENDER_FAILED" } };
    }
  }

  async getResult(providerJobId: string, _target?: ResultTarget): Promise<{ clipPath: string }> {
    return { clipPath: this.job(providerJobId).clipPath };
  }

  private job(id: string): MockJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown mock provider job ${id}`);
    return job;
  }
}

async function renderClip(req: GenerateRequest, clipPath: string): Promise<void> {
  await mkdir(req.outputDir, { recursive: true });
  const label = join(req.outputDir, `${req.sceneId}.label.png`);
  await renderLabelPng(label, req.sceneId);
  const d = req.durationSeconds;
  try {
    await ffmpeg([
      "-f", "lavfi", "-i", `testsrc2=size=1080x1920:rate=30:duration=${d}`,
      "-loop", "1", "-framerate", "30", "-t", String(d), "-i", label,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${d}`,
      "-filter_complex", "[0:v][1:v]overlay=0:0,format=yuv420p[v]",
      "-map", "[v]", "-map", "2:a", "-ac", "2",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-t", String(d), clipPath,
    ]);
  } finally {
    await rm(label, { force: true });
  }
}
