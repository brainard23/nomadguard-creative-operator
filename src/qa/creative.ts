import { z } from "zod";
import type { Brief } from "../brief/schema.ts";
import { ConfigError } from "../config.ts";
import type { Storyboard, Strategy } from "../creative/schemas.ts";
import type { LlmClient } from "../llm/types.ts";
import { END_CARD_ID, type SampledFrame } from "./frames.ts";

export const DIMENSIONS = ["realism", "visual_consistency", "brief_adherence", "hook_strength", "advertising_quality"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

const ScoreSchema = z.object({ score: z.number().int().min(1).max(10), note: z.string().min(1) });

/** Schema factory: `weakest_scene_id` must be one of the storyboard's scene ids (violations go through the repair retry). */
export function creativeQaSchema(sceneIds: string[]) {
  return z.object({
    scores: z.object(Object.fromEntries(DIMENSIONS.map((d) => [d, ScoreSchema])) as Record<Dimension, typeof ScoreSchema>),
    weakest_scene_id: z.string().refine((id) => sceneIds.includes(id), {
      message: `weakest_scene_id must be one of: ${sceneIds.join(", ")}`,
    }),
    issues: z.array(z.string()),
    verdict_summary: z.string().min(1),
  });
}

export type CreativeQaResult = z.infer<ReturnType<typeof creativeQaSchema>>;
export type CreativeScores = CreativeQaResult["scores"];

export interface CreativeQaThresholds {
  minAvg: number;
  minScore: number;
}

export function loadCreativeQaThresholds(env: NodeJS.ProcessEnv = process.env): CreativeQaThresholds {
  const read = (key: string, fallback: number): number => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || n > 10) throw new ConfigError(`${key} must be a number between 1 and 10 (got "${raw}").`);
    return n;
  };
  return { minAvg: read("CREATIVE_QA_MIN_AVG", 7), minScore: read("CREATIVE_QA_MIN_SCORE", 5) };
}

export interface CreativeDecision {
  pass: boolean;
  reasons: string[];
}

/** Pass when the average >= minAvg AND no single score < minScore. */
export function decideCreativeQa(scores: CreativeScores, weakestSceneId: string, t: CreativeQaThresholds): CreativeDecision {
  const entries = DIMENSIONS.map((d) => [d, scores[d].score] as const);
  const avg = entries.reduce((s, [, v]) => s + v, 0) / entries.length;
  const reasons: string[] = [];
  for (const [d, v] of entries) if (v < t.minScore) reasons.push(`${d} scored ${v}, below the minimum of ${t.minScore}`);
  if (avg < t.minAvg) reasons.push(`average score ${avg.toFixed(1)} is below the minimum of ${t.minAvg}`);
  if (reasons.length) reasons.push(`weakest scene: ${weakestSceneId}`);
  return { pass: reasons.length === 0, reasons };
}

const SYSTEM = `You are a strict creative director at a paid-social agency reviewing a finished vertical video ad before it ships. You are skeptical by default: most AI-generated ads have flaws and you find them. Judge ONLY what is visible in the supplied frames, never what the storyboard says should be there. Penalise AI artifacts heavily: warped or extra fingers and hands, distorted or melting faces, gibberish or misspelled on-screen text, objects that morph, and identity drift (character, wardrobe or setting changing between scenes). The final frame is the branded end card (brand name, headline, call to action) and some scenes carry a notification card added in post: both are intentional motion graphics, not AI artifacts, so judge them as design, not realism.`;

export interface CreativeQaInput {
  brief: Brief;
  strategy: Strategy;
  storyboard: Storyboard;
  frames: SampledFrame[];
}

export function creativeQaPrompt({ brief, strategy, storyboard, frames }: CreativeQaInput): string {
  const angle = strategy.angles.find((a) => a.name === strategy.selection.selected_angle);
  const scenes = storyboard.scenes.map((s) => ({ id: s.id, duration: s.duration, purpose: s.purpose, description: s.description }));
  return `Review this finished ad.

BRIEF
${JSON.stringify(brief, null, 2)}

SELECTED ANGLE: ${strategy.selection.selected_angle}
Why it was selected: ${strategy.selection.why_selected}
${angle ? `Hook: ${angle.hook}\nConcept: ${angle.concept}` : ""}

STORYBOARD (scenes in order, then a ${storyboard.end_card.duration}s end card)
${JSON.stringify(scenes, null, 2)}

FRAMES (attached as images, in this order)
${frames.map((f, i) => `${i + 1}. t=${f.t.toFixed(2)}s, ${f.scene_id === END_CARD_ID ? "the end card (brand + CTA)" : `scene ${f.scene_id}`}`).join("\n")}

The last frame is the end card: it carries the brand and call to action, so do not report missing branding if it shows them. Any notification card over a scene is an intentional graphic overlay added in post.

Score each dimension as an INTEGER from 1 to 10 with a one-sentence note: ${DIMENSIONS.join(", ")}.
- realism: photorealism and absence of AI artifacts
- visual_consistency: same character, wardrobe, setting and grade across scenes
- brief_adherence: does it deliver the brief, audience, core message and brand feel
- hook_strength: would the first second stop a scroll
- advertising_quality: polish, clarity of story and payoff as a paid social ad
Also return weakest_scene_id (EXACTLY one of: ${storyboard.scenes.map((s) => s.id).join(", ")}), issues (a list of concrete problems you can see, empty if none) and verdict_summary (2 sentences max).
Respond with JSON only.`;
}

/** Throws LlmOutputError (or a network error) if the vision call fails; the caller decides how to degrade. */
export async function runCreativeQa(llm: LlmClient, input: CreativeQaInput): Promise<CreativeQaResult> {
  return llm.generateJsonFromImages(
    creativeQaPrompt(input),
    input.frames.map((f) => ({ path: f.path, mimeType: "image/jpeg" })),
    creativeQaSchema(input.storyboard.scenes.map((s) => s.id)),
    { task: "creative_qa", systemInstruction: SYSTEM, temperature: 0.2 },
  );
}
