export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface VertexConfig {
  project: string;
  location: string;
  geminiModel: string;
}

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export function loadVertexConfig(env: NodeJS.ProcessEnv = process.env): VertexConfig {
  const project = env.GOOGLE_CLOUD_PROJECT?.trim();
  const location = env.GOOGLE_CLOUD_LOCATION?.trim();
  const missing = [!project && "GOOGLE_CLOUD_PROJECT", !location && "GOOGLE_CLOUD_LOCATION"].filter(
    Boolean,
  );
  if (!project || !location) {
    throw new ConfigError(
      `Missing environment variable(s): ${missing.join(", ")}. Copy .env.example to .env and set them (and run \`gcloud auth application-default login\`), or use --llm fake.`,
    );
  }
  return { project, location, geminiModel: env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL };
}

export interface VeoConfig {
  project: string;
  location: string;
  model: string;
  resolution: string;
  /** Max simultaneous `generate` submissions (Veo bills per second and quotas are tight). */
  maxConcurrency: number;
}

export const DEFAULT_VEO_MODEL = "veo-3.1-generate-001";
export const DEFAULT_VEO_RESOLUTION = "1080p";
export const DEFAULT_VEO_MAX_CONCURRENCY = 2;

export function loadVeoConfig(env: NodeJS.ProcessEnv = process.env): VeoConfig {
  const project = env.GOOGLE_CLOUD_PROJECT?.trim();
  const location = env.GOOGLE_CLOUD_LOCATION?.trim();
  const missing = [!project && "GOOGLE_CLOUD_PROJECT", !location && "GOOGLE_CLOUD_LOCATION"].filter(
    Boolean,
  );
  if (!project || !location) {
    throw new ConfigError(
      `Missing environment variable(s) for --provider veo: ${missing.join(", ")}. Copy .env.example to .env and set them (Veo needs GOOGLE_CLOUD_LOCATION=us-central1, the Vertex AI API enabled with billing, and \`gcloud auth application-default login\`), or use --provider mock.`,
    );
  }
  const rawConcurrency = env.VEO_MAX_CONCURRENCY?.trim();
  const maxConcurrency = rawConcurrency ? Number(rawConcurrency) : DEFAULT_VEO_MAX_CONCURRENCY;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new ConfigError(`VEO_MAX_CONCURRENCY must be a positive integer (got "${rawConcurrency}").`);
  }
  return {
    project,
    location,
    model: env.VEO_MODEL?.trim() || DEFAULT_VEO_MODEL,
    resolution: env.VEO_RESOLUTION?.trim() || DEFAULT_VEO_RESOLUTION,
    maxConcurrency,
  };
}
