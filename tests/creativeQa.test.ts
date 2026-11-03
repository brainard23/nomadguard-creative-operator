import { describe, expect, it } from "vitest";
import { creativeQaPrompt, decideCreativeQa, loadCreativeQaThresholds, creativeQaSchema } from "../src/qa/creative.ts";
import { ConfigError } from "../src/config.ts";
import { storyboard } from "./support.ts";

const scores = (over: Record<string, number> = {}) => {
  const base = { realism: 8, visual_consistency: 8, brief_adherence: 8, hook_strength: 8, advertising_quality: 8, ...over };
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { score: v, note: "n" }]));
};
const T = { minAvg: 7, minScore: 5 };

describe("decideCreativeQa", () => {
  it("passes when avg >= min avg and no score under the floor", () => {
    expect(decideCreativeQa(scores() as never, "s2", T)).toEqual({ pass: true, reasons: [] });
  });
  it("fails on a single score below the floor, naming dimension and weakest scene", () => {
    const d = decideCreativeQa(scores({ realism: 4 }) as never, "s2", T);
    expect(d.pass).toBe(false);
    expect(d.reasons.join("\n")).toMatch(/realism.*4/);
    expect(d.reasons.join("\n")).toMatch(/s2/);
  });
  it("fails on a low average even if no score is under the floor", () => {
    const d = decideCreativeQa(scores({ realism: 6, hook_strength: 6, brief_adherence: 6, visual_consistency: 6, advertising_quality: 6 }) as never, "s1", T);
    expect(d.pass).toBe(false);
    expect(d.reasons.join("\n")).toMatch(/average score 6\.0/);
  });
  it("passes exactly at the thresholds", () => {
    const d = decideCreativeQa(scores({ realism: 5, hook_strength: 9, brief_adherence: 9, visual_consistency: 6, advertising_quality: 6 }) as never, "s1", T);
    expect(d.pass).toBe(true);
  });
});

describe("loadCreativeQaThresholds", () => {
  it("defaults to 7 and 5", () => {
    expect(loadCreativeQaThresholds({})).toEqual(T);
  });
  it("reads env overrides", () => {
    expect(loadCreativeQaThresholds({ CREATIVE_QA_MIN_AVG: "8.5", CREATIVE_QA_MIN_SCORE: "6" })).toEqual({ minAvg: 8.5, minScore: 6 });
  });
  it("rejects garbage", () => {
    expect(() => loadCreativeQaThresholds({ CREATIVE_QA_MIN_AVG: "abc" })).toThrow(ConfigError);
  });
});

describe("creativeQaSchema", () => {
  const good = { scores: scores(), weakest_scene_id: "s2", issues: [], verdict_summary: "ok" };
  it("accepts a known scene id", () => {
    expect(creativeQaSchema(["s1", "s2"]).safeParse(good).success).toBe(true);
  });
  it("rejects an unknown weakest_scene_id", () => {
    const r = creativeQaSchema(["s1"]).safeParse(good);
    expect(r.success).toBe(false);
  });
  it("rejects non-integer or out-of-range scores", () => {
    expect(creativeQaSchema(["s2"]).safeParse({ ...good, scores: scores({ realism: 11 }) }).success).toBe(false);
    expect(creativeQaSchema(["s2"]).safeParse({ ...good, scores: scores({ realism: 7.5 }) }).success).toBe(false);
  });
});

describe("creativeQaPrompt", () => {
  it("tells the model the last frame is the end card and overlays are intentional", () => {
    const sb = storyboard([4, 4, 4]);
    const strategy = { angles: [{ name: "A", target_emotion: "e", hook: "h", concept: "c", cta: "x" }], selection: { selected_angle: "A", why_selected: "w", audience_insight: "i", why_it_performs: "p" } };
    const prompt = creativeQaPrompt({
      brief: {} as never,
      strategy: strategy as never,
      storyboard: sb,
      frames: [
        { t: 1, scene_id: "s1", path: "a.jpg" },
        { t: 13, scene_id: "end_card", path: "b.jpg" },
      ],
    });
    expect(prompt).toMatch(/2\. t=13\.00s, the end card \(brand \+ CTA\)/);
    expect(prompt).toMatch(/last frame is the end card/);
    expect(prompt).toMatch(/notification card .* intentional graphic overlay/);
  });
});
