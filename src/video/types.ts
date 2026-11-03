export interface GenerateRequest {
  sceneId: string;
  prompt: string;
  negativePrompt: string;
  durationSeconds: number;
  aspectRatio: "9:16";
  /** Directory the provider should write the finished clip into. */
  outputDir: string;
}

/** "awaiting_input": nothing will happen until a human supplies the clip (manual provider); the run pauses instead of polling. */
export type VideoJobState = "pending" | "running" | "succeeded" | "failed" | "awaiting_input";

export interface VideoJobError {
  message: string;
  /** Transient (timeout, rate limit, 5xx) vs permanent (safety filter, invalid request). */
  retryable: boolean;
  code?: string;
}

export interface VideoJobStatus {
  state: VideoJobState;
  error?: VideoJobError;
  /** Human-readable detail, e.g. which file the provider is waiting for. */
  message?: string;
}

/** Async video generation boundary. The workflow depends only on this interface. */
export interface VideoProvider {
  generate(req: GenerateRequest): Promise<{ providerJobId: string }>;
  /** `target` tells stateless providers where the run's files live (manual provider); others ignore it. */
  getStatus(providerJobId: string, target?: ResultTarget): Promise<VideoJobStatus>;
  /**
   * Only valid once status is "succeeded". Stateless: the caller says where the clip belongs,
   * so it works after a restart without any provider memory.
   */
  getResult(providerJobId: string, target: ResultTarget): Promise<{ clipPath: string }>;
}

export interface ResultTarget {
  sceneId: string;
  outputDir: string;
}

/** Thrown by providers; `retryable` marks transient failures (rate limit, 5xx, timeout). */
export class VideoProviderError extends Error {
  override name = "VideoProviderError";
  code?: string;
  retryable: boolean;
  constructor(message: string, options: { retryable: boolean; code?: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.retryable = options.retryable;
    this.code = options.code;
  }
}
