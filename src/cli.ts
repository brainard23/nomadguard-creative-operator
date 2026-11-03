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
  pnpm start run [--plan-only] [--provider manual|mock|veo] [--brief <path>] [--llm gemini|fake] [--skip-creative-qa]
  pnpm start resume <runId> [--plan-only] [--provider manual|mock|veo] [--llm gemini|fake] [--skip-creative-qa]
  pnpm start resume <runId> (--redo <sceneId>[,<sceneId>] | --reassemble) [--provider ...]
  pnpm start status [runId]

Options:
  --plan-only   Stop after strategy, storyboard and prompts (no video generation)
  --provider    Video provider: manual (free: make clips in Google Flow, drop them in the run's inbox/),
                mock (offline) or veo (Veo 3.1 on Vertex AI, billed).
                Default: veo if GOOGLE_CLOUD_PROJECT is set, otherwise mock
  --brief       Path to the brief JSON (default: ${DEFAULT_BRIEF_PATH})
  --llm         LLM client: gemini (default; GEMINI_API_KEY from AI Studio, else Vertex AI; "vertex" is an alias)
                or fake (offline fixtures)
  --redo        With resume: redo these shots (comma-separated scene ids), then reassemble and rerun QA.
                For the manual provider the shot is re-imported from inbox/<sceneId>.mp4
  --reassemble  With resume: keep all shots, rerun only assembly + QA (after editing storyboard.json overlay/trimStart)
  --skip-creative-qa  Skip the Gemini vision review of sampled frames (technical QA still runs)

Manual provider: \`run --provider manual\` writes prompts to runs/<id>/inbox/ and pauses (state AWAITING_CLIPS,
exit code 0). Add the <sceneId>.mp4 files, then \`resume <runId> --provider manual\`.`;

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
      llm: { type: "string", default: "gemini" },
      provider: { type: "string" },
      "skip-creative-qa": { type: "boolean", default: false },
      redo: { type: "string" },
      reassemble: { type: "boolean", default: false },
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
  const redo = (values.redo ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if ((redo.length > 0 || values.reassemble) && command !== "resume") {
    console.error(`--redo and --reassemble only work with resume.\n\n${USAGE}`);
    return 2;
  }
  if (values.redo !== undefined && redo.length === 0) {
    console.error(`--redo needs at least one scene id, e.g. --redo s2.\n\n${USAGE}`);
    return 2;
  }
  if (values.llm !== "fake" && values.llm !== "gemini" && values.llm !== "vertex") {
    console.error(`Unknown --llm "${values.llm}" (expected gemini or fake).\n\n${USAGE}`);
    return 2;
  }
  let providerKind = values.provider;
  if (providerKind === undefined && command === "resume") {
    // A run paused for manual clips must not silently resume on another provider.
    const prior = await store.get(runId!);
    if (prior.shots.some((sh) => sh.providerJobId?.startsWith("manual:")) || existsSync(`${store.runDir(runId!)}/inbox`)) {
      providerKind = "manual";
      console.log("Run was started with the manual provider: resuming with --provider manual.");
    }
  }
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
  if (providerKind !== "mock" && providerKind !== "veo" && providerKind !== "manual") {
    console.error(`Unknown --provider "${providerKind}" (expected manual, mock or veo).\n\n${USAGE}`);
    return 2;
  }

  const llm = createLlmClient(values.llm as LlmKind);
  const provider = values["plan-only"] ? undefined : createVideoProvider(providerKind as ProviderKind);
  const skipCreativeQa = values["skip-creative-qa"];
  if (skipCreativeQa) console.log("Creative QA skipped (--skip-creative-qa).");

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
    const rerun = redo.length > 0 || values.reassemble;
    if (!rerun && (before.state === "FINALIZED" || before.state === "NEEDS_REVIEW")) {
      console.log(`Run ${runId} is already ${before.state}; nothing to resume.`);
      return 0;
    }
    job = await resumePipeline({ store, llm, provider, runId: runId!, signal: controller.signal, skipCreativeQa, redo, reassemble: values.reassemble });
  } else {
    const brief = await loadBrief(values.brief);
    job = await runPipeline({ store, llm, brief, provider, signal: controller.signal, onJobCreated, skipCreativeQa });
  }

  console.log(formatJobStatus(job, store.runDir(job.runId)));

  if (controller.signal.aborted) return 130;
  if (job.state === "AWAITING_CLIPS") {
    // Not a failure: the run is paused on purpose, so exit 0.
    const missing = job.shots.filter((sh) => sh.state !== "SUCCEEDED").map((sh) => sh.sceneId);
    const inbox = `${store.runDir(job.runId)}/inbox`;
    console.log(`\nWaiting for ${missing.length} clip${missing.length === 1 ? "" : "s"}: ${missing.map((id) => `${id}.mp4`).join(", ")}`);
    console.log(`Make them in Google Flow using the prompts in ${inbox}/ (see ${inbox}/README.md), save the MP4s there, then:`);
    console.log(`  pnpm start resume ${job.runId} --provider manual`);
    return 0;
  }
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
