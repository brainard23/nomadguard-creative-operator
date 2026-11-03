import { describe, expect, it, vi } from "vitest";
import { backoffDelayMs, isRetryableError, retry } from "../src/util/retry.ts";

const policy = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1000 };

describe("backoffDelayMs", () => {
  it("doubles each attempt up to the cap (random=1 gives the full delay)", () => {
    const delays = [1, 2, 3, 4, 5, 6].map((a) => backoffDelayMs(a, policy, () => 1));
    expect(delays).toEqual([100, 200, 400, 800, 1000, 1000]);
  });

  it("applies jitter between half and full delay", () => {
    expect(backoffDelayMs(3, policy, () => 0)).toBe(200);
    expect(backoffDelayMs(3, policy, () => 0.5)).toBe(300);
  });
});

describe("retry", () => {
  const retryable = Object.assign(new Error("503"), { retryable: true });

  it("retries retryable failures with the backoff sequence, then succeeds", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let calls = 0;
    const result = await retry(
      async (attempt) => {
        calls++;
        if (attempt < 3) throw retryable;
        return "ok";
      },
      { ...policy, sleep, random: () => 1 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it("stops immediately on a non-retryable error", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fn = vi.fn(async () => {
      throw Object.assign(new Error("bad request"), { retryable: false });
    });
    await expect(retry(fn, { ...policy, sleep })).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fn = vi.fn(async () => {
      throw retryable;
    });
    await expect(retry(fn, { ...policy, maxAttempts: 3, sleep })).rejects.toBe(retryable);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("reports each retry through onRetry", async () => {
    const seen: [number, number][] = [];
    await retry(async (a) => (a < 2 ? Promise.reject(retryable) : "x"), {
      ...policy,
      sleep: async () => {},
      random: () => 1,
      onRetry: (_err, attempt, delay) => void seen.push([attempt, delay]),
    });
    expect(seen).toEqual([[1, 100]]);
  });
});

describe("isRetryableError", () => {
  it("honours an explicit retryable flag", () => {
    expect(isRetryableError({ retryable: true })).toBe(true);
    expect(isRetryableError({ retryable: false, status: 503 })).toBe(false);
  });

  it("treats 429/5xx and network error codes as transient, other errors as permanent", () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
    expect(isRetryableError({ status: 503 })).toBe(true);
    expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableError({ status: 400 })).toBe(false);
    expect(isRetryableError(new Error("boom"))).toBe(false);
  });
});
