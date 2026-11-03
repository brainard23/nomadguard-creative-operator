import { loadVertexConfig } from "../config.ts";
import { FakeLlmClient } from "./fakeClient.ts";
import type { LlmClient } from "./types.ts";
import { VertexGeminiClient } from "./vertexGeminiClient.ts";

export type LlmKind = "fake" | "vertex";

export function createLlmClient(kind: LlmKind): LlmClient {
  return kind === "fake" ? new FakeLlmClient() : new VertexGeminiClient(loadVertexConfig());
}

export { LlmOutputError, type LlmClient, type GenerateJsonOptions } from "./types.ts";
