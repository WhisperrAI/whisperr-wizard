import open from "open";
import type { WizardConfig, WizardSession } from "../types.js";
import { theme } from "../ui/theme.js";

/**
 * Device-authorization flow against whisperr-go.
 *
 * Backend contract (to be built in whisperr-go, Phase 0):
 *   POST {api}/v1/wizard/device/authorize
 *     -> { device_code, user_code, verification_uri, verification_uri_complete,
 *          interval, expires_in }
 *   POST {api}/v1/wizard/device/token  { device_code }
 *     -> 200 { token, app_id, expires_at }   when approved
 *     -> 428 { error: "authorization_pending" } while waiting
 *     -> 429 { error: "slow_down" }          back off
 *     -> 403/410 on deny/expiry
 *
 * The user is already logged in from onboarding, so the browser step is a single
 * "Approve this device" click that also binds the session to their app.
 */

export interface DeviceAuthHandle {
  verificationUrl: string;
  verificationUrlComplete?: string;
  userCode: string;
  poll(): Promise<WizardSession>;
}

interface AuthorizeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval?: number;
  expires_in?: number;
}

interface TokenResponse {
  token: string;
  app_id: string;
  expires_at: number;
}

export async function authenticate(config: WizardConfig): Promise<WizardSession> {
  const auth = await startDeviceAuth(config);
  const url = auth.verificationUrlComplete ?? auth.verificationUrl;

  // Preserve the best-effort browser launch for callers that use this helper
  // directly. The CLI uses startDeviceAuth so it can print fallback details
  // before attempting to open the page.
  try {
    await open(url);
  } catch {
    /* headless / no browser */
  }

  return auth.poll();
}

export async function startDeviceAuth(
  config: WizardConfig,
  signal?: AbortSignal,
): Promise<DeviceAuthHandle> {
  const authorize = await fetchJson<AuthorizeResponse>(
    `${config.apiBaseUrl}/wizard/device/authorize`,
    { method: "POST", body: JSON.stringify({ client: "whisperr-wizard" }), signal },
  );

  const intervalMs = (authorize.interval ?? 5) * 1000;
  const deadline = Date.now() + (authorize.expires_in ?? 600) * 1000;

  return {
    verificationUrl: authorize.verification_uri,
    verificationUrlComplete: authorize.verification_uri_complete,
    userCode: authorize.user_code,
    async poll(): Promise<WizardSession> {
      // Poll for approval.
      let wait = intervalMs;
      while (Date.now() < deadline) {
        await sleep(wait, signal);
        const res = await fetch(
          `${config.apiBaseUrl}/wizard/device/token`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ device_code: authorize.device_code }),
            signal,
          },
        );
        if (res.ok) {
          const tok = (await res.json()) as TokenResponse;
          return { token: tok.token, appId: tok.app_id, expiresAt: tok.expires_at };
        }
        if (res.status === 429) {
          wait += 2000; // slow_down
          continue;
        }
        if (res.status === 428) continue; // authorization_pending
        // 403 deny / 410 expired / anything else: stop.
        throw new Error(
          `Authorization failed (${res.status}). Re-run the wizard and use the printed link and code to try again.`,
        );
      }
      throw new Error(
        "Authorization timed out. Re-run the wizard and use the printed link and code to try again.",
      );
    },
  };
}

/**
 * Wizard sessions slide server-side: every authenticated call (including each
 * LLM gateway request the agent makes) extends the session's 30-minute idle
 * window, up to an absolute cap. Agent phases therefore keep the session
 * alive through their own traffic — the only dead zone is the user parked on
 * an interactive prompt or a long local tool call. This
 * keepalive covers that: a cheap authed ping every few minutes. Failures are
 * swallowed (purely best-effort) and the timer is unref'd so it never holds
 * the process open.
 */
export function startSessionKeepalive(
  config: WizardConfig,
  session: WizardSession,
  intervalMs = 5 * 60_000,
): () => void {
  const timer = setInterval(() => {
    fetch(`${config.apiBaseUrl}/wizard/first-event`, {
      headers: { authorization: `Bearer ${session.token}` },
    }).catch(() => {});
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(
      `${theme.alert("Request failed")}: ${init.method ?? "GET"} ${url} -> ${res.status}`,
    );
  }
  return (await res.json()) as T;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", aborted, { once: true });

    function done(): void {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }

    function aborted(): void {
      clearTimeout(timer);
      reject(signal?.reason);
    }
  });
}
