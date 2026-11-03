import { join } from "node:path";
import { ffmpeg } from "../media/exec.ts";
import { renderEndCardPng, type EndCardText } from "../media/textImage.ts";

export const OUTPUT = { width: 1080, height: 1920, fps: 30, maxSeconds: 15 } as const;

export interface AssembleSpec {
  clips: string[];
  endCardImage: string;
  endCardSeconds: number;
  output: string;
}

/**
 * Pure: ffmpeg argv for clips + end card -> one MP4.
 * Each clip is scaled/cropped to 1080x1920 @30fps, audio normalized to 48kHz stereo; the end
 * card is a looped PNG with generated silence so the audio stream is continuous. Clips are
 * assumed to carry an audio stream (Veo and the mock both do).
 */
export function buildAssembleArgs(spec: AssembleSpec): string[] {
  const { width, height, fps, maxSeconds } = OUTPUT;
  const args: string[] = [];
  for (const clip of spec.clips) args.push("-i", clip);
  args.push("-loop", "1", "-framerate", String(fps), "-t", String(spec.endCardSeconds), "-i", spec.endCardImage);
  args.push("-f", "lavfi", "-t", String(spec.endCardSeconds), "-i", "anullsrc=r=48000:cl=stereo");

  const total = spec.clips.length + 1;
  const norm = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p`;
  const parts: string[] = [];
  const concatInputs: string[] = [];
  for (let i = 0; i < spec.clips.length; i++) {
    parts.push(`[${i}:v]${norm}[v${i}]`);
    parts.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
    concatInputs.push(`[v${i}][a${i}]`);
  }
  const e = spec.clips.length;
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
  clips: string[];
  endCard: EndCardText & { duration: number };
  workDir: string;
  output: string;
}

export async function assemble({ clips, endCard, workDir, output }: AssembleInput): Promise<void> {
  const endCardImage = join(workDir, "end_card.png");
  await renderEndCardPng(endCardImage, endCard);
  await ffmpeg(buildAssembleArgs({ clips, endCardImage, endCardSeconds: endCard.duration, output }));
}
