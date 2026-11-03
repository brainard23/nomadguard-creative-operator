import { describe, expect, it } from "vitest";
import { buildVeoPrompt, buildPrompts } from "../src/creative/promptBuilder.ts";
import { storyboard } from "./support.ts";

const sb = storyboard([4, 4, 4], 2);
sb.scenes[1]!.dialogue_or_sfx = "a soft confirmation chime";

describe("buildVeoPrompt", () => {
  it("repeats the full character and wardrobe verbatim in every shot", () => {
    for (const scene of sb.scenes) {
      const { prompt } = buildVeoPrompt(scene, sb.style_guide);
      expect(prompt).toContain(sb.style_guide.character);
      expect(prompt).toContain(sb.style_guide.wardrobe);
      expect(prompt).toContain(sb.style_guide.setting);
      expect(prompt).toContain(sb.style_guide.lens);
      expect(prompt).toContain(sb.style_guide.grade);
    }
  });

  it("leads with the camera and states vertical 9:16 photorealism", () => {
    const { prompt } = buildVeoPrompt(sb.scenes[0]!, sb.style_guide);
    expect(prompt.startsWith(sb.scenes[0]!.camera)).toBe(true);
    expect(prompt).toContain("9:16");
    expect(prompt).toMatch(/photorealistic/i);
    expect(prompt).toMatch(/cinematic/i);
  });

  it("includes the scene action and audio cue", () => {
    const { prompt } = buildVeoPrompt(sb.scenes[1]!, sb.style_guide);
    expect(prompt).toContain(sb.scenes[1]!.description);
    expect(prompt).toContain("a soft confirmation chime");
  });

  it("negative prompt bans on-screen text, logos, watermarks and artefacts", () => {
    const { negative_prompt } = buildVeoPrompt(sb.scenes[0]!, sb.style_guide);
    for (const term of ["text", "logos", "watermarks", "subtitles", "extra fingers", "distorted faces", "cartoon"]) {
      expect(negative_prompt).toContain(term);
    }
  });
});

describe("buildPrompts", () => {
  it("builds one prompt per scene with its duration and id", () => {
    const out = buildPrompts(sb);
    expect(out.aspect_ratio).toBe("9:16");
    expect(out.shots.map((s) => s.scene_id)).toEqual(["s1", "s2", "s3"]);
    expect(out.shots.map((s) => s.duration)).toEqual([4, 4, 4]);
  });
});

describe("buildVeoPrompt punctuation", () => {
  it("never doubles punctuation when fields already end with a period", () => {
    const scene = {
      ...sb.scenes[0]!,
      camera: "Smooth eye-level vertical tracking shot moving backwards ahead of the man as he walks briskly past the frozen queue.",
      description: "He glances at his watch and keeps walking.",
    };
    const style = {
      ...sb.style_guide,
      character: "a man in his late thirties with short dark hair and a calm, composed expression.",
      wardrobe: "Charcoal grey merino wool crewneck sweater, dark trousers.",
      setting: "a frozen city street at dawn.",
      lighting: "cold blue light.",
    };
    const { prompt } = buildVeoPrompt(scene, style);
    expect(prompt).not.toMatch(/\.\./);
    expect(prompt).not.toMatch(/\.,/);
    expect(prompt).not.toMatch(/\.\s+\./);
    expect(prompt).toContain("wearing charcoal grey merino wool crewneck sweater, dark trousers.");
    expect(prompt).toContain("calm, composed expression, wearing");
    expect(prompt.startsWith("Smooth eye-level vertical tracking shot")).toBe(true);
  });
});
