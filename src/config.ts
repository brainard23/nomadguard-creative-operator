export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface VertexConfig {
  mode: "vertex";
  project: string;
  location: string;
  model: string;
}

export interface ApiKeyConfig {
  mode: "apiKey";
  apiKey: string;
  model: string;
}

export type GeminiConfig = VertexConfig | ApiKeyConfig;

/** Vertex default; AI Studio keys use a newer default because gemini-2.5-flash is closed to new key users. */
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
export const DEFAULT_API_KEY_GEMINI_MODEL = "gemini-3.8-flash";

/**
 * GEMINI_API_KEY (Google AI Studio, free tier) wins; otherwise Vertex AI with ADC.
 * GEMINI_MODEL overrides the default of either mode.
 */
export function loadGeminiConfig(env: NodeJS.ProcessEnv = process.env): GeminiConfig {
  const model = env.GEMINI_MODEL?.trim();
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (apiKey) return { mode: "apiKey", apiKey, model: model || DEFAULT_API_KEY_GEMINI_MODEL };
  const project = env.GOOGLE_CLOUD_PROJECT?.trim();
  const location = env.GOOGLE_CLOUD_LOCATION?.trim();
  if (!project && !location) {
    throw new ConfigError(
      "No Gemini credentials configured. Either set GEMINI_API_KEY (free Google AI Studio key, https://aistudio.google.com/apikey) or set GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION for Vertex AI (plus `gcloud auth application-default login`). Copy .env.example to .env, or use --llm fake.",
    );
  }
  const missing = [!project && "GOOGLE_CLOUD_PROJECT", !location && "GOOGLE_CLOUD_LOCATION"].filter(Boolean);
  if (!project || !location) {
    throw new ConfigError(
      `Missing environment variable(s): ${missing.join(", ")}. Set them for Vertex AI (and run \`gcloud auth application-default login\`), or set GEMINI_API_KEY to use an AI Studio key, or use --llm fake.`,
    );
  }
  return { mode: "vertex", project, location, model: model || DEFAULT_GEMINI_MODEL };
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
