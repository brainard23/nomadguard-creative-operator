import { z } from "zod";

export const BriefSchema = z.object({
  brand: z.string().min(1),
  description: z.string().min(1),
  audience: z.object({
    segment: z.string().min(1),
    age_range: z.string().min(1),
  }),
  problem: z.string().min(1),
  core_message: z.string().min(1),
  brand_feel: z.array(z.string().min(1)).min(1),
  format: z.object({
    aspect_ratio: z.literal("9:16"),
    duration_seconds: z
      .object({ min: z.number().positive(), max: z.number().positive() })
      .refine((d) => d.min <= d.max, "min must be <= max"),
    platforms: z.array(z.string().min(1)).min(1),
    look: z.string().min(1),
    hook_window_seconds: z.number().positive(),
  }),
});

export type Brief = z.infer<typeof BriefSchema>;
