import { loadVeoConfig } from "../config.ts";
import { MockVideoProvider } from "./mockProvider.ts";
import type { VideoProvider } from "./types.ts";
import { VeoVideoProvider } from "./veoProvider.ts";

export type ProviderKind = "mock" | "veo";

/** Preflight + construct: a missing Vertex config throws ConfigError before any job starts. */
export function createVideoProvider(kind: ProviderKind): VideoProvider {
  if (kind === "mock") return new MockVideoProvider();
  return new VeoVideoProvider(loadVeoConfig());
}

export type { VideoProvider, GenerateRequest, VideoJobStatus, VideoJobError } from "./types.ts";
