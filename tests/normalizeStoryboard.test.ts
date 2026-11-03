import { describe, expect, it } from "vitest";
import { StoryboardSchema } from "../src/creative/schemas.ts";
import { normalizeStoryboard, StoryboardError } from "../src/creative/normalizeStoryboard.ts";
import { storyboard, total } from "./support.ts";

const VEO = [4, 6, 8];

function rejection(sb: ReturnType<typeof storyboard>): StoryboardError {
  try {
    normalizeStoryboard(sb);
  } catch (err) {
    expect(err).toBeInstanceOf(StoryboardError);
    return err as StoryboardError;
  }
  throw new Error("expected normalizeStoryboard to throw");
}

describe("normalizeStoryboard", () => {
  it("leaves an already valid storyboard unchanged", () => {
    const input = storyboard([4, 4, 4], 2);
    const { storyboard: out, adjustments } = normalizeStoryboard(input);
    expect(out).toEqual(input);
    expect(adjustments).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = storyboard([5, 7, 3], 2);
    const copy = structuredClone(input);
    normalizeStoryboard(input);
    expect(input).toEqual(copy);
  });

  it("snaps each scene duration to the nearest of 4/6/8", () => {
    const { storyboard: out, adjustments } = normalizeStoryboard(storyboard([3.2, 7.1], 2));
    expect(out.scenes.map((s) => s.duration)).toEqual([4, 8]);
    expect(adjustments.length).toBeGreaterThan(0);
    // ties snap to the shorter clip
    const tie = normalizeStoryboard(storyboard([5, 7], 2)).storyboard;
    expect(tie.scenes.map((s) => s.duration)).toEqual([4, 6]);
  });

  it("clamps a long end card to 3s and a short one to 2s", () => {
    expect(normalizeStoryboard(storyboard([4, 4, 4], 7)).storyboard.end_card.duration).toBe(3);
    expect(normalizeStoryboard(storyboard([4, 4, 4], 0.5)).storyboard.end_card.duration).toBe(2);
  });

  it("shrinks the longest scene when the total exceeds 15s", () => {
    // 8+8+8+3 = 27 -> must end <= 15 with every scene still in {4,6,8}
    const { storyboard: out } = normalizeStoryboard(storyboard([8, 8, 8], 3));
    expect(total(out)).toBeLessThanOrEqual(15);
    expect(total(out)).toBeGreaterThanOrEqual(10);
    out.scenes.forEach((s) => expect(VEO).toContain(s.duration));
  });

  it("fixes a 2-scene storyboard over 15s", () => {
    const { storyboard: out } = normalizeStoryboard(storyboard([8, 8], 3)); // 19
    expect(total(out)).toBe(15);
    expect(out.scenes.map((s) => s.duration)).toEqual([6, 6]);
  });

  it("extends the storyboard when the total is under 10s", () => {
    const { storyboard: out } = normalizeStoryboard(storyboard([4, 4], 2)); // 10 ok
    expect(total(out)).toBe(10);
    const short = normalizeStoryboard(storyboard([4], 2)).storyboard; // 6 -> grow
    expect(total(short)).toBeGreaterThanOrEqual(10);
    expect(total(short)).toBeLessThanOrEqual(15);
    short.scenes.forEach((s) => expect(VEO).toContain(s.duration));
  });

  it("keeps the hook as the first scene", () => {
    const { storyboard: out } = normalizeStoryboard(storyboard([8, 8, 8], 3));
    expect(out.scenes[0]?.purpose).toBe("hook");
    expect(out.scenes.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("rejects a storyboard with no scenes", () => {
    expect(rejection(storyboard([], 2)).code).toBe("NO_SCENES");
  });

  it("rejects a storyboard whose first scene is not the hook", () => {
    const sb = storyboard([4, 4, 4], 2);
    sb.scenes[0]!.purpose = "problem";
    sb.scenes[1]!.purpose = "hook";
    expect(rejection(sb).code).toBe("NO_HOOK");
  });

  it("rejects more scenes than can fit in 15s with an end card", () => {
    // 4 x 4s + 2s end card = 18s even at the shortest legal lengths
    const err = rejection(storyboard([4, 4, 4, 4], 2));
    expect(err.code).toBe("TOO_MANY_SCENES");
    expect(err.message).toMatch(/15/);
  });

  it("rejects non-positive or non-finite durations", () => {
    expect(rejection(storyboard([4, 0, 4], 2)).code).toBe("INVALID_DURATION");
    expect(rejection(storyboard([4, Number.NaN, 4], 2)).code).toBe("INVALID_DURATION");
    expect(rejection(storyboard([4, 4, 4], -1)).code).toBe("INVALID_DURATION");
  });
});

describe("StoryboardSchema", () => {
  it("rejects a storyboard with missing fields", () => {
    const sb = storyboard([4, 4, 4], 2) as Record<string, unknown>;
    delete (sb.style_guide as Record<string, unknown>).wardrobe;
    expect(StoryboardSchema.safeParse(sb).success).toBe(false);

    const noEnd = { ...storyboard([4, 4, 4], 2) } as Record<string, unknown>;
    delete noEnd.end_card;
    expect(StoryboardSchema.safeParse(noEnd).success).toBe(false);
  });

  it("rejects empty scenes and duplicate scene ids", () => {
    expect(StoryboardSchema.safeParse(storyboard([], 2)).success).toBe(false);
    const dup = storyboard([4, 4, 4], 2);
    dup.scenes[1]!.id = "s1";
    expect(StoryboardSchema.safeParse(dup).success).toBe(false);
  });
});
