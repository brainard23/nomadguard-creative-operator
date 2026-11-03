import { GoogleGenAI } from "@google/genai";
import { ConfigError, type GeminiConfig } from "../config.ts";
import { BaseLlmClient, type CompleteRequest } from "./baseClient.ts";

/** A 404 from generateContent almost always means the model id is retired or closed to this account. */
export function translateModelError(err: unknown, model: string): Error {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 404) {
    return new ConfigError(
      `Gemini model "${model}" was not found or is no longer available to this account (404). Set GEMINI_MODEL to a current model, e.g. GEMINI_MODEL=gemini-3.8-flash.`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Gemini via the official SDK: an AI Studio API key (GEMINI_API_KEY) or Vertex AI with
 * Application Default Credentials. The key is only handed to the SDK, never logged.
 */
export class VertexGeminiClient extends BaseLlmClient {
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor(config: GeminiConfig) {
    super();
    this.ai =
      config.mode === "apiKey"
        ? new GoogleGenAI({ apiKey: config.apiKey })
        : new GoogleGenAI({ vertexai: true, project: config.project, location: config.location });
    this.model = config.model;
  }

  protected override async complete({ prompt, opts, jsonSchema, images }: CompleteRequest): Promise<string> {
    let response;
    try {
      response = await this.ai.models.generateContent({
        model: this.model,
        contents: images?.length
          ? [
              {
                role: "user",
                parts: [
                  ...images.map((i) => ({ inlineData: { data: Buffer.from(i.data).toString("base64"), mimeType: i.mimeType } })),
                  { text: prompt },
                ],
              },
            ]
          : prompt,
        config: {
          systemInstruction: opts.systemInstruction,
          temperature: opts.temperature,
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema,
        },
      });
    } catch (err) {
      throw translateModelError(err, this.model);
    }
    return response.text ?? "";
  }
}
