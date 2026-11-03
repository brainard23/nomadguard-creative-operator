import { access } from "node:fs/promises";
import { ffmpeg, ffprobe } from "../media/exec.ts";

export const QA_LIMITS = { minSeconds: 10, maxSeconds: 15, toleranceSeconds: 0.1, width: 1080, height: 1920 } as const;

export interface TechnicalReport {
  exists: boolean;
  playable: boolean;
  duration: number | null;
  width: number | null;
  height: number | null;
  aspect_ratio: string | null;
  codec: string | null;
  valid: boolean;
  reasons: string[];
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Never throws: every problem becomes a reason on the report. */
export async function technicalQa(path: string): Promise<TechnicalReport> {
  const report: TechnicalReport = {
    exists: false,
    playable: false,
    duration: null,
    width: null,
    height: null,
    aspect_ratio: null,
    codec: null,
    valid: false,
    reasons: [],
  };

  try {
    await access(path);
    report.exists = true;
  } catch {
    report.reasons.push(`file does not exist: ${path}`);
    return report;
  }

  try {
    const { stdout } = await ffprobe(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
    const probe = JSON.parse(stdout) as {
      streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
      format?: { duration?: string };
    };
    const video = probe.streams?.find((s) => s.codec_type === "video");
    if (!video) {
      report.reasons.push("not playable: no video stream found");
      return report;
    }
    report.codec = video.codec_name ?? null;
    report.width = video.width ?? null;
    report.height = video.height ?? null;
    const duration = Number.parseFloat(probe.format?.duration ?? "");
    report.duration = Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : null;
    if (report.width && report.height) {
      const g = gcd(report.width, report.height);
      report.aspect_ratio = `${report.width / g}:${report.height / g}`;
    }
  } catch (err) {
    report.reasons.push(`not playable: ffprobe could not read the file (${(err as Error).message})`);
    return report;
  }

  try {
    const { stderr } = await ffmpeg(["-v", "error", "-i", path, "-f", "null", "-"]);
    if (stderr.trim()) throw new Error(stderr.trim().split("\n")[0]);
    report.playable = true;
  } catch (err) {
    report.reasons.push(`not playable: decode errors (${(err as Error).message})`);
  }

  const { minSeconds, maxSeconds, toleranceSeconds, width, height } = QA_LIMITS;
  if (report.duration === null) {
    report.reasons.push("duration unknown");
  } else if (report.duration < minSeconds - toleranceSeconds || report.duration > maxSeconds + toleranceSeconds) {
    report.reasons.push(`duration ${report.duration.toFixed(2)}s is outside ${minSeconds}-${maxSeconds}s`);
  }
  if (report.width !== width || report.height !== height) {
    report.reasons.push(`resolution ${report.width}x${report.height}, expected ${width}x${height}`);
  }
  if (report.aspect_ratio !== "9:16") {
    report.reasons.push(`aspect ratio ${report.aspect_ratio}, expected 9:16`);
  }

  report.valid = report.reasons.length === 0 && report.playable;
  return report;
}
