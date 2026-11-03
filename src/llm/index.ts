import { loadGeminiConfig } from "../config.ts";
import { FakeLlmClient } from "./fakeClient.ts";
import type { LlmClient } from "./types.ts";
import { VertexGeminiClient } from "./vertexGeminiClient.ts";

/** "gemini" picks an AI Studio key or Vertex from the environment; "vertex" is a kept alias. */
export type LlmKind = "fake" | "gemini" | "vertex";

export function createLlmClient(kind: LlmKind): LlmClient {
  return kind === "fake" ? new FakeLlmClient() : new VertexGeminiClient(loadGeminiConfig());
}

export { LlmOutputError, type LlmClient, type GenerateJsonOptions, type LlmImage } from "./types.ts";
