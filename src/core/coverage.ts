/** Runtime coverage statuses that prove an exact event is already instrumented. */
export function isInstrumentedCoverageStatus(status: string): boolean {
  return status === "existing" || status === "added";
}
