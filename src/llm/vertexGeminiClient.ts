import { GoogleGenAI } from "@google/genai";
import type { VertexConfig } from "../config.ts";
import { BaseLlmClient, type CompleteRequest } from "./baseClient.ts";

/** Gemini on Vertex AI via the official SDK; auth is Application Default Credentials. */
export class VertexGeminiClient extends BaseLlmClient {
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor(config: VertexConfig) {
    super();
    this.ai = new GoogleGenAI({
      vertexai: true,
      project: config.project,
      location: config.location,
    });
    this.model = config.geminiModel;
  }

  protected override async complete({ prompt, opts, jsonSchema, images }: CompleteRequest): Promise<string> {
    const response = await this.ai.models.generateContent({
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
    return response.text ?? "";
  }
}
