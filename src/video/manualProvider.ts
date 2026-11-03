import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { decodesCleanly, probeClip } from "../media/probe.ts";
import {
  VideoProviderError,
  type GenerateRequest,
  type ResultTarget,
  type VideoJobStatus,
  type VideoProvider,
} from "./types.ts";

const ID_PREFIX = "manual:";
const sceneOf = (providerJobId: string) => providerJobId.slice(ID_PREFIX.length);

/** The run's inbox is the sibling of its clips/ directory (runs/<id>/clips -> runs/<id>/inbox). */
export const inboxFor = (outputDir: string) => join(dirname(outputDir), "inbox");

const exists = (p: string) => stat(p).then(() => true, () => false);

/**
 * Free-path provider: no API. `generate` writes the prompt for a human to run in Google Flow,
 * the human drops `<sceneId>.mp4` into the run's inbox, and `getResult` validates and imports it.
 * Stateless: the job id is `manual:<sceneId>` and every path derives from the ResultTarget,
 * so it works across restarts and `resume`.
 */
export class ManualImportProvider implements VideoProvider {
  private readonly scenes = new Set<string>();
  /** Serializes README writes so concurrent `generate` calls never interleave. */
  private readme: Promise<void> = Promise.resolve();

  async generate(req: GenerateRequest): Promise<{ providerJobId: string }> {
    const inbox = inboxFor(req.outputDir);
    await mkdir(inbox, { recursive: true });
    await writeFile(join(inbox, `${req.sceneId}.prompt.md`), promptFile(req), "utf8");
    this.scenes.add(req.sceneId);
    this.readme = this.readme.then(() => writeReadme(inbox, this.scenes));
    await this.readme;
    return { providerJobId: `${ID_PREFIX}${req.sceneId}` };
  }

  async getStatus(providerJobId: string, target?: ResultTarget): Promise<VideoJobStatus> {
    if (!target) throw new VideoProviderError("manual provider needs the run's output directory to look for clips", { retryable: false, code: "NO_TARGET" });
    const file = join(inboxFor(target.outputDir), `${sceneOf(providerJobId)}.mp4`);
    if (await exists(file)) return { state: "succeeded" };
    return { state: "awaiting_input", message: `waiting for ${file}` };
  }

  async getResult(providerJobId: string, target: ResultTarget): Promise<{ clipPath: string }> {
    const source = join(inboxFor(target.outputDir), `${sceneOf(providerJobId)}.mp4`);
    const fail = (why: string) =>
      new VideoProviderError(`Invalid clip ${basename(source)} in the inbox (${source}): ${why}. Replace the file and resume.`, {
        retryable: false,
        code: "INVALID_CLIP",
      });
    let info;
    try {
      info = await probeClip(source);
    } catch {
      throw fail("ffprobe could not read it, is it a real mp4?");
    }
    if (!info.hasVideo) throw fail("no video stream");
    if (!(info.duration > 0)) throw fail("zero duration");
    if (!(await decodesCleanly(source).catch(() => false))) throw fail("decode errors, the file may be truncated or corrupt");

    await mkdir(target.outputDir, { recursive: true });
    const clipPath = join(target.outputDir, `${target.sceneId}.mp4`);
    await copyFile(source, clipPath);
    return { clipPath };
  }
}

/** Prompt + a final "Avoid:" sentence, as one paste-ready paragraph. */
export function pasteBlock(req: Pick<GenerateRequest, "prompt" | "negativePrompt">): string {
  const prompt = req.prompt.trim();
  const avoid = req.negativePrompt.trim().replace(/[\s.,;]+$/, "");
  return `${prompt}${/[.!?]$/.test(prompt) ? "" : "."} Avoid: ${avoid}. No on-screen text.`;
}

function promptFile(req: GenerateRequest): string {
  return `# Shot ${req.sceneId}

- Duration: ${req.durationSeconds}s
- Aspect ratio: ${req.aspectRatio} (vertical)
- Model: Veo 3.1 in Flow. Pick the closest length >= ${req.durationSeconds}s; it gets trimmed to the shot duration.
- Save the result as \`${req.sceneId}.mp4\` in this folder.

## Paste into Flow

Flow has no negative-prompt field, so the negative terms are folded into one block. Copy everything below:

\`\`\`
${pasteBlock(req)}
\`\`\`
`;
}

async function writeReadme(inbox: string, known: Set<string>): Promise<void> {
  const onDisk = (await readdir(inbox)).filter((f) => f.endsWith(".prompt.md")).map((f) => f.slice(0, -".prompt.md".length));
  const ids = [...new Set([...known, ...onDisk])].sort();
  await writeFile(
    join(inbox, "README.md"),
    `# Clip inbox

This run uses the manual provider: you make each shot by hand in Google Flow, then drop the files here.

## Steps

1. Open https://labs.google/flow and create a new project.
2. For each shot below, open its \`<sceneId>.prompt.md\` file and paste the prompt (it already ends with the "Avoid: ..." sentence, because Flow has no negative-prompt field).
3. Choose Veo 3.1, portrait / 9:16, and the closest length that is at least the shot duration (longer clips are trimmed automatically; a shorter clip is used as-is).
4. Download each result as MP4 and save it in THIS folder with the exact file name:

${ids.map((id) => `   - \`${id}.mp4\``).join("\n")}

5. Run the resume command the CLI printed, e.g. \`pnpm start resume <runId> --provider manual\`.
   Clips that are still missing pause the run again; anything present is picked up.

Clips with no audio track are fine (silence is added). A clip that cannot be read marks only that shot as failed; replace the file and resume.
`,
    "utf8",
  );
}
