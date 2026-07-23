import assert from "node:assert/strict";
import test from "node:test";
import { authenticate, startDeviceAuth, startSessionKeepalive } from "../src/core/auth.js";
import type { WizardConfig } from "../src/types.js";

const config = {
  apiBaseUrl: "https://example.invalid",
  offline: false,
} as WizardConfig;

test("startDeviceAuth returns verification details from authorize", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        device_code: "device-123",
        user_code: "WZRD-1234",
        verification_uri: "https://example.invalid/activate",
        verification_uri_complete: "https://example.invalid/activate?code=WZRD-1234",
        interval: 0,
        expires_in: 600,
      }),
      { status: 200 },
    )) as typeof fetch;

  try {
    const auth = await startDeviceAuth(config);

    assert.equal(auth.verificationUrl, "https://example.invalid/activate");
    assert.equal(
      auth.verificationUrlComplete,
      "https://example.invalid/activate?code=WZRD-1234",
    );
    assert.equal(auth.userCode, "WZRD-1234");
    assert.equal(typeof auth.poll, "function");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("poll keeps waiting on 428 and resolves the session on 200", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          device_code: "device-456",
          user_code: "WZRD-5678",
          verification_uri: "https://example.invalid/activate",
          interval: 0,
          expires_in: 600,
        }),
        { status: 200 },
      );
    }
    if (calls.length === 2) return new Response(null, { status: 428 });
    return new Response(
      JSON.stringify({
        token: "session-token",
        app_id: "app-123",
        expires_at: 1_800_000_000,
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const auth = await startDeviceAuth(config);
    const session = await auth.poll();

    assert.deepEqual(session, {
      token: "session-token",
      appId: "app-123",
      expiresAt: 1_800_000_000,
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[1]!.url, "https://example.invalid/wizard/device/token");
    assert.equal(calls[2]!.url, "https://example.invalid/wizard/device/token");
    assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), {
      device_code: "device-456",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("authenticate returns the offline session without fetching", async () => {
  const realFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error("offline authentication must not fetch");
  }) as typeof fetch;

  try {
    const session = await authenticate({ ...config, offline: true });

    assert.equal(session.token, "offline-dev-token");
    assert.equal(session.appId, "app_offline_dev");
    assert.ok(session.expiresAt > Math.floor(Date.now() / 1000));
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("startSessionKeepalive pings on the interval and stops cleanly", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const stop = startSessionKeepalive(
      config,
      { token: "tok", appId: "app_1", expiresAt: 0 },
      1_000,
    );
    t.mock.timers.tick(3_000);
    assert.equal(calls, 3);
    stop();
    t.mock.timers.tick(3_000);
    assert.equal(calls, 3, "no pings after stop()");
  } finally {
    globalThis.fetch = realFetch;
    t.mock.timers.reset();
  }
});

test("startSessionKeepalive is a no-op offline", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const stop = startSessionKeepalive(
      { ...config, offline: true } as typeof config,
      { token: "tok", appId: "app_1", expiresAt: 0 },
      1_000,
    );
    t.mock.timers.tick(5_000);
    assert.equal(calls, 0);
    stop();
  } finally {
    globalThis.fetch = realFetch;
    t.mock.timers.reset();
  }
});
