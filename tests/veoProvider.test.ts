import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadVeoConfig } from "../src/config.ts";
import { classifyVeoError } from "../src/video/veoErrors.ts";
import { VeoVideoProvider, type VeoClient, type VeoOperation } from "../src/video/veoProvider.ts";

const OP = "projects/p/locations/us-central1/publishers/google/models/veo-3.1-generate-001/operations/abc-123";
const config = { project: "p", location: "us-central1", model: "veo-3.1-generate-001", resolution: "1080p", maxConcurrency: 2 };

function stubClient(op: VeoOperation | (() => VeoOperation)) {
  const calls = { generate: [] as unknown[], get: [] as string[] };
  const client: VeoClient = {
    async generateVideos(params) {
      calls.generate.push(params);
      return { name: OP };
    },
    async getVideosOperation(name) {
      calls.get.push(name);
      return typeof op === "function" ? op() : op;
    },
  };
  return { client, calls };
}

const req = async () => ({
  sceneId: "s1",
  prompt: "a prompt",
  negativePrompt: "no text",
  durationSeconds: 6,
  aspectRatio: "9:16" as const,
  outputDir: await mkdtemp(join(tmpdir(), "veo-")),
});

describe("VeoVideoProvider", () => {
  it("submits model, prompt and config and returns the operation name", async () => {
    const { client, calls } = stubClient({ done: false });
    const provider = new VeoVideoProvider(config, client);
    await expect(provider.generate(await req())).resolves.toEqual({ providerJobId: OP });
    expect(calls.generate[0]).toEqual({
      model: "veo-3.1-generate-001",
      prompt: "a prompt",
      config: {
        aspectRatio: "9:16",
        durationSeconds: 6,
        negativePrompt: "no text",
        generateAudio: true,
        numberOfVideos: 1,
        resolution: "1080p",
        personGeneration: "allow_adult",
      },
    });
  });

  it("polls from a bare operation name in a fresh provider", async () => {
    const { client, calls } = stubClient({ done: false });
    const status = await new VeoVideoProvider(config, client).getStatus(OP);
    expect(status).toEqual({ state: "running" });
    expect(calls.get).toEqual([OP]);
  });

  it("reports success when done with a video", async () => {
    const { client } = stubClient({ done: true, response: { generatedVideos: [{ video: { videoBytes: "AAAA" } }] } });
    await expect(new VeoVideoProvider(config, client).getStatus(OP)).resolves.toEqual({ state: "succeeded" });
  });

  it("maps an operation error 429 to a retryable failure", async () => {
    const { client } = stubClient({ done: true, error: { code: 429, message: "Quota exceeded" } });
    const s = await new VeoVideoProvider(config, client).getStatus(OP);
    expect(s.state).toBe("failed");
    expect(s.error?.retryable).toBe(true);
    expect(s.error?.message).toContain("Quota exceeded");
  });

  it("maps RAI filtering to a permanent failure keeping the reason", async () => {
    const { client } = stubClient({
      done: true,
      response: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["Video violates policy X"] },
    });
    const s = await new VeoVideoProvider(config, client).getStatus(OP);
    expect(s.state).toBe("failed");
    expect(s.error?.retryable).toBe(false);
    expect(s.error?.message).toContain("Video violates policy X");
  });

  it("maps a thrown 503 from the poll call to a retryable failure", async () => {
    const { client } = stubClient(() => {
      throw Object.assign(new Error("unavailable"), { status: 503 });
    });
    const s = await new VeoVideoProvider(config, client).getStatus(OP);
    expect(s).toMatchObject({ state: "failed", error: { retryable: true } });
  });

  it("getResult writes decoded bytes to <outputDir>/<sceneId>.mp4", async () => {
    const bytes = Buffer.from("fake-mp4-bytes");
    const { client } = stubClient({
      done: true,
      response: { generatedVideos: [{ video: { videoBytes: bytes.toString("base64") } }] },
    });
    const provider = new VeoVideoProvider(config, client);
    const r = await req();
    await provider.generate(r);
    const { clipPath } = await provider.getResult(OP);
    expect(clipPath).toBe(join(r.outputDir, "s1.mp4"));
    expect((await readFile(clipPath)).equals(bytes)).toBe(true);
  });

  it("rejects a GCS uri result with a clear non-retryable error", async () => {
    const { client } = stubClient({ done: true, response: { generatedVideos: [{ video: { uri: "gs://b/x.mp4" } }] } });
    const provider = new VeoVideoProvider(config, client);
    await provider.generate(await req());
    await expect(provider.getResult(OP)).rejects.toThrow(/OUTPUT_GCS_URI is not supported/);
  });

  it("limits concurrent submits to maxConcurrency", async () => {
    let active = 0;
    let peak = 0;
    const client: VeoClient = {
      async generateVideos() {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { name: OP };
      },
      async getVideosOperation() {
        return { done: false };
      },
    };
    const provider = new VeoVideoProvider({ ...config, maxConcurrency: 2 }, client);
    const r = await req();
    await Promise.all([1, 2, 3, 4, 5].map((i) => provider.generate({ ...r, sceneId: `s${i}` })));
    expect(peak).toBe(2);
  });
});

describe("classifyVeoError", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["http 429", { status: 429, message: "x" }, true],
    ["RESOURCE_EXHAUSTED text", new Error('{"error":{"status":"RESOURCE_EXHAUSTED"}}'), true],
    ["grpc 8", { code: 8, message: "quota" }, true],
    ["http 500", { status: 500, message: "x" }, true],
    ["http 503", { status: 503, message: "x" }, true],
    ["UNAVAILABLE", { code: "UNAVAILABLE", message: "x" }, true],
    ["grpc 14", { code: 14, message: "x" }, true],
    ["DEADLINE_EXCEEDED", { code: "DEADLINE_EXCEEDED", message: "x" }, true],
    ["ECONNRESET", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), true],
    ["ETIMEDOUT", new Error("connect ETIMEDOUT 1.2.3.4"), true],
    ["fetch failed", new TypeError("fetch failed"), true],
    ["http 400", { status: 400, message: "bad duration" }, false],
    ["INVALID_ARGUMENT", { code: "INVALID_ARGUMENT", message: "bad" }, false],
    ["grpc 3", { code: 3, message: "bad" }, false],
    ["http 403", { status: 403, message: "denied" }, false],
    ["http 404", { status: 404, message: "not found" }, false],
    ["unknown error", new Error("boom"), false],
  ];
  it.each(cases)("%s", (_n, err, retryable) => {
    expect(classifyVeoError(err).retryable).toBe(retryable);
  });

  it("adds hints for 403 and 404 and preserves the provider text", () => {
    const forbidden = classifyVeoError({ status: 403, message: "Permission denied on resource" });
    expect(forbidden.message).toContain("Permission denied on resource");
    expect(forbidden.message).toMatch(/Vertex AI API.*billing.*ADC/);
    const missing = classifyVeoError({ status: 404, message: "Publisher Model not found" });
    expect(missing.message).toMatch(/VEO_MODEL/);
  });

  it("treats RAI/safety text as permanent", () => {
    const e = classifyVeoError(new Error("Content blocked by safety filter: support code 123"));
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("support code 123");
  });
});

describe("loadVeoConfig", () => {
  it("applies defaults", () => {
    expect(loadVeoConfig({ GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "us-central1" })).toEqual(config);
  });
  it("reads overrides", () => {
    const c = loadVeoConfig({
      GOOGLE_CLOUD_PROJECT: "p",
      GOOGLE_CLOUD_LOCATION: "us-central1",
      VEO_MODEL: "veo-3.1-fast-generate-001",
      VEO_RESOLUTION: "720p",
      VEO_MAX_CONCURRENCY: "1",
    });
    expect(c).toMatchObject({ model: "veo-3.1-fast-generate-001", resolution: "720p", maxConcurrency: 1 });
  });
  it("throws ConfigError when project is missing", () => {
    expect(() => loadVeoConfig({})).toThrow(ConfigError);
  });
  it("rejects a bad VEO_MAX_CONCURRENCY", () => {
    expect(() =>
      loadVeoConfig({ GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "us-central1", VEO_MAX_CONCURRENCY: "0" }),
    ).toThrow(ConfigError);
  });
});
