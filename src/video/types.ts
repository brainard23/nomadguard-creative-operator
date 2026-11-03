export interface GenerateRequest {
  sceneId: string;
  prompt: string;
  negativePrompt: string;
  durationSeconds: number;
  aspectRatio: "9:16";
  /** Directory the provider should write the finished clip into. */
  outputDir: string;
}

export type VideoJobState = "pending" | "running" | "succeeded" | "failed";

export interface VideoJobError {
  message: string;
  /** Transient (timeout, rate limit, 5xx) vs permanent (safety filter, invalid request). */
  retryable: boolean;
  code?: string;
}

export interface VideoJobStatus {
  state: VideoJobState;
  error?: VideoJobError;
}

/** Async video generation boundary. The workflow depends only on this interface. */
export interface VideoProvider {
  generate(req: GenerateRequest): Promise<{ providerJobId: string }>;
  getStatus(providerJobId: string): Promise<VideoJobStatus>;
  /** Only valid once status is "succeeded". */
  getResult(providerJobId: string): Promise<{ clipPath: string }>;
}
