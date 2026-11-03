import { exec, MediaError } from "./exec.ts";

/** Fails fast with a clear message when ffmpeg / ffprobe are not installed. */
export async function ensureMediaTools(): Promise<void> {
  for (const tool of ["ffmpeg", "ffprobe"]) {
    try {
      await exec(tool, ["-version"]);
    } catch {
      throw new MediaError(
        `${tool} was not found on PATH. Install ffmpeg (e.g. \`brew install ffmpeg\`) and try again.`,
      );
    }
  }
}
