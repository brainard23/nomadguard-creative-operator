import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { assemble } from "../src/assembly/assembler.ts";
import { loadBrief } from "../src/brief/load.ts";
import { formatJobStatus } from "../src/jobs/format.ts";
import { JobStore } from "../src/jobs/jobStore.ts";
import { FakeLlmClient } from "../src/llm/fakeClient.ts";
import { probeClip } from "../src/media/probe.ts";
import { resumePipeline, runPipeline } from "../src/pipeline/pipeline.ts";
import { technicalQa } from "../src/qa/technical.ts";
import { ManualImportProvider, pasteBlock } from "../src/video/manualProvider.ts";
import { makeClip } from "./support.ts";

let dir: string;
let fixtures: string;
let store: JobStore;
const clip = (name: string) => join(fixtures, name);

beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "nomadguard-manual-fixtures-"));
  await makeClip(clip("8s-audio.mp4"), { width: 270, height: 480, seconds: 8 });
  await makeClip(clip("6s-silent.mp4"), { width: 270, height: 480, seconds: 6, audio: false });
  await makeClip(clip("12s-long.mp4"), { width: 270, height: 480, seconds: 12 });
  await makeClip(clip("2s-short-silent.mp4"), { width: 270, height: 480, seconds: 2, audio: false });
}, 60_000);
afterAll(async () => {
  await rm(fixtures, { recursive: true, force: true });
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nomadguard-manual-"));
  store = new JobStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fast = { pollIntervalMs: 0, retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } };
const start = async () =>
  runPipeline({ store, llm: new FakeLlmClient(), brief: await loadBrief(), provider: new ManualImportProvider(), ...fast });
const resume = (runId: string) =>
  resumePipeline({ store, llm: new FakeLlmClient(), provider: new ManualImportProvider(), runId, ...fast });
const drop = (runId: string, scene: string, src: string) => copyFile(clip(src), join(store.runDir(runId), "inbox", `${scene}.mp4`));

describe("manual provider flow", () => {
  it("pauses AWAITING_CLIPS with prompt files and a README, then finalizes after clips arrive", async () => {
    const job = await start();
    expect(job.state).toBe("AWAITING_CLIPS");
    expect(job.error).toBeUndefined();
    expect(job.notes.join("\n")).toMatch(/awaiting clips for s1, s2, s3/);
    expect(formatJobStatus(job, store.runDir(job.runId))).toMatch(/resume .* --provider manual/);

    const inbox = join(store.runDir(job.runId), "inbox");
    const prompt = await readFile(join(inbox, "s1.prompt.md"), "utf8");
    expect(prompt).toMatch(/Duration: 4s/);
    expect(prompt).toMatch(/9:16/);
    expect(prompt).toMatch(/Veo 3\.1 in Flow/);
    expect(prompt).toMatch(/Avoid: text, captions.*\. No on-screen text\./);
    const readme = await readFile(join(inbox, "README.md"), "utf8");
    for (const id of ["s1", "s2", "s3"]) expect(readme).toContain(`${id}.mp4`);

    await drop(job.runId, "s1", "8s-audio.mp4");
    await drop(job.runId, "s2", "6s-silent.mp4");
    await drop(job.runId, "s3", "12s-long.mp4");
    const done = await resume(job.runId);

    expect(done.state).toBe("FINALIZED");
    expect(done.shots.map((s) => s.state)).toEqual(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]);
    const report = await technicalQa(store.artifactPath(job.runId, "final"));
    expect(report.valid).toBe(true);
    expect(report.duration).toBeGreaterThanOrEqual(10);
    expect(report.duration).toBeLessThanOrEqual(15);
    expect((await probeClip(store.artifactPath(job.runId, "final"))).hasAudio).toBe(true);
  });

  it("imports what is present and pauses again for the rest", async () => {
    const job = await start();
    await drop(job.runId, "s1", "8s-audio.mp4");
    const again = await resume(job.runId);
    expect(again.state).toBe("AWAITING_CLIPS");
    expect(again.shots.find((s) => s.sceneId === "s1")?.state).toBe("SUCCEEDED");
    expect(again.notes.at(-1)).toMatch(/awaiting clips for s2, s3/);
    expect(again.notes.at(-1)).not.toMatch(/s1/);
  });

  it("fails only the shot with a garbage file; fixing it and resuming finalizes", async () => {
    const job = await start();
    await drop(job.runId, "s1", "8s-audio.mp4");
    await writeFile(join(store.runDir(job.runId), "inbox", "s2.mp4"), "this is not a video");
    await drop(job.runId, "s3", "12s-long.mp4");

    const failed = await resume(job.runId);
    expect(failed.state).toBe("FAILED");
    expect(failed.error?.stage).toBe("generation");
    expect(failed.error?.message).toMatch(/s2.*Invalid clip s2\.mp4/);
    const byId = Object.fromEntries(failed.shots.map((s) => [s.sceneId, s]));
    expect(byId.s1!.state).toBe("SUCCEEDED");
    expect(byId.s3!.state).toBe("SUCCEEDED");
    expect(byId.s2).toMatchObject({ state: "FAILED", error: { retryable: false, code: "INVALID_CLIP" } });

    await drop(job.runId, "s2", "6s-silent.mp4");
    const fixed = await resume(job.runId);
    expect(fixed.state).toBe("FINALIZED");
  });
});

describe("pasteBlock", () => {
  it("folds the negative terms into one trailing Avoid sentence", () => {
    expect(pasteBlock({ prompt: "A shot.", negativePrompt: "text, blurry" })).toBe("A shot. Avoid: text, blurry. No on-screen text.");
    expect(pasteBlock({ prompt: "A shot", negativePrompt: "text." })).toBe("A shot. Avoid: text. No on-screen text.");
  });
});

describe("assembler with trimming and silent clips", () => {
  it("uses a shorter-than-planned clip as-is with a note, and still lands in 10-15s", async () => {
    const endCard = { duration: 2, headline: "H", cta: "C", brand: "B" };
    const out = join(dir, "out.mp4");
    const { notes } = await assemble({
      clips: [
        { path: clip("8s-audio.mp4"), seconds: 4 },
        { path: clip("6s-silent.mp4"), seconds: 4 },
        { path: clip("2s-short-silent.mp4"), seconds: 4 },
      ],
      endCard,
      workDir: dir,
      output: out,
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/2s-short-silent\.mp4.*shorter than the planned 4s/);
    const info = await probeClip(out);
    expect(info.hasAudio).toBe(true);
    expect(info.duration).toBeCloseTo(4 + 4 + 2 + 2, 0);
  });

  it("handles a clip without any audio stream", async () => {
    const out = join(dir, "silent.mp4");
    await assemble({ clips: [{ path: clip("6s-silent.mp4"), seconds: 5 }], endCard: { duration: 2, headline: "H", cta: "C", brand: "B" }, workDir: dir, output: out });
    const info = await probeClip(out);
    expect(info.hasAudio).toBe(true);
    expect(info.duration).toBeCloseTo(7, 0);
  });
});
