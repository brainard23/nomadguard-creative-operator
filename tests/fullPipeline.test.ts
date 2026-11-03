import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBrief } from "../src/brief/load.ts";
import { JobStore } from "../src/jobs/jobStore.ts";
import { FakeLlmClient } from "../src/llm/fakeClient.ts";
import { runPipeline } from "../src/pipeline/pipeline.ts";
import { technicalQa } from "../src/qa/technical.ts";
import { MockVideoProvider } from "../src/video/mockProvider.ts";
import type { VideoProvider } from "../src/video/types.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nomadguard-e2e-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = async (provider: VideoProvider) =>
  runPipeline({ store: new JobStore(dir), llm: new FakeLlmClient(), brief: await loadBrief(), provider, pollIntervalMs: 0 });

describe("full pipeline with the mock provider", () => {
  it("ends FINALIZED with a QA-valid final.mp4 and every shot succeeded", async () => {
    const job = await run(new MockVideoProvider({ pollsBeforeDone: 2 }));
    expect(job.state).toBe("FINALIZED");
    expect(job.error).toBeUndefined();
    expect(job.shots).toHaveLength(3);
    for (const shot of job.shots) {
      expect(shot).toMatchObject({ state: "SUCCEEDED", attempts: 1 });
      expect(shot.providerJobId).toMatch(/^mock-/);
      expect(shot.clipPath).toBe(`clips/${shot.sceneId}.mp4`);
    }
    expect(Object.keys(job.artifacts).sort()).toEqual(["brief", "final", "prompts", "qa", "storyboard", "strategy"]);

    const runDir = new JobStore(dir).runDir(job.runId);
    const report = await technicalQa(join(runDir, "final.mp4"));
    expect(report.valid).toBe(true);
    expect(report.duration).toBeCloseTo(14, 0);
    const qa = JSON.parse(await readFile(join(runDir, "qa.json"), "utf8"));
    expect(qa.technical.valid).toBe(true);
    const persisted = JSON.parse(await readFile(join(runDir, "job.json"), "utf8"));
    expect(persisted.state).toBe("FINALIZED");
  });

  it("fails the run at the generation stage, naming the shot, on a provider failure", async () => {
    const job = await run(
      new MockVideoProvider({ failures: { s2: { message: "blocked by safety filter", retryable: false, code: "SAFETY" } } }),
    );
    expect(job.state).toBe("FAILED");
    expect(job.error?.stage).toBe("generation");
    expect(job.error?.message).toMatch(/s2.*blocked by safety filter/);
    expect(job.shots.find((s) => s.sceneId === "s2")).toMatchObject({ state: "FAILED", error: { retryable: false, code: "SAFETY" } });
  });

  it("fails at the qa stage with reasons when the final video is out of spec", async () => {
    const inner = new MockVideoProvider();
    const tooShort: VideoProvider = {
      generate: (req) => inner.generate({ ...req, durationSeconds: 1 }),
      getStatus: (id) => inner.getStatus(id),
      getResult: (id, target) => inner.getResult(id, target),
    };
    const job = await run(tooShort);
    expect(job.state).toBe("FAILED");
    expect(job.error?.stage).toBe("qa");
    expect(job.error?.message).toMatch(/duration .* outside 10-15s/);
    expect(job.artifacts.qa).toBe("qa.json");
  });
});
