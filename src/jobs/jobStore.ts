import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ARTIFACT_FILES,
  JobSchema,
  type ArtifactName,
  type Job,
  type JobError,
  type JobState,
  type Shot,
} from "./types.ts";

export const DEFAULT_RUNS_DIR = "runs";

export interface JobPatch {
  state?: JobState;
  error?: JobError;
  notes?: string[];
  shots?: Shot[];
  artifacts?: Record<string, string>;
}

/** File-based job store: one folder per run holding job.json plus artifacts. */
export class JobStore {
  /** Serializes read-modify-write cycles so concurrent shot updates cannot clobber each other. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly rootDir: string = DEFAULT_RUNS_DIR) {}

  runDir(runId: string): string {
    return join(this.rootDir, runId);
  }

  artifactPath(runId: string, name: ArtifactName): string {
    return join(this.runDir(runId), ARTIFACT_FILES[name]);
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
      shots: [],
    };
    await mkdir(this.runDir(job.runId), { recursive: true });
    await this.persist(job);
    return job;
  }

  async get(runId: string): Promise<Job> {
    const raw = await readFile(join(this.runDir(runId), "job.json"), "utf8");
    return JobSchema.parse(JSON.parse(raw));
  }

  /** Most recent runs first (run ids sort by creation time). Unreadable run folders are skipped. */
  async list(limit = 10): Promise<Job[]> {
    let names: string[];
    try {
      names = await readdir(this.rootDir);
    } catch {
      return [];
    }
    const jobs: Job[] = [];
    for (const name of names.sort().reverse()) {
      if (jobs.length >= limit) break;
      try {
        jobs.push(await this.get(name));
      } catch {
        // not a run folder
      }
    }
    return jobs;
  }

  update(runId: string, patch: JobPatch): Promise<Job> {
    return this.mutate(runId, (job) => ({ ...job, ...patch }));
  }

  /** Merges a patch into one shot's record (creating it if missing). */
  updateShot(runId: string, sceneId: string, patch: Partial<Omit<Shot, "sceneId">>): Promise<Job> {
    return this.mutate(runId, (job) => {
      const existing = job.shots.find((s) => s.sceneId === sceneId) ?? { sceneId, state: "PENDING" as const, attempts: 0 };
      const merged = { ...existing, ...patch };
      const shots = job.shots.some((s) => s.sceneId === sceneId)
        ? job.shots.map((s) => (s.sceneId === sceneId ? merged : s))
        : [...job.shots, merged];
      return { ...job, shots };
    });
  }

  /** Writes a JSON artifact, then records it on the job. */
  async writeArtifact(runId: string, name: ArtifactName, data: unknown): Promise<Job> {
    await writeJsonAtomic(this.artifactPath(runId, name), data);
    return this.registerArtifact(runId, name);
  }

  /** Records an artifact file that already exists in the run folder (e.g. final.mp4). */
  registerArtifact(runId: string, name: ArtifactName): Promise<Job> {
    return this.mutate(runId, (job) => ({ ...job, artifacts: { ...job.artifacts, [name]: ARTIFACT_FILES[name] } }));
  }

  private mutate(runId: string, fn: (job: Job) => Job): Promise<Job> {
    const run = this.queue.then(async () => {
      const next = { ...fn(await this.get(runId)), updatedAt: new Date().toISOString() };
      await this.persist(next);
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
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
