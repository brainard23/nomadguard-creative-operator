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
  const lighting = style.lighting ? ` Lighting: ${style.lighting}.` : "";
  const audio = scene.dialogue_or_sfx
    ? `Audio: ${scene.dialogue_or_sfx}.`
    : "Audio: subtle natural ambient sound, no music lyrics, no spoken words.";
  const prompt = [
    `${scene.camera}.`,
    `Subject: ${style.character}, wearing ${style.wardrobe}.`,
    `Action: ${scene.description}`,
    `Setting: ${style.setting}.${lighting}`,
    `Color palette: ${style.palette}. Color grade: ${style.grade}. Lens: ${style.lens}.`,
    `Photorealistic, cinematic, vertical ${aspect} framing.`,
    audio,
  ].join(" ");
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
