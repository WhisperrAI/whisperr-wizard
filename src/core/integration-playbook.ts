export const SHARED_CONTRACT_VERSION = "2.0.0";
export interface IntegrationPlaybook {
  contract_version: string;
  playbook_version: string;
  steps: string[];
  invariants: string[];
  sdk_contract: string;
}

/** Transport-only compatibility client. Registration, gaps and readiness are
 * server-owned; the CLI never substitutes a local success heuristic. */
export async function fetchIntegrationPlaybook(base: string, sessionToken: string, request: typeof fetch = fetch): Promise<IntegrationPlaybook> {
  const response = await request(`${base}/wizard/integration-playbook?contract_version=${SHARED_CONTRACT_VERSION}`, {
    headers: { Authorization: `Bearer ${sessionToken}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Shared integration playbook unavailable (${response.status}); no legacy fallback was attempted.`);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("Invalid integration playbook.");
  const playbook = value as IntegrationPlaybook;
  if (playbook.contract_version !== SHARED_CONTRACT_VERSION || playbook.playbook_version !== "1" || playbook.sdk_contract !== "v1_unchanged" ||
    !Array.isArray(playbook.steps) || !playbook.steps.every((step) => typeof step === "string") || !Array.isArray(playbook.invariants)) {
    throw new Error("Integration contract mismatch; update the executor, do not retry.");
  }
  return playbook;
}
