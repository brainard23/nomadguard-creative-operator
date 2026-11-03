import { z } from "zod";

export const JobStateSchema = z.enum([
  "CREATED",
  "PLANNING",
  "PLANNED",
  "GENERATING",
  "ASSEMBLING",
  "EVALUATING",
  "FINALIZED",
  "NEEDS_REVIEW",
  "FAILED",
]);

export const ArtifactNameSchema = z.enum(["brief", "strategy", "storyboard", "prompts", "qa", "final"]);

/** File name of each artifact inside the run folder. */
export const ARTIFACT_FILES: Record<z.infer<typeof ArtifactNameSchema>, string> = {
  brief: "brief.json",
  strategy: "strategy.json",
  storyboard: "storyboard.json",
  prompts: "prompts.json",
  qa: "qa.json",
  final: "final.mp4",
};

export const ShotStateSchema = z.enum(["PENDING", "SUBMITTED", "RUNNING", "SUCCEEDED", "FAILED"]);

export const ShotSchema = z.object({
  sceneId: z.string(),
  state: ShotStateSchema,
  providerJobId: z.string().optional(),
  /** Relative to the run folder. */
  clipPath: z.string().optional(),
  attempts: z.number().int().nonnegative(),
  error: z.object({ message: z.string(), retryable: z.boolean().optional(), code: z.string().optional() }).optional(),
});

export const JobErrorSchema = z.object({
  stage: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export const JobSchema = z.object({
  runId: z.string(),
  state: JobStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  error: JobErrorSchema.optional(),
  /** Artifact name -> path relative to the run folder. */
  artifacts: z.record(z.string(), z.string()),
  notes: z.array(z.string()),
  shots: z.array(ShotSchema).default([]),
});

export type JobState = z.infer<typeof JobStateSchema>;
export type ArtifactName = z.infer<typeof ArtifactNameSchema>;
export type JobError = z.infer<typeof JobErrorSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type Job = z.infer<typeof JobSchema>;
