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
 * `generateJsonFromImages` is the vision sibling and shares the same validation/repair core.
 */
export interface LlmClient {
  generateJson<T>(prompt: string, schema: ZodType<T>, opts?: GenerateJsonOptions): Promise<T>;
  generateJsonFromImages<T>(
    prompt: string,
    images: LlmImage[],
    schema: ZodType<T>,
    opts?: GenerateJsonOptions,
  ): Promise<T>;
}

/** An image input: either a file path (read at call time) or raw bytes. */
export type LlmImage = { mimeType: string } & ({ path: string; data?: never } | { data: Uint8Array; path?: never });

/** An image with its bytes resolved, as handed to provider implementations. */
export interface ResolvedImage {
  data: Uint8Array;
  mimeType: string;
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
