import type { Scene, Storyboard } from "./schemas.ts";

/**
 * Storyboard normalization rule (pure, never mutates its input):
 *
 *  1. Reject: no scenes, a non-positive/non-finite duration, or a first scene
 *     that is not the hook.
 *  2. Reject: more scenes than can fit even at Veo's shortest clip (4s each)
 *     plus the shortest end card (2s) within the 15s ceiling.
 *  3. Snap every scene duration to Veo's allowed clip lengths {4, 6, 8}s
 *     (nearest; a tie goes to the shorter clip). Clamp the end card to 2-3s.
 *  4. Total (scenes + end card) > 15s: repeatedly shrink the longest scene one
 *     step (8->6->4; ties pick the later scene so the hook keeps its length),
 *     then, if still over, drop the end card to 2s.
 *  5. Total < 10s: first lengthen the end card to 3s, then repeatedly grow the
 *     shortest scene one step (4->6->8; ties pick the earlier scene).
 *
 * Every change is reported in `adjustments` so callers can log what was fixed.
 */

export const VEO_CLIP_SECONDS = [4, 6, 8] as const;
export const MIN_TOTAL_SECONDS = 10;
export const MAX_TOTAL_SECONDS = 15;
export const END_CARD_MIN_SECONDS = 2;
export const END_CARD_MAX_SECONDS = 3;

export type StoryboardErrorCode =
  | "NO_SCENES"
  | "NO_HOOK"
  | "INVALID_DURATION"
  | "TOO_MANY_SCENES"
  | "CANNOT_FIT";

export class StoryboardError extends Error {
  override name = "StoryboardError";
  constructor(
    readonly code: StoryboardErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface NormalizedStoryboard {
  storyboard: Storyboard;
  adjustments: string[];
}

const MIN_CLIP = VEO_CLIP_SECONDS[0];
const MAX_CLIP = VEO_CLIP_SECONDS[VEO_CLIP_SECONDS.length - 1]!;

function snapToVeo(seconds: number): number {
  let best: number = MIN_CLIP;
  for (const c of VEO_CLIP_SECONDS) {
    if (Math.abs(c - seconds) < Math.abs(best - seconds)) best = c;
  }
  return best;
}

function stepDown(d: number): number {
  return [...VEO_CLIP_SECONDS].reverse().find((c) => c < d) ?? d;
}

function stepUp(d: number): number {
  return VEO_CLIP_SECONDS.find((c) => c > d) ?? d;
}

export function normalizeStoryboard(input: Storyboard): NormalizedStoryboard {
  const { scenes: inScenes, end_card: inEnd } = input;

  if (inScenes.length === 0) {
    throw new StoryboardError("NO_SCENES", "Storyboard has no scenes.");
  }
  for (const s of inScenes) {
    if (!Number.isFinite(s.duration) || s.duration <= 0) {
      throw new StoryboardError("INVALID_DURATION", `Scene "${s.id}" has invalid duration ${s.duration}.`);
    }
  }
  if (!Number.isFinite(inEnd.duration) || inEnd.duration <= 0) {
    throw new StoryboardError("INVALID_DURATION", `End card has invalid duration ${inEnd.duration}.`);
  }
  if (inScenes[0]!.purpose !== "hook") {
    throw new StoryboardError(
      "NO_HOOK",
      `First scene "${inScenes[0]!.id}" must have purpose "hook" (found "${inScenes[0]!.purpose}").`,
    );
  }
  const minPossible = inScenes.length * MIN_CLIP + END_CARD_MIN_SECONDS;
  if (minPossible > MAX_TOTAL_SECONDS) {
    throw new StoryboardError(
      "TOO_MANY_SCENES",
      `${inScenes.length} scenes need at least ${minPossible}s (min ${MIN_CLIP}s per clip + ${END_CARD_MIN_SECONDS}s end card), over the ${MAX_TOTAL_SECONDS}s limit.`,
    );
  }

  const adjustments: string[] = [];
  const scenes: Scene[] = inScenes.map((s) => {
    const snapped = snapToVeo(s.duration);
    if (snapped !== s.duration) {
      adjustments.push(`scene ${s.id}: ${s.duration}s -> ${snapped}s (snapped to Veo length)`);
    }
    return { ...s, duration: snapped };
  });

  let endDuration = Math.min(END_CARD_MAX_SECONDS, Math.max(END_CARD_MIN_SECONDS, inEnd.duration));
  if (endDuration !== inEnd.duration) {
    adjustments.push(`end card: ${inEnd.duration}s -> ${endDuration}s (clamped to 2-3s)`);
  }

  const sum = () => scenes.reduce((t, s) => t + s.duration, 0) + endDuration;

  while (sum() > MAX_TOTAL_SECONDS) {
    let target: Scene | undefined;
    for (const s of scenes) {
      if (s.duration > MIN_CLIP && (!target || s.duration >= target.duration)) target = s;
    }
    if (!target) break;
    const next = stepDown(target.duration);
    adjustments.push(`scene ${target.id}: ${target.duration}s -> ${next}s (total over ${MAX_TOTAL_SECONDS}s)`);
    target.duration = next;
  }
  if (sum() > MAX_TOTAL_SECONDS && endDuration > END_CARD_MIN_SECONDS) {
    adjustments.push(`end card: ${endDuration}s -> ${END_CARD_MIN_SECONDS}s (total over ${MAX_TOTAL_SECONDS}s)`);
    endDuration = END_CARD_MIN_SECONDS;
  }
  if (sum() > MAX_TOTAL_SECONDS) {
    // Unreachable after the TOO_MANY_SCENES pre-check; kept as a safety net.
    throw new StoryboardError("CANNOT_FIT", `Cannot fit storyboard into ${MAX_TOTAL_SECONDS}s.`);
  }

  if (sum() < MIN_TOTAL_SECONDS && endDuration < END_CARD_MAX_SECONDS) {
    adjustments.push(`end card: ${endDuration}s -> ${END_CARD_MAX_SECONDS}s (total under ${MIN_TOTAL_SECONDS}s)`);
    endDuration = END_CARD_MAX_SECONDS;
  }
  while (sum() < MIN_TOTAL_SECONDS) {
    let target: Scene | undefined;
    for (const s of scenes) {
      if (s.duration < MAX_CLIP && (!target || s.duration < target.duration)) target = s;
    }
    if (!target) {
      throw new StoryboardError("CANNOT_FIT", `Cannot reach the ${MIN_TOTAL_SECONDS}s minimum.`);
    }
    const next = stepUp(target.duration);
    adjustments.push(`scene ${target.id}: ${target.duration}s -> ${next}s (total under ${MIN_TOTAL_SECONDS}s)`);
    target.duration = next;
  }

  return {
    storyboard: { ...input, scenes, end_card: { ...inEnd, duration: endDuration } },
    adjustments,
  };
}
