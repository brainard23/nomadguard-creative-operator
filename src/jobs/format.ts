import type { Job } from "./types.ts";

/** Human-readable status of one run: state, failure, per-shot progress, artifacts. */
export function formatJobStatus(job: Job, runDir: string): string {
  const lines = [`Run:     ${job.runId}`, `State:   ${job.state}`, `Created: ${job.createdAt}`, `Updated: ${job.updatedAt}`];
  if (job.error) {
    lines.push(`Failed:  stage "${job.error.stage}": ${job.error.message}`);
  }
  if (job.shots.length > 0) {
    lines.push("Shots:");
    for (const s of job.shots) {
      let line = `  ${s.sceneId.padEnd(6)} ${s.state.padEnd(10)} attempts=${s.attempts}`;
      if (s.providerJobId) line += ` job=${s.providerJobId}`;
      lines.push(line);
      if (s.error) lines.push(`         last error: ${s.error.message}${s.error.retryable === undefined ? "" : s.error.retryable ? " (retryable)" : " (permanent)"}`);
    }
  }
  const artifacts = Object.entries(job.artifacts);
  lines.push(artifacts.length ? "Artifacts:" : "Artifacts: none");
  for (const [name, rel] of artifacts) lines.push(`  ${name.padEnd(10)} ${runDir}/${rel}`);
  for (const note of job.notes) lines.push(`Note:    ${note}`);
  if (job.state === "AWAITING_CLIPS") {
    lines.push(`Inbox:   ${runDir}/inbox`, `Resume:  pnpm start resume ${job.runId} --provider manual`);
  } else if (job.state === "FAILED" || (job.state !== "FINALIZED" && job.state !== "NEEDS_REVIEW" && job.state !== "PLANNED")) {
    lines.push(`Resume:  pnpm start resume ${job.runId}`);
  }
  return lines.join("\n");
}

export function formatRunList(jobs: Job[]): string {
  if (jobs.length === 0) return "No runs found.";
  return jobs
    .map((j) => `${j.runId}  ${j.state.padEnd(11)} ${j.error ? `(failed in ${j.error.stage}) ` : ""}${j.updatedAt}`)
    .join("\n");
}
