import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { BriefError, DEFAULT_BRIEF_PATH, loadBrief } from "./brief/load.ts";
import { ConfigError } from "./config.ts";
import { JobStore } from "./jobs/jobStore.ts";
import { createLlmClient, type LlmKind } from "./llm/index.ts";
import { MediaError } from "./media/exec.ts";
import { runPipeline } from "./pipeline/pipeline.ts";
import { createVideoProvider, type ProviderKind } from "./video/index.ts";

// Loaded here (not via a node flag) so a missing .env is silent.
if (existsSync(".env")) process.loadEnvFile(".env");

const USAGE = `Usage:
  pnpm start run [--plan-only] [--provider mock|veo] [--brief <path>] [--llm fake|vertex]

Options:
  --plan-only   Stop after strategy, storyboard and prompts (no video generation)
  --provider    Video provider: mock (offline) or veo (Veo 3.1 on Vertex AI).
                Default: veo if GOOGLE_CLOUD_PROJECT is set, otherwise mock
  --brief       Path to the brief JSON (default: ${DEFAULT_BRIEF_PATH})
  --llm         LLM client: vertex (default) or fake (offline fixtures)`;

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

  if (positionals[0] !== "run") {
    console.error(USAGE);
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

  const brief = await loadBrief(values.brief);
  const llm = createLlmClient(values.llm as LlmKind);
  const provider = values["plan-only"] ? undefined : createVideoProvider(providerKind as ProviderKind);
  const store = new JobStore();
  const job = await runPipeline({ store, llm, brief, provider });

  console.log(`Run:   ${job.runId}`);
  console.log(`State: ${job.state}`);
  for (const [name, rel] of Object.entries(job.artifacts)) {
    console.log(`  ${name.padEnd(10)} ${store.runDir(job.runId)}/${rel}`);
  }
  for (const shot of job.shots) console.log(`  shot ${shot.sceneId.padEnd(5)} ${shot.state}`);
  console.log(`  ${"job".padEnd(10)} ${store.runDir(job.runId)}/job.json`);
  for (const note of job.notes) console.log(`  note: ${note}`);

  if (job.state === "FAILED") {
    console.error(`\nRun failed during "${job.error?.stage}": ${job.error?.message}`);
    console.error(`Details saved in ${store.runDir(job.runId)}/job.json`);
    return 1;
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
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
