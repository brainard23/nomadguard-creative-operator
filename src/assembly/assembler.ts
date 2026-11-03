import { join } from "node:path";
import { ffmpeg } from "../media/exec.ts";
import { probeClip } from "../media/probe.ts";
import type { Scene } from "../creative/schemas.ts";
import { renderEndCardPng, renderNotificationPng, type EndCardText } from "../media/textImage.ts";

export const OUTPUT = { width: 1080, height: 1920, fps: 30, maxSeconds: 15 } as const;

/** A clip with optional trim length and audio presence (both default to "as is" / has audio). */
export interface ClipSpec {
  path: string;
  /** Keep only this many seconds from the start of the clip. */
  seconds?: number;
  /** False: generate silence of `seconds` for this clip. */
  hasAudio?: boolean;
  /** Skip this many seconds at the start of the clip before `seconds` is measured. */
  trimStart?: number;
  /** Transparent full-frame PNG shown from `at` for `duration` seconds (relative to the trimmed clip). */
  overlay?: { image: string; at: number; duration: number };
}

/** Seconds the overlay takes to fade in and out. */
const OVERLAY_FADE = 0.35;

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

  // Overlay PNG inputs come after the end card + silence inputs so those indexes stay stable.
  const overlayInput = new Map<number, number>();
  for (const [i, clip] of clips.entries()) {
    if (!clip.overlay) continue;
    overlayInput.set(i, clips.length + 2 + overlayInput.size);
    const length = clip.seconds === undefined ? clip.overlay.at + clip.overlay.duration : clip.seconds;
    args.push("-loop", "1", "-framerate", String(fps), "-t", String(length), "-i", clip.overlay.image);
  }

  const total = clips.length + 1;
  const norm = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p`;
  const parts: string[] = [];
  const concatInputs: string[] = [];
  for (const [i, clip] of clips.entries()) {
    const start = clip.trimStart && clip.trimStart > 0 ? clip.trimStart : 0;
    const trimArgs = [start > 0 ? `start=${start}` : "", clip.seconds === undefined ? "" : `duration=${clip.seconds}`].filter(Boolean);
    const trim = trimArgs.length ? `trim=${trimArgs.join(":")},setpts=PTS-STARTPTS,` : "";
    const ov = clip.overlay;
    const oi = overlayInput.get(i);
    if (ov && oi !== undefined) {
      const end = ov.at + ov.duration;
      // Fade the PNG's alpha so the card eases in/out; `enable` keeps it strictly inside its window.
      parts.push(`[${oi}:v]format=rgba,fade=t=in:st=${ov.at}:d=${OVERLAY_FADE}:alpha=1,fade=t=out:st=${Math.max(ov.at, end - OVERLAY_FADE)}:d=${OVERLAY_FADE}:alpha=1[o${i}]`);
      parts.push(`[${i}:v]${trim}${norm}[b${i}]`);
      parts.push(`[b${i}][o${i}]overlay=0:0:format=auto:enable='between(t,${ov.at},${end})',format=yuv420p[v${i}]`);
    } else {
      parts.push(`[${i}:v]${trim}${norm}[v${i}]`);
    }
    if (clip.hasAudio === false) {
      // No audio stream: silence for exactly the clip's (trimmed) length keeps concat in sync.
      parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${clip.seconds ?? 0}[a${i}]`);
    } else {
      // apad+atrim pins the audio to the video length even if the audio track is shorter.
      const skip = start > 0 ? `,atrim=start=${start},asetpts=PTS-STARTPTS` : "";
      const fit = clip.seconds === undefined ? "" : `,apad,atrim=duration=${clip.seconds},asetpts=PTS-STARTPTS`;
      parts.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo${skip}${fit}[a${i}]`);
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
  clips: { path: string; seconds: number; trimStart?: number; overlay?: Pick<NonNullable<Scene["overlay"]>, "title" | "body"> & { at: number; duration?: number } }[];
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
  for (const [i, clip] of clips.entries()) {
    const info = await probeClip(clip.path);
    const actual = Math.round(info.duration * 1000) / 1000;
    const trimStart = Math.max(0, clip.trimStart ?? 0);
    const available = actual - trimStart;
    let seconds = clip.seconds;
    if (actual > 0 && available < clip.seconds - 0.05) {
      seconds = Math.max(0.1, Math.round(available * 1000) / 1000);
      notes.push(`clip ${clip.path.split("/").pop()} is ${actual}s${trimStart ? ` (starting at ${trimStart}s)` : ""}, shorter than the planned ${clip.seconds}s; used as-is`);
    }
    const spec: ClipSpec = { path: clip.path, seconds, hasAudio: info.hasAudio };
    if (trimStart > 0) spec.trimStart = trimStart;
    if (clip.overlay) {
      const at = Math.min(Math.max(0, clip.overlay.at), Math.max(0, seconds - 0.1));
      const duration = Math.min(clip.overlay.duration ?? seconds - at, seconds - at);
      const image = join(workDir, `overlay_${i + 1}.png`);
      await renderNotificationPng(image, clip.overlay);
      spec.overlay = { image, at, duration };
    }
    specs.push(spec);
  }
  const endCardImage = join(workDir, "end_card.png");
  await renderEndCardPng(endCardImage, endCard);
  await ffmpeg(buildAssembleArgs({ clips: specs, endCardImage, endCardSeconds: endCard.duration, output }));
  return { notes };
}
