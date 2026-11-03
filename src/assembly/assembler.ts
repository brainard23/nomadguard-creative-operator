import { join } from "node:path";
import { ffmpeg } from "../media/exec.ts";
import { probeClip } from "../media/probe.ts";
import { renderEndCardPng, type EndCardText } from "../media/textImage.ts";

export const OUTPUT = { width: 1080, height: 1920, fps: 30, maxSeconds: 15 } as const;

/** A clip with optional trim length and audio presence (both default to "as is" / has audio). */
export interface ClipSpec {
  path: string;
  /** Keep only this many seconds from the start of the clip. */
  seconds?: number;
  /** False: generate silence of `seconds` for this clip. */
  hasAudio?: boolean;
}

export interface AssembleSpec {
  clips: (string | ClipSpec)[];
  endCardImage: string;
  endCardSeconds: number;
  output: string;
}

/**
 * Pure: ffmpeg argv for clips + end card -> one MP4.
 * Each clip is scaled/cropped to 1080x1920 @30fps, audio normalized to 48kHz stereo; the end
 * card is a looped PNG with generated silence so the audio stream is continuous. Clips are
 * may be trimmed to `seconds`; a clip without audio (e.g. a Flow download) gets silence instead.
 */
export function buildAssembleArgs(spec: AssembleSpec): string[] {
  const { width, height, fps, maxSeconds } = OUTPUT;
  const args: string[] = [];
  const clips: ClipSpec[] = spec.clips.map((c) => (typeof c === "string" ? { path: c } : c));
  for (const clip of clips) args.push("-i", clip.path);
  args.push("-loop", "1", "-framerate", String(fps), "-t", String(spec.endCardSeconds), "-i", spec.endCardImage);
  args.push("-f", "lavfi", "-t", String(spec.endCardSeconds), "-i", "anullsrc=r=48000:cl=stereo");

  const total = clips.length + 1;
  const norm = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p`;
  const parts: string[] = [];
  const concatInputs: string[] = [];
  for (const [i, clip] of clips.entries()) {
    const trim = clip.seconds === undefined ? "" : `trim=duration=${clip.seconds},setpts=PTS-STARTPTS,`;
    parts.push(`[${i}:v]${trim}${norm}[v${i}]`);
    if (clip.hasAudio === false) {
      // No audio stream: silence for exactly the clip's (trimmed) length keeps concat in sync.
      parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${clip.seconds ?? 0}[a${i}]`);
    } else {
      // apad+atrim pins the audio to the video length even if the audio track is shorter.
      const fit = clip.seconds === undefined ? "" : `,apad,atrim=duration=${clip.seconds},asetpts=PTS-STARTPTS`;
      parts.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo${fit}[a${i}]`);
    }
    concatInputs.push(`[v${i}][a${i}]`);
  }
  const e = clips.length;
  parts.push(`[${e}:v]${norm}[v${e}]`);
  parts.push(`[${e + 1}:a]aformat=channel_layouts=stereo[a${e}]`);
  concatInputs.push(`[v${e}][a${e}]`);
  parts.push(`${concatInputs.join("")}concat=n=${total}:v=1:a=1[v][a]`);

  args.push(
    "-filter_complex", parts.join(";"),
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-r", String(fps),
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    "-t", String(maxSeconds),
    spec.output,
  );
  return args;
}

export interface AssembleInput {
  /** Clip paths in storyboard order; `seconds` is the planned shot duration. */
  clips: { path: string; seconds: number }[];
  endCard: EndCardText & { duration: number };
  workDir: string;
  output: string;
}

/**
 * Probes every clip, trims it to its planned duration (never pads: a shorter clip is used as-is
 * and reported in the returned notes), adds silence where there is no audio, and writes `output`.
 */
export async function assemble({ clips, endCard, workDir, output }: AssembleInput): Promise<{ notes: string[] }> {
  const notes: string[] = [];
  const specs: ClipSpec[] = [];
  for (const clip of clips) {
    const info = await probeClip(clip.path);
    const actual = Math.round(info.duration * 1000) / 1000;
    let seconds = clip.seconds;
    if (actual > 0 && actual < clip.seconds - 0.05) {
      seconds = actual;
      notes.push(`clip ${clip.path.split("/").pop()} is ${actual}s, shorter than the planned ${clip.seconds}s; used as-is`);
    }
    specs.push({ path: clip.path, seconds, hasAudio: info.hasAudio });
  }
  const endCardImage = join(workDir, "end_card.png");
  await renderEndCardPng(endCardImage, endCard);
  await ffmpeg(buildAssembleArgs({ clips: specs, endCardImage, endCardSeconds: endCard.duration, output }));
  return { notes };
}
