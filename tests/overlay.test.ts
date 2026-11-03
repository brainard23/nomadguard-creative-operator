import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assemble, buildAssembleArgs } from "../src/assembly/assembler.ts";
import { normalizeStoryboard } from "../src/creative/normalizeStoryboard.ts";
import { StoryboardSchema } from "../src/creative/schemas.ts";
import { ffmpeg } from "../src/media/exec.ts";
import { renderNotificationPng } from "../src/media/textImage.ts";
import { probeClip } from "../src/media/probe.ts";
import { makeClip, storyboard } from "./support.ts";

const graphOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1]!;

describe("scene overlay + trimStart schema", () => {
  it("accepts storyboards without them and defaults overlay.at to 0.5", () => {
    expect(StoryboardSchema.safeParse(storyboard([4, 4, 4])).success).toBe(true);
    const sb = storyboard([4, 4, 4]);
    (sb.scenes[1] as Record<string, unknown>).overlay = { title: "Protected", body: "You are connected" };
    expect(StoryboardSchema.parse(sb).scenes[1]!.overlay).toEqual({ title: "Protected", body: "You are connected", at: 0.5 });
  });
});

describe("normalizeStoryboard overlay / trimStart", () => {
  it("clamps the overlay window inside the scene and trimStart to >= 0", () => {
    const sb = storyboard([4, 4, 4]);
    sb.scenes[1]!.overlay = { title: "t", body: "b", at: 9, duration: 30 };
    sb.scenes[2]!.overlay = { title: "t", body: "b", at: 1, duration: 10 };
    sb.scenes[2]!.trimStart = -2;
    const { storyboard: out, adjustments } = normalizeStoryboard(sb);
    expect(out.scenes[1]!.overlay).toEqual({ title: "t", body: "b", at: 3.5, duration: 0.5 });
    expect(out.scenes[2]!.overlay!.duration).toBe(3);
    expect(out.scenes[2]!.trimStart).toBe(0);
    expect(adjustments.join("\n")).toMatch(/overlay at 9s -> 3.5s/);
    expect(adjustments.join("\n")).toMatch(/trimStart -2s -> 0s/);
  });
  it("leaves a valid overlay and positive trimStart untouched, and does not mutate input", () => {
    const sb = storyboard([4, 4, 4]);
    sb.scenes[1]!.overlay = { title: "t", body: "b", at: 0.5, duration: 3 };
    sb.scenes[1]!.trimStart = 1.5;
    const copy = structuredClone(sb);
    const { storyboard: out, adjustments } = normalizeStoryboard(sb);
    expect(out).toEqual(copy);
    expect(adjustments).toEqual([]);
  });
  it("re-clamps against the snapped scene duration", () => {
    const sb = storyboard([5, 4, 4]); // 5 -> 4
    sb.scenes[0]!.overlay = { title: "t", body: "b", at: 0.5, duration: 4.5 };
    expect(normalizeStoryboard(sb).storyboard.scenes[0]!.overlay!.duration).toBe(3.5);
  });
});

describe("buildAssembleArgs overlay + trimStart", () => {
  const args = buildAssembleArgs({
    clips: [{ path: "a.mp4", seconds: 4 }, { path: "b.mp4", seconds: 6, trimStart: 1.5, overlay: { image: "o.png", at: 0.5, duration: 3 } }],
    endCardImage: "end.png",
    endCardSeconds: 2,
    output: "final.mp4",
  });
  const graph = graphOf(args);

  it("adds the overlay PNG as a looped input after the end card + silence inputs", () => {
    const i = args.indexOf("o.png");
    expect(args.slice(i - 7, i + 1)).toEqual(["-loop", "1", "-framerate", "30", "-t", "6", "-i", "o.png"]);
    expect(i).toBeGreaterThan(args.indexOf("end.png"));
    expect(args.filter((a) => a === "-i")).toHaveLength(5);
  });
  it("fades the PNG alpha and overlays it only inside its window, after scale/crop", () => {
    expect(graph).toContain("[4:v]format=rgba,fade=t=in:st=0.5:d=0.35:alpha=1,fade=t=out:st=3.15:d=0.35:alpha=1[o1]");
    expect(graph).toMatch(/\[1:v\]trim=start=1\.5:duration=6,setpts=PTS-STARTPTS,scale=1080:1920[^\[]*\[b1\]/);
    expect(graph).toContain("[b1][o1]overlay=0:0:format=auto:enable='between(t,0.5,3.5)',format=yuv420p[v1]");
    expect(graph).toContain("concat=n=3:v=1:a=1");
  });
  it("trims the audio from trimStart too", () => {
    expect(graph).toContain("atrim=start=1.5,asetpts=PTS-STARTPTS,apad,atrim=duration=6");
  });
  it("leaves clips without overlay/trimStart exactly as before", () => {
    expect(graph).toContain("[0:v]trim=duration=4,setpts=PTS-STARTPTS,scale=");
    expect(graph).toContain("[v0]");
    expect(graph).not.toContain("[b0]");
  });
});

describe("renderNotificationPng", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nomadguard-overlay-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renders a transparent 1080x1920 canvas with an opaque card in the upper third", async () => {
    const out = join(dir, "n.png");
    const box = await renderNotificationPng(out, { title: "Connection secured", body: "Your data is protected on public Wi-Fi" });
    const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([1080, 1920]);
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3]!;
    expect(alphaAt(5, 5)).toBe(0);
    expect(alphaAt(540, 1800)).toBe(0);
    expect(alphaAt(box.x + 20, box.y + box.height / 2)).toBeGreaterThan(200);
    expect(box.y + box.height).toBeLessThan(1920 / 3 + 100);
  });

  it("real ffmpeg render: overlay appears inside its window and not before it", async () => {
    const clip = join(dir, "clip.mp4");
    await makeClip(clip, { width: 540, height: 960, seconds: 4 });
    const out = join(dir, "final.mp4");
    await assemble({
      clips: [{ path: clip, seconds: 4, overlay: { title: "Connection secured", body: "Your data is protected on public Wi-Fi", at: 1, duration: 2 } }],
      endCard: { brand: "NomadGuard", headline: "Protected.", cta: "Get NomadGuard", duration: 2 },
      workDir: dir,
      output: out,
    });
    expect((await stat(out)).size).toBeGreaterThan(0);
    const frame = async (t: number, name: string) => {
      const p = join(dir, name);
      await ffmpeg(["-ss", String(t), "-i", out, "-frames:v", "1", "-q:v", "3", p]);
      return p;
    };
    const before = await frame(0.5, "before.jpg");
    const during = await frame(2, "during.jpg");
    const after = await frame(3.6, "after.jpg");
    // The card's green check icon (#34C759) sits at a known spot over the colour-bar test pattern.
    const iconPixel = async (p: string) => {
      const { data } = await sharp(p).extract({ left: 118, top: 330, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
      return { r: data[0]!, g: data[1]!, b: data[2]! };
    };
    const isGreen = ({ r, g, b }: { r: number; g: number; b: number }) => Math.abs(r - 52) < 25 && Math.abs(g - 199) < 25 && Math.abs(b - 89) < 25;
    expect(isGreen(await iconPixel(during))).toBe(true);
    expect(isGreen(await iconPixel(before))).toBe(false);
    expect(isGreen(await iconPixel(after))).toBe(false);
  }, 60_000);

  it("real ffmpeg render: trimStart skips the start of the clip", async () => {
    const clip = join(dir, "clip6.mp4");
    await makeClip(clip, { width: 270, height: 480, seconds: 6 });
    const out = join(dir, "trimmed.mp4");
    const { notes } = await assemble({
      clips: [{ path: clip, seconds: 4, trimStart: 1 }],
      endCard: { brand: "NomadGuard", headline: "Protected.", cta: "Get NomadGuard", duration: 2 },
      workDir: dir,
      output: out,
    });
    expect(notes).toEqual([]);
    expect((await probeClip(out)).duration).toBeCloseTo(6, 0);
    // A trimStart that leaves too little footage is used as-is and reported.
    const short = await assemble({
      clips: [{ path: clip, seconds: 4, trimStart: 4 }],
      endCard: { brand: "NomadGuard", headline: "Protected.", cta: "Get NomadGuard", duration: 2 },
      workDir: dir,
      output: join(dir, "short.mp4"),
    });
    expect(short.notes.join("\n")).toMatch(/\(starting at 4s\), shorter than the planned 4s/);
  }, 60_000);
});
