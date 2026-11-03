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
