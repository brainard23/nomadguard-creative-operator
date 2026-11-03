import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { BriefError, DEFAULT_BRIEF_PATH, loadBrief } from "./brief/load.ts";
import { ConfigError } from "./config.ts";
import { JobStore } from "./jobs/jobStore.ts";
import { createLlmClient, type LlmKind } from "./llm/index.ts";
import { MediaError } from "./media/exec.ts";
import { formatJobStatus, formatRunList } from "./jobs/format.ts";
import { resumePipeline, runPipeline } from "./pipeline/pipeline.ts";
import { createVideoProvider, type ProviderKind } from "./video/index.ts";

// Loaded here (not via a node flag) so a missing .env is silent.
if (existsSync(".env")) process.loadEnvFile(".env");

const USAGE = `Usage:
  pnpm start run [--plan-only] [--provider mock|veo] [--brief <path>] [--llm fake|vertex]
  pnpm start resume <runId> [--plan-only] [--provider mock|veo] [--llm fake|vertex]
  pnpm start status [runId]

Options:
  --plan-only   Stop after strategy, storyboard and prompts (no video generation)
  --provider    Video provider: mock (offline) or veo (Veo 3.1 on Vertex AI).
                Default: veo if GOOGLE_CLOUD_PROJECT is set, otherwise mock
  --brief       Path to the brief JSON (default: ${DEFAULT_BRIEF_PATH})
  --llm         LLM client: vertex (default) or fake (offline fixtures)`;

/** Run being executed, so a fatal error or signal can still be recorded on the job. */
const active: { store?: JobStore; runId?: string } = {};

async function recordFatal(err: unknown): Promise<void> {
  if (!active.store || !active.runId) return;
  try {
    await active.store.update(active.runId, {
      state: "FAILED",
      error: { stage: "pipeline", message: err instanceof Error ? err.message : String(err) },
    });
  } catch {
    // nothing more we can do
  }
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "plan-only": { type: "boolean", default: false },
      brief: { type: "string", default: DEFAULT_BRIEF_PATH },
      llm: { type: "string", default: "vertex" },
      provider: { type: "string" },
    },
  });
  const [command, runId] = positionals;
  const store = new JobStore();

  if (command === "status") {
    if (!runId) {
      console.log(formatRunList(await store.list(10)));
      return 0;
    }
    console.log(formatJobStatus(await store.get(runId), store.runDir(runId)));
    return 0;
  }

  if (command !== "run" && command !== "resume") {
    console.error(USAGE);
    return 2;
  }
  if (command === "resume" && !runId) {
    console.error(`resume needs a run id.\n\n${USAGE}`);
    return 2;
  }
  if (values.llm !== "fake" && values.llm !== "vertex") {
    console.error(`Unknown --llm "${values.llm}" (expected fake or vertex).\n\n${USAGE}`);
    return 2;
  }
  let providerKind = values.provider;
  if (providerKind === undefined) {
    providerKind = process.env.GOOGLE_CLOUD_PROJECT?.trim() ? "veo" : "mock";
    if (!values["plan-only"]) {
      console.log(
        providerKind === "veo"
          ? "No --provider given: using veo (GOOGLE_CLOUD_PROJECT is set). Pass --provider mock for an offline run."
          : "No --provider given and GOOGLE_CLOUD_PROJECT is unset: using mock. Pass --provider veo for real video.",
      );
    }
  }
  if (providerKind !== "mock" && providerKind !== "veo") {
    console.error(`Unknown --provider "${providerKind}" (expected mock or veo).\n\n${USAGE}`);
    return 2;
  }

  const llm = createLlmClient(values.llm as LlmKind);
  const provider = values["plan-only"] ? undefined : createVideoProvider(providerKind as ProviderKind);

  const controller = new AbortController();
  process.once("SIGINT", () => {
    console.error("\nInterrupted: finishing the current step, state is saved. Resume with: pnpm start resume <runId>");
    controller.abort();
  });
  const onJobCreated = (id: string) => {
    active.store = store;
    active.runId = id;
  };

  let job;
  if (command === "resume") {
    active.store = store;
    active.runId = runId;
    const before = await store.get(runId!);
    if (before.state === "FINALIZED" || before.state === "NEEDS_REVIEW") {
      console.log(`Run ${runId} is already ${before.state}; nothing to resume.`);
      return 0;
    }
    job = await resumePipeline({ store, llm, provider, runId: runId!, signal: controller.signal });
  } else {
    const brief = await loadBrief(values.brief);
    job = await runPipeline({ store, llm, brief, provider, signal: controller.signal, onJobCreated });
  }

  console.log(formatJobStatus(job, store.runDir(job.runId)));

  if (controller.signal.aborted) return 130;
  if (job.state === "FAILED") {
    console.error(`\nRun failed during "${job.error?.stage}": ${job.error?.message}`);
    console.error(`Details saved in ${store.runDir(job.runId)}/job.json. Fix the cause, then: pnpm start resume ${job.runId}`);
    return 1;
  }
  return 0;
}

process.on("uncaughtException", (err) => {
  void recordFatal(err).finally(() => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  async (err: unknown) => {
    await recordFatal(err);
    if (err instanceof BriefError || err instanceof ConfigError || err instanceof MediaError) {
      console.error(`Error: ${err.message}`);
    } else if (process.env.DEBUG) {
      console.error(err);
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  },
);
