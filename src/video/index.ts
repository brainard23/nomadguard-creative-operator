import { MockVideoProvider } from "./mockProvider.ts";
import type { VideoProvider } from "./types.ts";

export type ProviderKind = "mock" | "veo";

export function createVideoProvider(kind: ProviderKind): VideoProvider {
  if (kind === "mock") return new MockVideoProvider();
  throw new Error("Veo provider not implemented yet (S4). Use --provider mock.");
}

export type { VideoProvider, GenerateRequest, VideoJobStatus, VideoJobError } from "./types.ts";
