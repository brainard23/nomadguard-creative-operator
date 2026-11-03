import type { Brief } from "../brief/schema.ts";
import type { LlmClient } from "../llm/types.ts";
import { StrategySchema, type Strategy } from "./schemas.ts";

const SYSTEM = `You are a senior creative strategist at a top performance-creative agency. You make short-form social video ads (Instagram Reels, TikTok) that stop the scroll in the first 2-3 seconds, communicate with or without sound, and land one clear emotional payoff. You are specific and visual, never generic.`;

export function strategyPrompt(brief: Brief): string {
  return `Develop the creative strategy for this brief.

BRIEF
${JSON.stringify(brief, null, 2)}

TASK
1. Propose at least 3 genuinely DIFFERENT creative angles (different emotion and concept, not variations of one idea). For each give: name, target_emotion, hook (what the viewer sees in the first 2-3 seconds), concept (the 10-15s story in 1-2 sentences), cta (short, spoken-style call to action).
2. Select the single strongest angle. Return selection with: selected_angle (must be EXACTLY one of the angle names), why_selected, audience_insight (the human truth about this audience that the ad exploits), why_it_performs (why it works as a vertical social ad: hook strength, sound-off clarity, payoff).

Every angle must be filmable as photorealistic live-action in 10-15 seconds with no more than 3 shots, and must reflect the brand feel (${brief.brand_feel.join(", ")}). Do not invent real brands, real people or statistics.
Respond with JSON only.`;
}

export async function developStrategy(llm: LlmClient, brief: Brief): Promise<Strategy> {
  return llm.generateJson(strategyPrompt(brief), StrategySchema, {
    task: "strategy",
    systemInstruction: SYSTEM,
    temperature: 0.9,
  });
}
