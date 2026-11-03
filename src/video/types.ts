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

/** Where to write the finished clip: `<outputDir>/<sceneId>.mp4`. Passed explicitly so getResult is stateless. */
export interface ResultTarget {
  sceneId: string;
  outputDir: string;
}

/** Typed provider failure thrown by generate/getResult so callers can tell retryable from permanent. */
export class VideoProviderError extends Error {
  override name = "VideoProviderError";
  code?: string;
  retryable: boolean;
  constructor(message: string, opts: { retryable: boolean; code?: string; cause?: unknown }) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.retryable = opts.retryable;
    this.code = opts.code;
  }
}

/** Async video generation boundary. The workflow depends only on this interface. */
export interface VideoProvider {
  generate(req: GenerateRequest): Promise<{ providerJobId: string }>;
  getStatus(providerJobId: string): Promise<VideoJobStatus>;
  /** Only valid once status is "succeeded". */
  getResult(providerJobId: string, target: ResultTarget): Promise<{ clipPath: string }>;
}
