import type { Scene, Storyboard, StyleGuide } from "./schemas.ts";

// Veo-specific wording lives only in this file.

export const ASPECT_RATIO = "9:16";

export const NEGATIVE_PROMPT = [
  "text",
  "captions",
  "subtitles",
  "logos",
  "watermarks",
  "brand marks",
  "extra fingers",
  "distorted faces",
  "deformed hands",
  "cartoon",
  "illustration",
  "anime",
  "low quality",
  "blurry",
].join(", ");

export interface VeoPrompt {
  prompt: string;
  negative_prompt: string;
}

export interface ShotPrompt extends VeoPrompt {
  scene_id: string;
  duration: number;
}

export interface PromptsArtifact {
  aspect_ratio: typeof ASPECT_RATIO;
  shots: ShotPrompt[];
}

/** Strips trailing whitespace and sentence punctuation so fields can be joined with our own. */
const tidy = (text: string): string => text.trim().replace(/[\s.,;:!]+$/, "");

/** "Charcoal grey ..." -> "charcoal grey ..."; leaves acronyms ("TV") and proper-looking words alone. */
const lowerFirst = (text: string): string => (/^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text);

/**
 * Pure: scene + style guide -> Veo 3.1 prompt. Leads with the shot/camera, repeats the
 * full character + wardrobe verbatim in every prompt so clips stay consistent.
 * No on-screen text is requested; the end card is added later by ffmpeg.
 */
export function buildVeoPrompt(
  scene: Scene,
  style: StyleGuide,
  aspect: typeof ASPECT_RATIO = ASPECT_RATIO,
): VeoPrompt {
  const lighting = style.lighting ? ` Lighting: ${tidy(style.lighting)}.` : "";
  const audio = scene.dialogue_or_sfx
    ? `Audio: ${tidy(scene.dialogue_or_sfx)}.`
    : "Audio: subtle natural ambient sound, no music lyrics, no spoken words.";
  const prompt = [
    `${tidy(scene.camera)}.`,
    `Subject: ${tidy(style.character)}, wearing ${lowerFirst(tidy(style.wardrobe))}.`,
    `Action: ${tidy(scene.description)}.`,
    `Setting: ${tidy(style.setting)}.${lighting}`,
    `Color palette: ${tidy(style.palette)}. Color grade: ${tidy(style.grade)}. Lens: ${tidy(style.lens)}.`,
    `Photorealistic, cinematic, vertical ${aspect} framing.`,
    audio,
  ]
    .join(" ")
    // Safety net: model-written fields can still smuggle in doubled punctuation internally.
    .replace(/\.(\s*\.)+/g, ".")
    .replace(/\.\s*,/g, ",");
  return { prompt, negative_prompt: NEGATIVE_PROMPT };
}

export function buildPrompts(storyboard: Storyboard): PromptsArtifact {
  return {
    aspect_ratio: ASPECT_RATIO,
    shots: storyboard.scenes.map((scene) => ({
      scene_id: scene.id,
      duration: scene.duration,
      ...buildVeoPrompt(scene, storyboard.style_guide),
    })),
  };
}
