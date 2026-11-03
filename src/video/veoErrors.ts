import type { VideoJobError } from "./types.ts";

// gRPC canonical codes (Vertex operation `error.code`) and their HTTP equivalents.
const GRPC_NAMES: Record<number, string> = {
  3: "INVALID_ARGUMENT",
  4: "DEADLINE_EXCEEDED",
  5: "NOT_FOUND",
  7: "PERMISSION_DENIED",
  8: "RESOURCE_EXHAUSTED",
  13: "INTERNAL",
  14: "UNAVAILABLE",
};
const HTTP_NAMES: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  502: "UNAVAILABLE",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};
const RETRYABLE = new Set(["RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE", "DEADLINE_EXCEEDED"]);
const NETWORK_RE = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|fetch failed|network error/i;
const STATUS_RE = /RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|INVALID_ARGUMENT|PERMISSION_DENIED|NOT_FOUND/;
const SAFETY_RE = /safety|responsible ai|\brai\b|blocked|filtered|violates/i;

const HINTS: Record<string, string> = {
  PERMISSION_DENIED:
    "Hint: enable the Vertex AI API on the project, check billing is active, and check ADC (`gcloud auth application-default login`).",
  NOT_FOUND: "Hint: model not found. Check VEO_MODEL and that GOOGLE_CLOUD_LOCATION supports it (Veo uses us-central1).",
};

/** Map a thrown SDK error or an operation `error` object to a retryable/permanent VideoJobError. */
export function classifyVeoError(err: unknown): VideoJobError {
  const obj = (typeof err === "object" && err !== null ? err : {}) as Record<string, unknown>;
  const message = (typeof obj.message === "string" && obj.message) || (err instanceof Error ? err.message : String(err));
  const rawCode = obj.status ?? obj.code;

  let name: string | undefined;
  if (typeof rawCode === "number") name = HTTP_NAMES[rawCode] ?? GRPC_NAMES[rawCode];
  else if (typeof rawCode === "string" && STATUS_RE.test(rawCode)) name = rawCode;
  name ??= STATUS_RE.exec(message)?.[0];

  const code = rawCode === undefined ? name : String(rawCode);
  const network = typeof rawCode === "string" ? NETWORK_RE.test(rawCode) || NETWORK_RE.test(message) : NETWORK_RE.test(message);
  if (name && !network) {
    const hint = HINTS[name];
    return { message: hint ? `${message} ${hint}` : message, retryable: RETRYABLE.has(name), code };
  }
  if (network) return { message, retryable: true, code: code ?? "NETWORK_ERROR" };
  if (SAFETY_RE.test(message)) return { message, retryable: false, code: code ?? "SAFETY_FILTERED" };
  return { message, retryable: false, code };
}
