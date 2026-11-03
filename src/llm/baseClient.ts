import { readFile } from "node:fs/promises";
import { z, type ZodType } from "zod";
import { LlmOutputError, type GenerateJsonOptions, type LlmClient, type LlmImage, type ResolvedImage } from "./types.ts";

export interface CompleteRequest {
  prompt: string;
  opts: GenerateJsonOptions;
  /** JSON Schema derived from the zod schema, for providers that support constrained output. */
  jsonSchema: Record<string, unknown>;
  /** 0 for the first attempt, 1 for the repair attempt. */
  attempt: number;
  /** Images to send alongside the prompt (same set on the repair attempt). */
  images?: ResolvedImage[];
}

/**
 * Shared validation + repair logic. Subclasses only implement `complete` (raw text out).
 * Invalid output (bad JSON or schema mismatch) gets exactly ONE repair attempt that
 * carries the validation error and the bad output; a second failure throws LlmOutputError.
 */
export abstract class BaseLlmClient implements LlmClient {
  protected abstract complete(req: CompleteRequest): Promise<string>;

  generateJson<T>(prompt: string, schema: ZodType<T>, opts: GenerateJsonOptions = {}): Promise<T> {
    return this.run(prompt, schema, opts);
  }

  async generateJsonFromImages<T>(
    prompt: string,
    images: LlmImage[],
    schema: ZodType<T>,
    opts: GenerateJsonOptions = {},
  ): Promise<T> {
    const resolved = await Promise.all(
      images.map(async (i) => ({ data: i.path !== undefined ? await readFile(i.path) : i.data!, mimeType: i.mimeType })),
    );
    return this.run(prompt, schema, opts, resolved);
  }

  private async run<T>(
    prompt: string,
    schema: ZodType<T>,
    opts: GenerateJsonOptions,
    images?: ResolvedImage[],
  ): Promise<T> {
    const jsonSchema = toJsonSchema(schema);
    let currentPrompt = prompt;
    let raw = "";
    let issues = "";

    for (let attempt = 0; attempt < 2; attempt++) {
      raw = await this.complete({ prompt: currentPrompt, opts, jsonSchema, attempt, images });
      const result = parseAndValidate(raw, schema);
      if (result.ok) return result.value;
      issues = result.issues;
      currentPrompt = repairPrompt(prompt, raw, issues);
    }
    throw new LlmOutputError(
      `LLM output failed validation after one repair attempt${opts.task ? ` (task: ${opts.task})` : ""}: ${issues}`,
      opts.task,
      issues,
      raw,
    );
  }
}

function toJsonSchema(schema: ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return rest;
}

function stripFences(text: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return m ? m[1]! : text;
}

function parseAndValidate<T>(
  raw: string,
  schema: ZodType<T>,
): { ok: true; value: T } | { ok: false; issues: string } {
  let json: unknown;
  try {
    json = JSON.parse(stripFences(raw));
  } catch (err) {
    return { ok: false, issues: `Output is not valid JSON: ${(err as Error).message}` };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, issues };
}

function repairPrompt(original: string, badOutput: string, issues: string): string {
  return [
    original,
    "",
    "---",
    "Your previous response was rejected because it did not match the required JSON format.",
    `Validation error: ${issues}`,
    "Your previous response was:",
    badOutput,
    "",
    "Return ONLY the corrected JSON object that satisfies the schema. No commentary, no markdown fences.",
  ].join("\n");
}
