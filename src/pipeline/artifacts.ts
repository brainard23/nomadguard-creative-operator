import { readFile } from "node:fs/promises";
import type { z } from "zod";
import type { JobStore } from "../jobs/jobStore.ts";
import type { ArtifactName } from "../jobs/types.ts";

export async function readArtifact<T>(store: JobStore, runId: string, name: ArtifactName, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(store.artifactPath(runId, name), "utf8")));
}
