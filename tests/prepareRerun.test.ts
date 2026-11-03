import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobStore } from "../src/jobs/jobStore.ts";
import { prepareRerun } from "../src/pipeline/pipeline.ts";

let dir: string;
let store: JobStore;
let runId: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nomadguard-rerun-"));
  store = new JobStore(dir);
  runId = (await store.create()).runId;
  await mkdir(join(store.runDir(runId), "clips"));
  for (const f of ["clips/s1.mp4", "clips/s2.mp4", "final.mp4", "qa.json"]) await writeFile(join(store.runDir(runId), f), "x");
  await store.updateShot(runId, "s1", { state: "SUCCEEDED", attempts: 1, providerJobId: "manual:s1", clipPath: "clips/s1.mp4" });
  await store.updateShot(runId, "s2", { state: "FAILED", attempts: 3, providerJobId: "manual:s2", clipPath: "clips/s2.mp4", error: { message: "bad" } });
  await store.registerArtifact(runId, "final");
  await store.registerArtifact(runId, "qa");
  await store.update(runId, { state: "FAILED", error: { stage: "qa", message: "boom" } });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const exists = (p: string) => stat(p).then(() => true, () => false);

describe("prepareRerun", () => {
  it("resets only the redone shot, deletes its clip, final and qa, and parks the job at PLANNED", async () => {
    const job = await prepareRerun(store, runId, ["s2"], false);
    expect(job.state).toBe("PLANNED");
    expect(job.error).toBeUndefined();
    expect(job.shots.find((s) => s.sceneId === "s2")).toEqual({ sceneId: "s2", state: "PENDING", attempts: 0 });
    expect(job.shots.find((s) => s.sceneId === "s1")).toMatchObject({ state: "SUCCEEDED", clipPath: "clips/s1.mp4" });
    expect(job.artifacts).not.toHaveProperty("final");
    expect(job.artifacts).not.toHaveProperty("qa");
    expect(await exists(join(store.runDir(runId), "clips/s2.mp4"))).toBe(false);
    expect(await exists(join(store.runDir(runId), "clips/s1.mp4"))).toBe(true);
    expect(await exists(store.artifactPath(runId, "final"))).toBe(false);
    expect(job.notes.at(-1)).toMatch(/redo s2/);
  });

  it("reassemble alone leaves every shot alone", async () => {
    const job = await prepareRerun(store, runId, [], true);
    expect(job.shots.map((s) => s.state)).toEqual(["SUCCEEDED", "FAILED"]);
    expect(job.notes.at(-1)).toMatch(/reassemble/);
  });

  it("throws for an unknown scene before changing anything", async () => {
    await expect(prepareRerun(store, runId, ["s1", "s7"], false)).rejects.toThrow(/Cannot redo s7/);
    expect((await store.get(runId)).state).toBe("FAILED");
    expect(await exists(join(store.runDir(runId), "clips/s1.mp4"))).toBe(true);
  });
});
