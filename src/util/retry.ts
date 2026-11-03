export interface BackoffPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const DEFAULT_RETRY_POLICY: BackoffPolicy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30_000 };

export interface RetryOptions extends BackoffPolicy {
  /** Defaults to `isRetryableError`. */
  isRetryable?: (err: unknown) => boolean;
  /** Called before sleeping for a retry. `attempt` is the attempt that just failed. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void | Promise<void>;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with equal jitter: delay in [cap/2, cap], cap = min(max, base * 2^(attempt-1)). */
export function backoffDelayMs(
  attempt: number,
  policy: Pick<BackoffPolicy, "baseDelayMs" | "maxDelayMs">,
  random: () => number = Math.random,
): number {
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(cap / 2 + (random() * cap) / 2);
}

/** Runs `fn(attempt)` (1-based), retrying only retryable failures, up to `maxAttempts`. */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const isRetryable = options.isRetryable ?? isRetryableError;
  const wait = options.sleep ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= options.maxAttempts || !isRetryable(err)) throw err;
      const delay = backoffDelayMs(attempt, options, options.random);
      await options.onRetry?.(err, attempt, delay);
      await wait(delay);
    }
  }
}

const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

/** An explicit `retryable` flag wins; otherwise HTTP 429/5xx and network-level errors are transient. */
export function isRetryableError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { retryable?: unknown; status?: unknown; code?: unknown; message?: unknown };
  if (typeof e.retryable === "boolean") return e.retryable;
  const status = typeof e.status === "number" ? e.status : typeof e.code === "number" ? e.code : undefined;
  if (status !== undefined) return status === 429 || (status >= 500 && status <= 599);
  if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
  return err instanceof Error && /fetch failed|socket hang up/i.test(err.message);
}
