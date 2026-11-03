import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BaseLlmClient } from "../src/llm/baseClient.ts";
import { FakeLlmClient } from "../src/llm/fakeClient.ts";
import { LlmOutputError } from "../src/llm/types.ts";

const Schema = z.object({ answer: z.string(), n: z.number() });
const good = { answer: "ok", n: 1 };

describe("LlmClient validation + repair", () => {
  it("returns validated output on the first try", async () => {
    const llm = new FakeLlmClient({ fixtures: { t: good } });
    await expect(llm.generateJson("p", Schema, { task: "t" })).resolves.toEqual(good);
    expect(llm.calls).toHaveLength(1);
  });

  it("repairs invalid output once, feeding the error and bad output back", async () => {
    const llm = new FakeLlmClient({
      fixtures: { t: good },
      invalidOutputs: { t: ['{"answer": 5}'] },
    });
    await expect(llm.generateJson("p", Schema, { task: "t" })).resolves.toEqual(good);
    expect(llm.calls).toHaveLength(2);
    const repairPrompt = llm.calls[1]!.prompt;
    expect(repairPrompt).toContain("p");
    expect(repairPrompt).toContain('{"answer": 5}');
    expect(repairPrompt).toMatch(/answer/);
    expect(repairPrompt).toMatch(/n/);
  });

  it("repairs output that is not JSON at all", async () => {
    const llm = new FakeLlmClient({ fixtures: { t: good }, invalidOutputs: { t: ["sorry, no"] } });
    await expect(llm.generateJson("p", Schema, { task: "t" })).resolves.toEqual(good);
  });

  it("throws LlmOutputError with details after two invalid outputs", async () => {
    const llm = new FakeLlmClient({
      fixtures: { t: good },
      invalidOutputs: { t: ["nope", '{"answer": 1}'] },
    });
    const err = await llm.generateJson("p", Schema, { task: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmOutputError);
    expect((err as LlmOutputError).task).toBe("t");
    expect((err as LlmOutputError).rawOutput).toBe('{"answer": 1}');
    expect((err as LlmOutputError).issues).toMatch(/answer/);
    expect(llm.calls).toHaveLength(2);
  });
});

describe("generateJsonFromImages", () => {
  const img = { data: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" };
  it("validates, repairs once, and records the image count per call", async () => {
    const llm = new FakeLlmClient({ fixtures: { t: good }, invalidOutputs: { t: ["bad"] } });
    await expect(llm.generateJsonFromImages("p", [img, img], Schema, { task: "t" })).resolves.toEqual(good);
    expect(llm.calls.map((c) => c.images)).toEqual([2, 2]);
  });
  it("throws LlmOutputError after two invalid outputs", async () => {
    const llm = new FakeLlmClient({ fixtures: { t: good }, invalidOutputs: { t: ["a", "b"] } });
    await expect(llm.generateJsonFromImages("p", [img], Schema, { task: "t" })).rejects.toBeInstanceOf(LlmOutputError);
  });
  it("reads image bytes from a path", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const p = join(await mkdtemp(join(tmpdir(), "img-")), "a.jpg");
    await writeFile(p, "x");
    const llm = new FakeLlmClient({ fixtures: { t: good } });
    await expect(llm.generateJsonFromImages("p", [{ path: p, mimeType: "image/jpeg" }], Schema, { task: "t" })).resolves.toEqual(good);
    await expect(
      llm.generateJsonFromImages("p", [{ path: "/nonexistent.jpg", mimeType: "image/jpeg" }], Schema, { task: "t" }),
    ).rejects.toThrow();
  });
});

describe("transport retry", () => {
  class Flaky extends BaseLlmClient {
    calls = 0;
    constructor(private readonly errors: unknown[]) {
      super({ sleep: async () => undefined });
    }
    protected override async complete(): Promise<string> {
      this.calls++;
      const e = this.errors.shift();
      if (e) throw e;
      return JSON.stringify(good);
    }
  }
  const apiError = (status: number, text: string) => Object.assign(new Error(`{"error":{"code":${status},"status":"${text}"}}`), { status });

  it("retries a 503 UNAVAILABLE twice, then succeeds", async () => {
    const llm = new Flaky([apiError(503, "UNAVAILABLE"), apiError(503, "UNAVAILABLE")]);
    await expect(llm.generateJson("p", Schema)).resolves.toEqual(good);
    expect(llm.calls).toBe(3);
  });
  it("does not retry a 400", async () => {
    const llm = new Flaky([apiError(400, "INVALID_ARGUMENT")]);
    await expect(llm.generateJson("p", Schema)).rejects.toThrow(/INVALID_ARGUMENT/);
    expect(llm.calls).toBe(1);
  });
  it("gives up after 4 attempts", async () => {
    const llm = new Flaky(Array.from({ length: 6 }, () => apiError(429, "RESOURCE_EXHAUSTED")));
    await expect(llm.generateJson("p", Schema)).rejects.toThrow();
    expect(llm.calls).toBe(4);
  });
  it("retries network errors and does not spend the repair attempt on transport retries", async () => {
    const llm = new Flaky([new Error("fetch failed")]);
    await expect(llm.generateJson("p", Schema)).resolves.toEqual(good);
    expect(llm.calls).toBe(2);
  });
});
