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
  if (config.offline) return offlineSession();

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
): Promise<DeviceAuthHandle> {
  const authorize = await fetchJson<AuthorizeResponse>(
    `${config.apiBaseUrl}/wizard/device/authorize`,
    { method: "POST", body: JSON.stringify({ client: "whisperr-wizard" }) },
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
        await sleep(wait);
        const res = await fetch(
          `${config.apiBaseUrl}/wizard/device/token`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ device_code: authorize.device_code }),
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

/** Used in --offline mode: no backend, fixed dev app. */
function offlineSession(): WizardSession {
  return {
    token: "offline-dev-token",
    appId: "app_offline_dev",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
