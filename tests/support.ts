import type { Scene, Storyboard } from "../src/creative/schemas.ts";

export function scene(id: string, duration: number, purpose: Scene["purpose"] = "problem"): Scene {
  return {
    id,
    duration,
    description: `Scene ${id} description`,
    camera: "medium shot, slow push-in",
    purpose,
  };
}

export function storyboard(
  durations: number[],
  endCard = 2,
  overrides: Partial<Storyboard> = {},
): Storyboard {
  return {
    style_guide: {
      character: "a woman in her early thirties with shoulder-length dark hair",
      wardrobe: "a camel wool coat over a white tee",
      setting: "a modern international airport terminal at dusk",
      palette: "warm amber and deep navy",
      lens: "35mm anamorphic",
      grade: "soft teal-orange cinematic grade",
    },
    scenes: durations.map((d, i) => scene(`s${i + 1}`, d, i === 0 ? "hook" : "problem")),
    end_card: { duration: endCard, headline: "Protected.", cta: "Get NomadGuard" },
    ...overrides,
  };
}

export const total = (s: Storyboard) =>
  s.scenes.reduce((sum, x) => sum + x.duration, 0) + s.end_card.duration;

import { ffmpeg } from "../src/media/exec.ts";

/** Real ffmpeg-made test clip; `audio: false` produces a video-only file (like some Flow downloads). */
export async function makeClip(
  path: string,
  opts: { width: number; height: number; seconds: number; audio?: boolean },
): Promise<void> {
  const video = ["-f", "lavfi", "-i", `testsrc2=size=${opts.width}x${opts.height}:rate=15:duration=${opts.seconds}`];
  if (opts.audio === false) {
    await ffmpeg([...video, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", path]);
    return;
  }
  await ffmpeg([
    ...video,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${opts.seconds}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
  ]);
}

import type { GenerateRequest, ResultTarget, VideoJobStatus, VideoProvider } from "../src/video/types.ts";

/** Wraps a provider and records every call, so tests can assert what was (not) resubmitted. */
export class RecordingProvider implements VideoProvider {
  readonly generated: string[] = [];
  readonly polled: string[] = [];
  readonly sceneOf = new Map<string, string>();

  constructor(
    private readonly inner: VideoProvider,
    private readonly beforeStatus?: (providerJobId: string, sceneId: string) => Promise<void>,
  ) {}

  async generate(req: GenerateRequest) {
    this.generated.push(req.sceneId);
    const res = await this.inner.generate(req);
    this.sceneOf.set(res.providerJobId, req.sceneId);
    return res;
  }

  async getStatus(id: string, target?: ResultTarget): Promise<VideoJobStatus> {
    this.polled.push(id);
    await this.beforeStatus?.(id, this.sceneOf.get(id) ?? "?");
    return this.inner.getStatus(id, target);
  }

  getResult(id: string, target: ResultTarget) {
    return this.inner.getResult(id, target);
  }
}
