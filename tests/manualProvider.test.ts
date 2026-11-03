import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { makeClip, RecordingProvider } from "./support.ts";

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

describe("awaiting-clips notes", () => {
  it("drops the stale note once the run moves past AWAITING_CLIPS", async () => {
    const job = await start();
    expect(job.notes.join("\n")).toMatch(/awaiting clips/);
    await drop(job.runId, "s1", "8s-audio.mp4");
    await drop(job.runId, "s2", "6s-silent.mp4");
    await drop(job.runId, "s3", "12s-long.mp4");
    const done = await resume(job.runId);
    expect(done.state).toBe("FINALIZED");
    expect(done.notes.join("\n")).not.toMatch(/awaiting clips/);
    expect(formatJobStatus(done, store.runDir(done.runId))).not.toMatch(/awaiting clips/);
  });

  it("keeps a single note listing only what is still missing", async () => {
    const job = await start();
    await drop(job.runId, "s1", "8s-audio.mp4");
    const again = await resume(job.runId);
    expect(again.notes.filter((n) => /awaiting clips/.test(n))).toHaveLength(1);
  });
});

describe("resume --redo / --reassemble", () => {
  const finalize = async () => {
    const job = await start();
    await drop(job.runId, "s1", "8s-audio.mp4");
    await drop(job.runId, "s2", "6s-silent.mp4");
    await drop(job.runId, "s3", "12s-long.mp4");
    const done = await resume(job.runId);
    expect(done.state).toBe("FINALIZED");
    return done.runId;
  };
  const run = (runId: string, extra: { redo?: string[]; reassemble?: boolean }, provider = new ManualImportProvider()) =>
    resumePipeline({ store, llm: new FakeLlmClient(), provider, runId, ...fast, ...extra });
  const clipSize = async (runId: string, scene: string) => (await stat(join(store.runDir(runId), "clips", `${scene}.mp4`))).size;

  it("--redo re-imports only that shot from the inbox and reassembles + re-runs QA", async () => {
    const runId = await finalize();
    const before = await clipSize(runId, "s2");
    const qaBefore = (await stat(store.artifactPath(runId, "qa"))).mtimeMs;
    await drop(runId, "s2", "8s-audio.mp4");
    const recording = new RecordingProvider(new ManualImportProvider());
    const done = await run(runId, { redo: ["s2"] }, recording as unknown as ManualImportProvider);
    expect(done.state).toBe("FINALIZED");
    expect(recording.generated).toEqual(["s2"]);
    expect(await clipSize(runId, "s2")).not.toBe(before);
    expect(done.shots.find((x) => x.sceneId === "s2")).toMatchObject({ state: "SUCCEEDED", attempts: 1 });
    expect(done.shots.find((x) => x.sceneId === "s1")!.attempts).toBe(1);
    expect((await stat(store.artifactPath(runId, "qa"))).mtimeMs).toBeGreaterThan(qaBefore);
    expect(done.notes.join("\n")).toMatch(/redo s2/);
  });

  it("--redo without a replacement clip resets the shot and parks AWAITING_CLIPS with final + QA removed", async () => {
    const runId = await finalize();
    await rm(join(store.runDir(runId), "inbox", "s2.mp4"));
    const parked = await run(runId, { redo: ["s2"] });
    expect(parked.state).toBe("AWAITING_CLIPS");
    const s2 = parked.shots.find((x) => x.sceneId === "s2")!;
    expect(s2.state).toBe("SUBMITTED"); // reset, then resubmitted and waiting on the inbox
    expect(s2.attempts).toBe(1);
    expect(s2.clipPath).toBeUndefined();
    expect(s2.error).toBeUndefined();
    expect(parked.artifacts.final).toBeUndefined();
    expect(parked.artifacts.qa).toBeUndefined();
    await expect(stat(store.artifactPath(runId, "final"))).rejects.toThrow();
    await expect(stat(join(store.runDir(runId), "clips", "s2.mp4"))).rejects.toThrow();
    expect(parked.notes.filter((n) => /awaiting clips/.test(n))).toEqual([expect.stringMatching(/awaiting clips for s2:/)]);
    await drop(runId, "s2", "6s-silent.mp4");
    expect((await run(runId, { redo: [] })).state).toBe("FINALIZED");
  });

  it("--redo accepts several scenes and rejects unknown ones without touching the run", async () => {
    const runId = await finalize();
    await expect(run(runId, { redo: ["s9"] })).rejects.toThrow(/no such shot/);
    expect((await store.get(runId)).state).toBe("FINALIZED");
    const done = await run(runId, { redo: ["s1", "s3"] });
    expect(done.state).toBe("FINALIZED");
    expect(done.shots.map((x) => x.attempts)).toEqual([1, 1, 1]);
  });

  it("--reassemble keeps every shot, picks up storyboard overlay + trimStart edits, from FINALIZED, NEEDS_REVIEW and FAILED", async () => {
    const runId = await finalize();
    const sbPath = store.artifactPath(runId, "storyboard");
    const sb = JSON.parse(await readFile(sbPath, "utf8"));
    sb.scenes[1].overlay = { title: "Connection secured", body: "Protected on public Wi-Fi", at: 0.5 };
    sb.scenes[0].trimStart = 1;
    await writeFile(sbPath, JSON.stringify(sb));
    const clipBefore = await clipSize(runId, "s1");
    for (const state of ["FINALIZED", "NEEDS_REVIEW", "FAILED"] as const) {
      await store.update(runId, { state, error: state === "FAILED" ? { stage: "qa", message: "boom" } : undefined });
      const recording = new RecordingProvider(new ManualImportProvider());
      const done = await run(runId, { reassemble: true }, recording as unknown as ManualImportProvider);
      expect(done.state).toBe("FINALIZED");
      expect(done.error).toBeUndefined();
      expect(recording.generated).toEqual([]);
      expect(done.shots.every((x) => x.attempts === 1)).toBe(true);
      expect(await clipSize(runId, "s1")).toBe(clipBefore);
      expect(done.artifacts.final).toBeDefined();
    }
    // overlay PNG was rendered into the run folder from storyboard.json
    expect((await stat(join(store.runDir(runId), "overlay_2.png"))).size).toBeGreaterThan(0);
  });

  it("a finished run without --redo/--reassemble is still left untouched", async () => {
    const runId = await finalize();
    const before = await store.get(runId);
    expect(await resume(runId)).toEqual(before);
  });
});
