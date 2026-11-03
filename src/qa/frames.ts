import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Storyboard } from "../creative/schemas.ts";
import { ffmpeg, ffprobe } from "../media/exec.ts";

export const END_CARD_ID = "end_card";
export const DEFAULT_FRAME_COUNT = 6;
const HOOK_SECONDS = 0.75;
const FRAME_WIDTH = 540;

export interface SampledFrame {
  t: number;
  scene_id: string;
  path: string;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Scene id covering time `t` per the storyboard durations; `end_card` once the scenes end. */
export function sceneForTime(storyboard: Storyboard, t: number): string {
  let start = 0;
  for (const scene of storyboard.scenes) {
    start += scene.duration;
    if (t < start) return scene.id;
  }
  return END_CARD_ID;
}

/**
 * Timestamps for `count` frames: evenly spread between them (never in the end card):
 * the first at the hook (~0.75s) and the last in the middle of the last scene.
 */
export function planFrameTimes(storyboard: Storyboard, videoDuration: number, count = DEFAULT_FRAME_COUNT): number[] {
  const last = storyboard.scenes.at(-1)!;
  const contentEnd = Math.min(storyboard.scenes.reduce((s, x) => s + x.duration, 0), videoDuration);
  const lastStart = contentEnd - last.duration;
  const maxT = videoDuration - 0.1;
  const clamp = (t: number) => Math.max(0.1, Math.min(t, maxT));

  const hook = clamp(Math.min(HOOK_SECONDS, contentEnd / 2));
  const lastMid = clamp(Math.max(lastStart, 0) + last.duration / 2);
  // Evenly spaced from the hook frame to the middle of the last scene.
  const times = Array.from({ length: count }, (_, i) => (count === 1 ? hook : hook + ((lastMid - hook) * i) / (count - 1)));
  return [...new Set(times.map(round))].sort((a, b) => a - b);
}

async function probeDuration(path: string): Promise<number> {
  const { stdout } = await ffprobe(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  const d = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`could not read the duration of ${path}`);
  return d;
}

/** Extracts small JPEG frames (540px wide, to keep vision tokens low) at the planned timestamps. */
export async function sampleFrames(
  videoPath: string,
  outDir: string,
  storyboard: Storyboard,
  opts: { count?: number } = {},
): Promise<SampledFrame[]> {
  await mkdir(outDir, { recursive: true });
  const duration = await probeDuration(videoPath);
  const times = planFrameTimes(storyboard, duration, opts.count ?? DEFAULT_FRAME_COUNT);
  return Promise.all(
    times.map(async (t, i) => {
      const path = join(outDir, `frame-${String(i + 1).padStart(2, "0")}.jpg`);
      await ffmpeg(["-ss", String(t), "-i", videoPath, "-frames:v", "1", "-vf", `scale=${FRAME_WIDTH}:-2`, "-q:v", "4", path]);
      return { t, scene_id: sceneForTime(storyboard, t), path };
    }),
  );
}
