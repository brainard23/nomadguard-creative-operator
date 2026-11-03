import type { Brief } from "../brief/schema.ts";
import type { LlmClient } from "../llm/types.ts";
import { normalizeStoryboard, type NormalizedStoryboard } from "./normalizeStoryboard.ts";
import { StoryboardSchema, type Angle } from "./schemas.ts";

const SYSTEM = `You are a commercial director and storyboard artist for short-form vertical video ads. You write shots that an AI video model (Veo) can render realistically: one clear action per shot, one character, concrete visual detail, real camera language.`;

export function storyboardPrompt(brief: Brief, angle: Angle): string {
  return `Write the storyboard for this ad.

BRIEF
${JSON.stringify(brief, null, 2)}

SELECTED ANGLE
${JSON.stringify(angle, null, 2)}

REQUIREMENTS
- style_guide: ONE shared look for every shot: character (age, build, hair, face, expression), wardrobe (specific garments and colors), setting, palette, lens, grade, lighting. Describe the character and wardrobe in full, concrete detail: the text is pasted verbatim into every shot prompt so the same person appears in every clip.
- scenes: 2 or 3 scenes. The FIRST scene must have purpose "hook" and deliver a strong visual hook in its first 2-3 seconds. Other scenes use purpose "problem", "turn", "resolution" or "payoff". Each scene: id (s1, s2, ...), duration in seconds (use only 4, 6 or 8), description (what happens, one clear action, photorealistic live action), camera (shot type and movement), purpose, optional dialogue_or_sfx (sound cue; keep any speech to a few words).
- Total of all scene durations plus the end card must be between 10 and 15 seconds.
- NO on-screen text, logos or subtitles inside any scene; text appears only on the end card.
- end_card: duration 2-3 seconds, headline (short), cta (from the angle).
Respond with JSON only.`;
}

/** Writes the storyboard with the LLM, then normalizes it to Veo clip lengths and 10-15s. */
export async function writeStoryboard(
  llm: LlmClient,
  brief: Brief,
  angle: Angle,
): Promise<NormalizedStoryboard> {
  const raw = await llm.generateJson(storyboardPrompt(brief, angle), StoryboardSchema, {
    task: "storyboard",
    systemInstruction: SYSTEM,
    temperature: 0.8,
  });
  return normalizeStoryboard(raw);
}
