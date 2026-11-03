import { ffmpeg, ffprobe } from "./exec.ts";

export interface ClipInfo {
  hasVideo: boolean;
  hasAudio: boolean;
  /** Seconds; 0 when unknown. */
  duration: number;
}

/** Throws MediaError when ffprobe cannot read the file at all. */
export async function probeClip(path: string): Promise<ClipInfo> {
  const { stdout } = await ffprobe(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
  const probe = JSON.parse(stdout) as { streams?: { codec_type?: string }[]; format?: { duration?: string } };
  const duration = Number.parseFloat(probe.format?.duration ?? "");
  return {
    hasVideo: probe.streams?.some((s) => s.codec_type === "video") ?? false,
    hasAudio: probe.streams?.some((s) => s.codec_type === "audio") ?? false,
    duration: Number.isFinite(duration) ? duration : 0,
  };
}

/** Full decode pass: true when ffmpeg reads the whole file without errors. */
export async function decodesCleanly(path: string): Promise<boolean> {
  const { stderr } = await ffmpeg(["-v", "error", "-i", path, "-f", "null", "-"]);
  return stderr.trim() === "";
}
