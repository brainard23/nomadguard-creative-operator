import type { ZodType } from "zod";

export interface GenerateJsonOptions {
  /** Names the call site (e.g. "strategy"); used for fixtures, logs and error context. */
  task?: string;
  /** System-level instruction (role / persona). */
  systemInstruction?: string;
  temperature?: number;
}

/**
 * Boundary to an LLM that returns schema-validated JSON. Implementations own the
 * model call, JSON-mode request, validation and one repair retry.
 * A `generateJsonFromImages(prompt, images, schema, opts?)` sibling (S5, creative QA)
 * will be added alongside `generateJson`; it reuses the same validation/repair core.
 */
export interface LlmClient {
  generateJson<T>(prompt: string, schema: ZodType<T>, opts?: GenerateJsonOptions): Promise<T>;
}

export class LlmOutputError extends Error {
  override name = "LlmOutputError";
  constructor(
    message: string,
    readonly task: string | undefined,
    /** Human-readable validation / parse problems from the final attempt. */
    readonly issues: string,
    /** The final invalid model output. */
    readonly rawOutput: string,
  ) {
    super(message);
  }
}
