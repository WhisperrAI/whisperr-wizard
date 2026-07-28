export type FailureClass = "context_overflow" | "transient" | "fatal";

const OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /context.{0,20}(length|window|limit).{0,20}exceed/i,
  /exceeds? .{0,20}context/i,
  /maximum context/i,
  /input is too long/i,
];

const TRANSIENT_PATTERNS = [
  /rate.?limit/i,
  /overloaded/i,
  /timeout/i,
  /timed out/i,
  /econnreset/i,
  /socket hang up/i,
  /5\d\d/,
  /temporarily unavailable/i,
];

export function classifyFailure(message: string): FailureClass {
  const text = message ?? "";
  if (OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) {
    return "context_overflow";
  }
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "transient";
  }
  return "fatal";
}

export const MAX_CLUSTER_ATTEMPTS = 2;

export function nextClusterStatusAfterFailure(
  failure: FailureClass,
  attempts: number,
): "pending" | "failed_resumable" | "blocked" {
  if (failure === "transient" && attempts < MAX_CLUSTER_ATTEMPTS) {
    return "pending";
  }
  if (failure === "fatal") {
    return "blocked";
  }
  return "failed_resumable";
}
