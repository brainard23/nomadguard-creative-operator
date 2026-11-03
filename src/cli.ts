import { parseArgs } from "node:util";
import { BriefError, DEFAULT_BRIEF_PATH, loadBrief } from "./brief/load.ts";
import { ConfigError } from "./config.ts";
import { JobStore } from "./jobs/jobStore.ts";
import { createLlmClient, type LlmKind } from "./llm/index.ts";
import { runPlanning } from "./pipeline/planning.ts";

const USAGE = `Usage:
  pnpm start run --plan-only [--brief <path>] [--llm fake|vertex]

Options:
  --plan-only   Stop after strategy, storyboard and prompts (no video generation)
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
  if (!values["plan-only"]) {
    console.error("Full video generation arrives in S2. Run with --plan-only for now.");
    return 2;
  }

  const brief = await loadBrief(values.brief);
  const llm = createLlmClient(values.llm as LlmKind);
  const store = new JobStore();
  const job = await runPlanning({ store, llm, brief });

  console.log(`Run:   ${job.runId}`);
  console.log(`State: ${job.state}`);
  for (const [name, rel] of Object.entries(job.artifacts)) {
    console.log(`  ${name.padEnd(10)} ${store.runDir(job.runId)}/${rel}`);
  }
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
    if (err instanceof BriefError || err instanceof ConfigError) {
      console.error(`Error: ${err.message}`);
    } else if (process.env.DEBUG) {
      console.error(err);
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  },
);
