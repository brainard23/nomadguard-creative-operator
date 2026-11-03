import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBrief } from "../src/brief/load.ts";
import { FakeLlmClient } from "../src/llm/fakeClient.ts";
import { DEFAULT_FIXTURES } from "../src/llm/fixtures.ts";
import { JobStore, newRunId } from "../src/jobs/jobStore.ts";
import { runPlanning } from "../src/pipeline/planning.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nomadguard-runs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const readJson = async (p: string) => JSON.parse(await readFile(p, "utf8"));

describe("runPlanning", () => {
  it("takes a run from CREATED to PLANNED with all four artifacts", async () => {
    const store = new JobStore(dir);
    const brief = await loadBrief();
    const job = await runPlanning({ store, llm: new FakeLlmClient(), brief });

    expect(job.state).toBe("PLANNED");
    expect(job.error).toBeUndefined();

    const runDir = store.runDir(job.runId);
    expect((await readdir(runDir)).sort()).toEqual([
      "brief.json",
      "job.json",
      "prompts.json",
      "storyboard.json",
      "strategy.json",
    ]);
    const persisted = await readJson(join(runDir, "job.json"));
    expect(persisted.state).toBe("PLANNED");
    expect(Object.keys(persisted.artifacts).sort()).toEqual(["brief", "prompts", "storyboard", "strategy"]);

    const prompts = await readJson(join(runDir, "prompts.json"));
    expect(prompts.shots).toHaveLength(3);
    const strategy = await readJson(join(runDir, "strategy.json"));
    expect(strategy.angles.length).toBeGreaterThanOrEqual(3);
  });

  it("stores the normalized storyboard (off-spec durations are fixed)", async () => {
    const store = new JobStore(dir);
    const fixtures = structuredClone(DEFAULT_FIXTURES) as any;
    fixtures.storyboard.scenes[0].duration = 8;
    fixtures.storyboard.scenes[1].duration = 8;
    fixtures.storyboard.scenes[2].duration = 8;
    const job = await runPlanning({
      store,
      llm: new FakeLlmClient({ fixtures }),
      brief: await loadBrief(),
    });
    expect(job.state).toBe("PLANNED");
    const sb = await readJson(join(store.runDir(job.runId), "storyboard.json"));
    const t = sb.scenes.reduce((s: number, x: any) => s + x.duration, 0) + sb.end_card.duration;
    expect(t).toBeLessThanOrEqual(15);
  });

  it("ends FAILED with the stage and message when the strategist fails", async () => {
    const store = new JobStore(dir);
    const llm = new FakeLlmClient({ failTasks: { strategy: new Error("vertex exploded") } });
    const job = await runPlanning({ store, llm, brief: await loadBrief() });

    expect(job.state).toBe("FAILED");
    expect(job.error?.stage).toBe("strategy");
    expect(job.error?.message).toContain("vertex exploded");

    const persisted = await store.get(job.runId);
    expect(persisted.state).toBe("FAILED");
    expect(persisted.error?.stage).toBe("strategy");
    // brief was written before planning started; nothing after the failing stage
    expect(Object.keys(persisted.artifacts)).toEqual(["brief"]);
  });

  it("ends FAILED at the storyboard stage with details for an unusable storyboard", async () => {
    const store = new JobStore(dir);
    const fixtures = structuredClone(DEFAULT_FIXTURES) as any;
    fixtures.storyboard.scenes[0].purpose = "problem"; // no hook
    const job = await runPlanning({
      store,
      llm: new FakeLlmClient({ fixtures }),
      brief: await loadBrief(),
    });
    expect(job.state).toBe("FAILED");
    expect(job.error?.stage).toBe("storyboard");
    expect(job.error?.message).toMatch(/hook/);
    expect(Object.keys(job.artifacts).sort()).toEqual(["brief", "strategy"]);
  });
});

describe("JobStore", () => {
  it("creates job.json in CREATED state with no leftover tmp files", async () => {
    const store = new JobStore(dir);
    const job = await store.create();
    expect(job.state).toBe("CREATED");
    expect(await readdir(store.runDir(job.runId))).toEqual(["job.json"]);
    expect((await store.get(job.runId)).runId).toBe(job.runId);
  });

  it("generates run ids that sort by creation time", () => {
    const earlier = newRunId(new Date("2026-11-03T08:00:00Z"));
    const later = newRunId(new Date("2026-11-03T08:00:01Z"));
    expect(earlier).toMatch(/^20261103-080000-[0-9a-f]{6}$/);
    expect(earlier < later).toBe(true);
  });
});
