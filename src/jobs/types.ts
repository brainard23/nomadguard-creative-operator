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

export const ArtifactNameSchema = z.enum(["brief", "strategy", "storyboard", "prompts"]);

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
});

export type JobState = z.infer<typeof JobStateSchema>;
export type ArtifactName = z.infer<typeof ArtifactNameSchema>;
export type JobError = z.infer<typeof JobErrorSchema>;
export type Job = z.infer<typeof JobSchema>;
