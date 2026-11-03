import { z } from "zod";

// ---- Strategy ----

export const AngleSchema = z.object({
  name: z.string().min(1),
  target_emotion: z.string().min(1),
  hook: z.string().min(1),
  concept: z.string().min(1),
  cta: z.string().min(1),
});

export const SelectionSchema = z.object({
  selected_angle: z.string().min(1),
  why_selected: z.string().min(1),
  audience_insight: z.string().min(1),
  why_it_performs: z.string().min(1),
});

export const StrategySchema = z
  .object({
    angles: z.array(AngleSchema).min(3),
    selection: SelectionSchema,
  })
  .refine((s) => s.angles.some((a) => a.name === s.selection.selected_angle), {
    path: ["selection", "selected_angle"],
    message: "selected_angle must match the name of one of the angles",
  });

export type Angle = z.infer<typeof AngleSchema>;
export type Strategy = z.infer<typeof StrategySchema>;

// ---- Storyboard ----

export const StyleGuideSchema = z.object({
  character: z.string().min(1),
  wardrobe: z.string().min(1),
  setting: z.string().min(1),
  palette: z.string().min(1),
  lens: z.string().min(1),
  grade: z.string().min(1),
  lighting: z.string().min(1).optional(),
});

export const ScenePurposeSchema = z.enum(["hook", "problem", "turn", "resolution", "payoff"]);

/**
 * Deterministic notification card composited over a scene in post (Veo cannot render legible UI).
 * `at` / `duration` are seconds from the scene start; `duration` defaults to the rest of the scene.
 */
export const OverlaySchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  at: z.number().default(0.5),
  duration: z.number().positive().optional(),
});

export const SceneSchema = z.object({
  id: z.string().min(1),
  duration: z.number().positive(),
  description: z.string().min(1),
  camera: z.string().min(1),
  purpose: ScenePurposeSchema,
  dialogue_or_sfx: z.string().min(1).optional(),
  overlay: OverlaySchema.optional(),
  /** Seconds to skip at the start of the imported clip (default 0). */
  trimStart: z.number().optional(),
});

export const EndCardSchema = z.object({
  duration: z.number().positive(),
  headline: z.string().min(1),
  cta: z.string().min(1),
});

export const StoryboardSchema = z
  .object({
    style_guide: StyleGuideSchema,
    scenes: z.array(SceneSchema).min(1),
    end_card: EndCardSchema,
  })
  .refine((s) => new Set(s.scenes.map((x) => x.id)).size === s.scenes.length, {
    path: ["scenes"],
    message: "scene ids must be unique",
  });

export type StyleGuide = z.infer<typeof StyleGuideSchema>;
export type Overlay = z.infer<typeof OverlaySchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Storyboard = z.infer<typeof StoryboardSchema>;
