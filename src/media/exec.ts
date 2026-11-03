import { execFile } from "node:child_process";

export class MediaError extends Error {
  override name = "MediaError";
  constructor(
    message: string,
    readonly stderr: string = "",
  ) {
    super(message);
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Runs a binary with an argv array (never a shell string). Rejects with MediaError on non-zero exit. */
export function exec(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const tail = stderr.trim().split("\n").slice(-6).join("\n");
        reject(
          new MediaError(
            code === "ENOENT" ? `${cmd} not found on PATH` : `${cmd} failed: ${tail || err.message}`,
            stderr,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export const ffmpeg = (args: string[]) => exec("ffmpeg", ["-hide_banner", "-y", ...args]);
export const ffprobe = (args: string[]) => exec("ffprobe", ["-hide_banner", ...args]);
