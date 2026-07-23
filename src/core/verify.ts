import type { WizardConfig, WizardSession } from "../types.js";

/**
 * The activation moment: after integration, poll Whisperr for the first event
 * received from this app. In a real run the customer would run their app once;
 * the wizard waits for the green light and the dashboard lights up too.
 *
 * Backend contract (Phase 0, whisperr-go):
 *   GET {api}/v1/wizard/first-event   (Authorization: Bearer <wizard token>)
 *     -> { received: boolean, event_type?: string, at?: string }
 *
 * Skipped in --offline mode.
 */
export async function pollFirstEvent(
  config: WizardConfig,
  session: WizardSession,
  opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<{ received: boolean; eventType?: string }> {
  if (config.offline) return { received: false };

  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return { received: false };
    try {
      const res = await fetch(`${config.apiBaseUrl}/wizard/first-event`, {
        headers: { authorization: `Bearer ${session.token}` },
      });
      if (res.ok) {
        const body = (await res.json()) as {
          received: boolean;
          event_type?: string;
        };
        if (body.received) {
          return { received: true, eventType: body.event_type };
        }
      }
    } catch {
      /* transient — keep polling */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { received: false };
}
