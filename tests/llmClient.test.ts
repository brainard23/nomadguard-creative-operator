import { describe, expect, it } from "vitest";
import { z } from "zod";
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
