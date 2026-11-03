import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  JobSchema,
  type ArtifactName,
  type Job,
  type JobError,
  type JobState,
} from "./types.ts";

export const DEFAULT_RUNS_DIR = "runs";

export interface JobPatch {
  state?: JobState;
  error?: JobError;
  notes?: string[];
}

/** File-based job store: one folder per run holding job.json plus artifacts. */
export class JobStore {
  constructor(private readonly rootDir: string = DEFAULT_RUNS_DIR) {}

  runDir(runId: string): string {
    return join(this.rootDir, runId);
  }

  artifactPath(runId: string, name: ArtifactName): string {
    return join(this.runDir(runId), `${name}.json`);
  }

  async create(): Promise<Job> {
    const now = new Date().toISOString();
    const job: Job = {
      runId: newRunId(),
      state: "CREATED",
      createdAt: now,
      updatedAt: now,
      artifacts: {},
      notes: [],
    };
    await mkdir(this.runDir(job.runId), { recursive: true });
    await this.persist(job);
    return job;
  }

  async get(runId: string): Promise<Job> {
    const raw = await readFile(join(this.runDir(runId), "job.json"), "utf8");
    return JobSchema.parse(JSON.parse(raw));
  }

  async update(runId: string, patch: JobPatch): Promise<Job> {
    const job = await this.get(runId);
    const next: Job = { ...job, ...patch, updatedAt: new Date().toISOString() };
    await this.persist(next);
    return next;
  }

  /** Writes the artifact file, then records it on the job. */
  async writeArtifact(runId: string, name: ArtifactName, data: unknown): Promise<Job> {
    await writeJsonAtomic(this.artifactPath(runId, name), data);
    const job = await this.get(runId);
    const next: Job = {
      ...job,
      artifacts: { ...job.artifacts, [name]: `${name}.json` },
      updatedAt: new Date().toISOString(),
    };
    await this.persist(next);
    return next;
  }

  private persist(job: Job): Promise<void> {
    return writeJsonAtomic(join(this.runDir(job.runId), "job.json"), job);
  }
}

/** Sortable by creation time: UTC timestamp to the second + short random suffix. */
export function newRunId(now: Date = new Date()): string {
  const ts = now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
  return `${ts}-${randomBytes(3).toString("hex")}`;
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
