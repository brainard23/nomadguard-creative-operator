import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planFrameTimes, sampleFrames, sceneForTime } from "../src/qa/frames.ts";
import { makeClip, storyboard } from "./support.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nomadguard-frames-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sceneForTime", () => {
  const sb = storyboard([4, 4, 4], 2);
  it("maps timestamps to scene ids using storyboard durations", () => {
    expect(sceneForTime(sb, 0)).toBe("s1");
    expect(sceneForTime(sb, 3.99)).toBe("s1");
    expect(sceneForTime(sb, 4)).toBe("s2");
    expect(sceneForTime(sb, 11.5)).toBe("s3");
  });
  it("returns end_card at or after the last scene end", () => {
    expect(sceneForTime(sb, 12)).toBe("end_card");
    expect(sceneForTime(sb, 13.9)).toBe("end_card");
  });
});

describe("planFrameTimes", () => {
  it("includes a hook frame (<=1s) and one inside the last scene, sorted and distinct", () => {
    const sb = storyboard([4, 4, 4], 2);
    const ts = planFrameTimes(sb, 14, 6);
    expect(ts).toHaveLength(6);
    expect(ts[0]).toBeGreaterThanOrEqual(0.5);
    expect(ts[0]).toBeLessThanOrEqual(1);
    expect(ts.some((t) => sceneForTime(sb, t) === "s3")).toBe(true);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    expect(new Set(ts).size).toBe(6);
    expect(ts.every((t) => t > 0 && t < 14)).toBe(true);
  });
});

describe("sampleFrames", () => {
  it("extracts N spread JPEG frames from a real 12s clip", async () => {
    const clip = join(dir, "clip.mp4");
    await makeClip(clip, { width: 540, height: 960, seconds: 12 });
    const sb = storyboard([5, 5], 2);
    const frames = await sampleFrames(clip, join(dir, "frames"), sb, { count: 6 });
    expect(frames).toHaveLength(6);
    expect(frames[0]!.t).toBeLessThanOrEqual(1);
    expect(frames.at(-1)!.t).toBeGreaterThan(6);
    for (const f of frames) {
      expect(f.t).toBeGreaterThan(0);
      expect(f.t).toBeLessThan(12);
      expect((await stat(f.path)).size).toBeGreaterThan(0);
      expect(f.path).toMatch(/\.jpg$/);
    }
    expect(frames.map((f) => f.scene_id)).toContain("s2");
  });
});
