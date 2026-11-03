import { describe, expect, it } from "vitest";
import { ConfigError, loadGeminiConfig } from "../src/config.ts";
import { translateModelError } from "../src/llm/vertexGeminiClient.ts";

describe("loadGeminiConfig", () => {
  it("uses API-key mode with gemini-3.8-flash by default when GEMINI_API_KEY is set", () => {
    expect(loadGeminiConfig({ GEMINI_API_KEY: "k" })).toEqual({ mode: "apiKey", apiKey: "k", model: "gemini-3.8-flash" });
  });
  it("lets GEMINI_MODEL override the key-mode default, and the key wins over a Vertex project", () => {
    const c = loadGeminiConfig({ GEMINI_API_KEY: " k ", GEMINI_MODEL: "gemini-x", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "us-central1" });
    expect(c).toEqual({ mode: "apiKey", apiKey: "k", model: "gemini-x" });
  });
  it("falls back to Vertex when there is no key but a project", () => {
    expect(loadGeminiConfig({ GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "us-central1" })).toMatchObject({
      mode: "vertex",
      project: "p",
      location: "us-central1",
    });
  });
  it("reports the missing location when only a project is set", () => {
    expect(() => loadGeminiConfig({ GOOGLE_CLOUD_PROJECT: "p" })).toThrow(/GOOGLE_CLOUD_LOCATION/);
  });
  it("throws a ConfigError naming both options when neither is configured", () => {
    const err = (() => {
      try {
        loadGeminiConfig({});
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.message).toMatch(/GEMINI_API_KEY/);
    expect(err!.message).toMatch(/GOOGLE_CLOUD_PROJECT/);
  });
});

describe("translateModelError", () => {
  it("turns a 404 into a message telling the user to set GEMINI_MODEL", () => {
    const e = translateModelError(Object.assign(new Error("models/x is no longer available"), { status: 404 }), "gemini-2.5-flash");
    expect(e).toBeInstanceOf(ConfigError);
    expect(e.message).toMatch(/gemini-2\.5-flash/);
    expect(e.message).toMatch(/GEMINI_MODEL/);
  });
  it("passes other errors through untouched", () => {
    const orig = Object.assign(new Error("boom"), { status: 500 });
    expect(translateModelError(orig, "m")).toBe(orig);
  });
});
