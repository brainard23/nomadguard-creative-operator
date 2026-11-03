import { BaseLlmClient, type CompleteRequest } from "./baseClient.ts";
import { DEFAULT_FIXTURES } from "./fixtures.ts";

export interface FakeLlmOptions {
  /** Canned JSON per task name. Defaults to the NomadGuard planning fixtures. */
  fixtures?: Record<string, unknown>;
  /** Raw (invalid) outputs to return first, per task, before falling back to the fixture. */
  invalidOutputs?: Record<string, string[]>;
  /** Tasks whose every call throws (to exercise pipeline failure handling). */
  failTasks?: Record<string, Error>;
}

/** Offline LlmClient for tests and `--llm fake`. Records every call in `calls`. */
export class FakeLlmClient extends BaseLlmClient {
  readonly calls: { task: string; prompt: string }[] = [];
  private readonly fixtures: Record<string, unknown>;
  private readonly invalid: Record<string, string[]>;
  private readonly failTasks: Record<string, Error>;

  constructor(options: FakeLlmOptions = {}) {
    super();
    this.fixtures = options.fixtures ?? DEFAULT_FIXTURES;
    this.invalid = Object.fromEntries(
      Object.entries(options.invalidOutputs ?? {}).map(([k, v]) => [k, [...v]]),
    );
    this.failTasks = options.failTasks ?? {};
  }

  protected override async complete({ prompt, opts }: CompleteRequest): Promise<string> {
    const task = opts.task ?? "default";
    this.calls.push({ task, prompt });
    const failure = this.failTasks[task];
    if (failure) throw failure;
    const queued = this.invalid[task]?.shift();
    if (queued !== undefined) return queued;
    if (!(task in this.fixtures)) throw new Error(`FakeLlmClient has no fixture for task "${task}"`);
    return JSON.stringify(this.fixtures[task]);
  }
}
