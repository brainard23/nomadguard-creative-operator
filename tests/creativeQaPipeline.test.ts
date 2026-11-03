import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBrief } from "../src/brief/load.ts";
import { JobStore } from "../src/jobs/jobStore.ts";
import { FakeLlmClient } from "../src/llm/fakeClient.ts";
import { DEFAULT_FIXTURES } from "../src/llm/fixtures.ts";
import { runPipeline } from "../src/pipeline/pipeline.ts";
import { MockVideoProvider } from "../src/video/mockProvider.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nomadguard-cqa-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const creative = (over: Record<string, number> = {}, weakest = "s2") => {
  const base = { realism: 9, visual_consistency: 9, brief_adherence: 9, hook_strength: 9, advertising_quality: 9, ...over };
  return {
    scores: Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { score: v, note: `${k} note` }])),
    weakest_scene_id: weakest,
    issues: ["minor"],
    verdict_summary: "summary",
  };
};

const run = async (llm: FakeLlmClient, extra: { skipCreativeQa?: boolean } = {}) => {
  const store = new JobStore(dir);
  const job = await runPipeline({ store, llm, brief: await loadBrief(), provider: new MockVideoProvider(), pollIntervalMs: 0, ...extra });
  const qa = JSON.parse(await readFile(join(store.runDir(job.runId), "qa.json"), "utf8"));
  return { job, qa, store };
};
const withFixture = (c: unknown, extra: Partial<ConstructorParameters<typeof FakeLlmClient>[0]> = {}) =>
  new FakeLlmClient({ fixtures: { ...DEFAULT_FIXTURES, creative_qa: c }, ...extra });

describe("creative QA in the pipeline", () => {
  it("high scores -> FINALIZED with creative scores and frames merged into qa.json", async () => {
    const llm = withFixture(creative());
    const { job, qa } = await run(llm);
    expect(job.state).toBe("FINALIZED");
    expect(qa.technical.valid).toBe(true);
    expect(qa.creative.scores.realism.score).toBe(9);
    expect(qa.creative.decision).toEqual({ pass: true, reasons: [] });
    expect(qa.creative.frames).toHaveLength(6);
    expect(qa.creative.frames[0]).toMatchObject({ scene_id: "s1" });
    expect(llm.calls.filter((c) => c.task === "creative_qa")).toMatchObject([{ images: 6 }]);
    expect(job.artifacts.final).toBe("final.mp4");
  });

  it("low score -> NEEDS_REVIEW naming the weakest scene, keeping final.mp4", async () => {
    const { job, qa } = await run(withFixture(creative({ hook_strength: 3 }, "s3")));
    expect(job.state).toBe("NEEDS_REVIEW");
    expect(job.error).toBeUndefined();
    expect(job.artifacts.final).toBe("final.mp4");
    expect(qa.creative.decision.pass).toBe(false);
    expect(qa.creative.decision.reasons.join("\n")).toMatch(/s3/);
    expect(qa.creative.decision.reasons.join("\n")).toMatch(/hook_strength/);
  });

  it("weakest_scene_id outside the storyboard triggers the repair path", async () => {
    const llm = withFixture(creative(), { invalidOutputs: { creative_qa: [JSON.stringify(creative({}, "s99"))] } });
    const { job } = await run(llm);
    expect(job.state).toBe("FINALIZED");
    const calls = llm.calls.filter((c) => c.task === "creative_qa");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toMatch(/weakest_scene_id/);
    expect(calls[1]!.images).toBe(6);
  });

  it("invalid vision JSON twice -> NEEDS_REVIEW 'creative QA unavailable', no crash", async () => {
    const { job, qa } = await run(withFixture(creative(), { invalidOutputs: { creative_qa: ["nope", "still nope"] } }));
    expect(job.state).toBe("NEEDS_REVIEW");
    expect(qa.technical.valid).toBe(true);
    expect(qa.creative.error).toMatch(/creative QA unavailable/);
    expect(qa.creative.decision.reasons[0]).toMatch(/^creative QA unavailable: /);
    expect(job.artifacts.final).toBe("final.mp4");
  });

  it("network failure -> NEEDS_REVIEW 'creative QA unavailable'", async () => {
    const { job, qa } = await run(withFixture(creative(), { failTasks: { creative_qa: new Error("ECONNRESET") } }));
    expect(job.state).toBe("NEEDS_REVIEW");
    expect(qa.creative.decision.reasons[0]).toMatch(/creative QA unavailable: .*ECONNRESET/);
  });

  it("--skip-creative-qa marks it in qa.json, makes no vision call and finalizes", async () => {
    const llm = new FakeLlmClient();
    const { job, qa } = await run(llm, { skipCreativeQa: true });
    expect(job.state).toBe("FINALIZED");
    expect(qa.creative).toEqual({ skipped: true });
    expect(llm.calls.some((c) => c.task === "creative_qa")).toBe(false);
  });

  it("default fake fixtures finalize offline", async () => {
    const { job } = await run(new FakeLlmClient());
    expect(job.state).toBe("FINALIZED");
  });
});
