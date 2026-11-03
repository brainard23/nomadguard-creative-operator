import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBrief } from "../src/brief/load.ts";
import { formatJobStatus, formatRunList } from "../src/jobs/format.ts";
import type { Job } from "../src/jobs/types.ts";
import { JobStore } from "../src/jobs/jobStore.ts";
import { FakeLlmClient } from "../src/llm/fakeClient.ts";
import { resumePipeline, runPipeline, runStages } from "../src/pipeline/pipeline.ts";
import type { PipelineContext, Stage } from "../src/pipeline/types.ts";
import { MockVideoProvider, type MockProviderOptions } from "../src/video/mockProvider.ts";
import { RecordingProvider } from "./support.ts";

let dir: string;
let store: JobStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nomadguard-resilience-"));
  store = new JobStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fast = { pollIntervalMs: 0, retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } };
const shot = (job: Job, id: string) => job.shots.find((s) => s.sceneId === id)!;

async function run(provider: RecordingProvider, llm = new FakeLlmClient(), extra: object = {}) {
  return runPipeline({ store, llm, brief: await loadBrief(), provider, ...fast, ...extra });
}
const mock = (o: MockProviderOptions) => new RecordingProvider(new MockVideoProvider(o));

describe("transient failures", () => {
  it("retries a retryable provider failure and finalizes with attempts=2", async () => {
    const provider = mock({ failures: { s2: ["transient"] } });
    const job = await run(provider);

    expect(job.state).toBe("FINALIZED");
    expect(shot(job, "s2")).toMatchObject({ state: "SUCCEEDED", attempts: 2 });
    expect(shot(job, "s2").error).toMatchObject({ code: "MOCK_TRANSIENT", retryable: true }); // last error is kept
    expect(shot(job, "s1").attempts).toBe(1);
    expect(provider.generated.filter((s) => s === "s2")).toHaveLength(2);
  });

  it("retries a thrown 503 from getStatus by polling again, then resubmits if it keeps failing", async () => {
    const provider = mock({ failures: { s3: ["network"] } });
    const job = await run(provider);
    expect(job.state).toBe("FINALIZED");
    expect(shot(job, "s3").attempts).toBe(2);
  });

  it("fails after maxAttempts when every attempt is transient", async () => {
    const provider = mock({ failures: { s2: ["transient", "transient", "transient"] } });
    const job = await run(provider);
    expect(job.state).toBe("FAILED");
    expect(job.error?.stage).toBe("generation");
    expect(job.error?.message).toMatch(/Shot s2 failed after 3 attempts/);
    expect(shot(job, "s2")).toMatchObject({ state: "FAILED", attempts: 3 });
  });
});

describe("permanent failures", () => {
  it("fails the run with stage, shot and provider reason, without retrying", async () => {
    const provider = mock({ failures: { s2: ["permanent"] } });
    const job = await run(provider);

    expect(job.state).toBe("FAILED");
    expect(job.error?.stage).toBe("generation");
    expect(job.error?.message).toContain("s2");
    expect(job.error?.message).toContain("rejected by safety filter");
    expect(job.error?.details).toMatchObject({ sceneId: "s2", attempts: 1, retryable: false, code: "MOCK_SAFETY" });
    expect(shot(job, "s2")).toMatchObject({ state: "FAILED", attempts: 1 });
    expect(provider.generated.filter((s) => s === "s2")).toHaveLength(1);
  });

  it("lets the other shots finish and saves them, then resume only redoes the failed shot", async () => {
    const failing = mock({ failures: { s2: ["permanent"] } });
    const failed = await run(failing);
    expect(shot(failed, "s1").state).toBe("SUCCEEDED");
    expect(shot(failed, "s3").state).toBe("SUCCEEDED");

    const fixed = new RecordingProvider(new MockVideoProvider());
    const llm = new FakeLlmClient();
    const job = await resumePipeline({ store, runId: failed.runId, llm, provider: fixed, ...fast });

    expect(job.state).toBe("FINALIZED");
    expect(job.error).toBeUndefined();
    expect(fixed.generated).toEqual(["s2"]); // s1 and s3 are not regenerated
    expect(llm.calls).toHaveLength(0); // planning is not redone
    expect(shot(job, "s2")).toMatchObject({ state: "SUCCEEDED", attempts: 1 }); // fresh attempt budget
    expect(job.notes.join("\n")).toMatch(/resumed after failure in stage "generation"/);
  });
});

describe("crash and resume", () => {
  it("skips finished shots and re-polls a submitted job instead of resubmitting it", async () => {
    // Process 1: s1 and s3 finish; the process is interrupted while s2 is still being generated.
    const inner = new MockVideoProvider({ pollsBeforeDone: { s1: 0, s2: 3, s3: 0 } });
    const controller = new AbortController();
    const served = new Set<string>();
    const crashing = new RecordingProvider(
      {
        generate: (r) => inner.generate(r),
        getStatus: (id) => inner.getStatus(id),
        getResult: async (id, t) => {
          const res = await inner.getResult(id, t);
          served.add(res.clipPath);
          return res;
        },
      },
      async (_id, sceneId) => {
        if (sceneId !== "s2") return;
        while (![...served].some((p) => p.endsWith("s1.mp4")) || ![...served].some((p) => p.endsWith("s3.mp4"))) {
          await new Promise((r) => setTimeout(r, 5));
        }
        controller.abort(); // "kill -INT" mid-generation
      },
    );
    const crashed = await run(crashing, new FakeLlmClient(), { signal: controller.signal });

    expect(crashed.state).toBe("GENERATING"); // not FAILED: resumable as-is
    expect(crashed.notes.join("\n")).toMatch(/interrupted during "generation"/);
    expect(shot(crashed, "s1").state).toBe("SUCCEEDED");
    expect(shot(crashed, "s3").state).toBe("SUCCEEDED");
    const s2 = shot(crashed, "s2");
    expect(["SUBMITTED", "RUNNING"]).toContain(s2.state);
    expect(s2.providerJobId).toBeTruthy();

    // Process 2: a fresh run of the CLI. The provider remembers the job id it handed out.
    const resumed = new RecordingProvider(inner);
    resumed.sceneOf.set(s2.providerJobId!, "s2");
    const llm = new FakeLlmClient();
    const job = await resumePipeline({ store, runId: crashed.runId, llm, provider: resumed, ...fast });

    expect(job.state).toBe("FINALIZED");
    expect(resumed.generated).toEqual([]); // nothing resubmitted, nothing regenerated
    expect(new Set(resumed.polled)).toEqual(new Set([s2.providerJobId])); // only the pending job was polled
    expect(shot(job, "s2")).toMatchObject({ state: "SUCCEEDED", attempts: 1, providerJobId: s2.providerJobId });
    expect(llm.calls).toHaveLength(0);
  });

  it("resume on a FINALIZED run changes nothing", async () => {
    const done = await run(mock({}));
    const provider = mock({});
    const again = await resumePipeline({ store, runId: done.runId, llm: new FakeLlmClient(), provider, ...fast });
    expect(again).toEqual(done);
    expect(provider.generated).toEqual([]);
  });

  it("resume after a QA failure reruns only QA and later stages (generation and assembly are skipped)", async () => {
    const inner = new MockVideoProvider();
    const tooShort = new RecordingProvider({
      generate: (r) => inner.generate({ ...r, durationSeconds: 1 }),
      getStatus: (id) => inner.getStatus(id),
      getResult: (id, t) => inner.getResult(id, t),
    });
    const failed = await run(tooShort);
    expect(failed.error?.stage).toBe("qa");

    const provider = mock({});
    const job = await resumePipeline({ store, runId: failed.runId, llm: new FakeLlmClient(), provider, ...fast });
    expect(provider.generated).toEqual([]);
    expect(job.state).toBe("FAILED"); // same out-of-spec video, so QA fails again, with a clear reason
    expect(job.error?.stage).toBe("qa");
  });
});

describe("unexpected errors", () => {
  it("lands the job in FAILED with the message when a stage throws something unexpected", async () => {
    const created = await store.create();
    const boom: Stage = {
      name: "boom",
      state: "PLANNING",
      async run() {
        throw new TypeError("cannot read properties of undefined");
      },
    };
    const ctx = { store, runId: created.runId } as PipelineContext;
    const job = await runStages(ctx, [boom]);
    expect(job.state).toBe("FAILED");
    expect(job.error).toMatchObject({ stage: "boom", message: "cannot read properties of undefined" });
    expect((await store.get(created.runId)).state).toBe("FAILED");
  });

  it("records a non-Error throw too", async () => {
    const created = await store.create();
    const stage: Stage = { name: "weird", state: "PLANNING", run: () => Promise.reject("just a string") };
    const job = await runStages({ store, runId: created.runId } as PipelineContext, [stage]);
    expect(job.error?.message).toBe("just a string");
  });
});

describe("status formatting", () => {
  it("shows state, failure, per-shot attempts/last error and artifacts", async () => {
    const job = await run(mock({ failures: { s2: ["permanent"] } }));
    const text = formatJobStatus(job, store.runDir(job.runId));
    expect(text).toContain("FAILED");
    expect(text).toMatch(/stage "generation"/);
    expect(text).toMatch(/s2\s+FAILED\s+attempts=1/);
    expect(text).toMatch(/last error: .*safety filter.*\(permanent\)/);
    expect(text).toMatch(/s1\s+SUCCEEDED/);
    expect(text).toContain("prompts");
    expect(text).toContain(`resume ${job.runId}`);
  });

  it("lists recent runs newest first", async () => {
    const a = await store.create();
    await new Promise((r) => setTimeout(r, 1100));
    const b = await store.create();
    const listed = await store.list(5);
    expect(listed.map((j) => j.runId)).toEqual([b.runId, a.runId]);
    expect(formatRunList(listed).split("\n")[0]).toContain(b.runId);
    expect(formatRunList([])).toBe("No runs found.");
  });
});
