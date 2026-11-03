import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerateVideosOperation, GoogleGenAI } from "@google/genai";
import type { VeoConfig } from "../config.ts";
import { classifyVeoError } from "./veoErrors.ts";
import type { GenerateRequest, VideoJobError, VideoJobStatus, VideoProvider } from "./types.ts";

/** The slice of a Veo operation this provider reads (structurally satisfied by the SDK's operation). */
export interface VeoOperation {
  name?: string;
  done?: boolean;
  error?: Record<string, unknown>;
  response?: {
    generatedVideos?: Array<{ video?: { videoBytes?: string; uri?: string } }>;
    raiMediaFilteredCount?: number;
    raiMediaFilteredReasons?: string[];
  };
}

export interface VeoGenerateParams {
  model: string;
  prompt: string;
  config: {
    aspectRatio: string;
    durationSeconds: number;
    negativePrompt: string;
    generateAudio: boolean;
    numberOfVideos: number;
    resolution: string;
    personGeneration: string;
  };
}

/** Minimal client seam, injected in tests. Poll is by operation name alone (stateless, resume-safe). */
export interface VeoClient {
  generateVideos(params: VeoGenerateParams): Promise<VeoOperation>;
  getVideosOperation(operationName: string): Promise<VeoOperation>;
}

export function createSdkVeoClient(config: Pick<VeoConfig, "project" | "location">): VeoClient {
  const ai = new GoogleGenAI({ vertexai: true, project: config.project, location: config.location });
  return {
    generateVideos: (params) => ai.models.generateVideos(params),
    async getVideosOperation(name) {
      // The SDK only needs `name` to poll on Vertex (it derives the model resource from it).
      const operation = new GenerateVideosOperation();
      operation.name = name;
      return ai.operations.getVideosOperation({ operation });
    },
  };
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

interface JobInfo {
  sceneId: string;
  outputDir: string;
}

const opId = (name: string) => name.split("/").pop() ?? name;

/** Veo 3.1 on Vertex AI. `providerJobId` is the long-running operation name. */
export class VeoVideoProvider implements VideoProvider {
  private readonly client: VeoClient;
  private readonly semaphore: Semaphore;
  private readonly jobs = new Map<string, JobInfo>();

  constructor(
    private readonly config: VeoConfig,
    client?: VeoClient,
    /** Where results go when getResult is called for a job this process did not submit (resume). */
    private readonly fallbackOutputDir: string = join(tmpdir(), "nomadguard-veo"),
  ) {
    this.client = client ?? createSdkVeoClient(config);
    this.semaphore = new Semaphore(config.maxConcurrency);
  }

  async generate(req: GenerateRequest): Promise<{ providerJobId: string }> {
    const op = await this.semaphore.run(() =>
      this.client.generateVideos({
        model: this.config.model,
        prompt: req.prompt,
        config: {
          aspectRatio: req.aspectRatio,
          durationSeconds: req.durationSeconds,
          negativePrompt: req.negativePrompt,
          generateAudio: true,
          numberOfVideos: 1,
          resolution: this.config.resolution,
          personGeneration: "allow_adult",
        },
      }),
    );
    if (!op.name) throw new Error("Veo did not return an operation name.");
    this.jobs.set(op.name, { sceneId: req.sceneId, outputDir: req.outputDir });
    return { providerJobId: op.name };
  }

  async getStatus(providerJobId: string): Promise<VideoJobStatus> {
    let op: VeoOperation;
    try {
      op = await this.client.getVideosOperation(providerJobId);
    } catch (err) {
      return { state: "failed", error: classifyVeoError(err) };
    }
    if (!op.done) return { state: "running" };
    if (op.error) return { state: "failed", error: classifyVeoError(op.error) };
    if (!firstVideo(op)) return { state: "failed", error: noVideoError(op) };
    return { state: "succeeded" };
  }

  async getResult(providerJobId: string): Promise<{ clipPath: string }> {
    const op = await this.client.getVideosOperation(providerJobId);
    if (!op.done || op.error) throw new Error(`Veo operation ${providerJobId} is not successfully done.`);
    const video = firstVideo(op);
    if (!video) throw new Error(noVideoError(op).message);
    if (!video.videoBytes) {
      throw Object.assign(
        new Error(
          `Veo returned a GCS uri (${video.uri ?? "unknown"}) instead of inline bytes. OUTPUT_GCS_URI is not supported in this version; leave outputGcsUri unset.`,
        ),
        { retryable: false },
      );
    }
    const info = this.jobs.get(providerJobId) ?? { sceneId: opId(providerJobId), outputDir: this.fallbackOutputDir };
    await mkdir(info.outputDir, { recursive: true });
    const clipPath = join(info.outputDir, `${info.sceneId}.mp4`);
    await writeFile(clipPath, Buffer.from(video.videoBytes, "base64"));
    return { clipPath };
  }
}

function firstVideo(op: VeoOperation) {
  return op.response?.generatedVideos?.find((g) => g.video?.videoBytes || g.video?.uri)?.video;
}

function noVideoError(op: VeoOperation): VideoJobError {
  const reasons = op.response?.raiMediaFilteredReasons?.join("; ");
  const filtered = op.response?.raiMediaFilteredCount;
  if (reasons || filtered) {
    return {
      message: `Veo filtered the video (safety/RAI)${reasons ? `: ${reasons}` : ""}`,
      retryable: false,
      code: "RAI_FILTERED",
    };
  }
  return { message: "Veo finished without returning a video.", retryable: false, code: "NO_VIDEO" };
}
