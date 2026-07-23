import type { Playbook, Detection, DetectContext } from "../../types.js";

const target = {
  id: "react-native",
  displayName: "React Native / Expo",
  language: "typescript",
  availability: "available" as const,
};

async function detect(ctx: DetectContext): Promise<Detection | null> {
  if (!(await ctx.exists("package.json"))) return null;
  const pkgJson = await ctx.read("package.json");
  let hasRN = false;
  let hasExpo = false;
  try {
    const pkg = JSON.parse(pkgJson);
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    hasRN = "react-native" in all;
    hasExpo = "expo" in all;
  } catch {
    /* unparseable package.json — no match */
  }
  if (!hasRN && !hasExpo) return null;

  const evidence: string[] = [];
  if (hasExpo) evidence.push("expo dependency");
  if (hasRN) evidence.push("react-native dependency");
  let confidence = 0.85;
  if (await ctx.exists("app.json")) {
    evidence.push("app.json");
    confidence += 0.1;
  } else if ((await ctx.exists("app.config.js")) || (await ctx.exists("app.config.ts"))) {
    evidence.push("app.config");
    confidence += 0.1;
  }
  return { target, confidence: Math.min(confidence, 1), evidence };
}

const systemPrompt = `
## SDK: Whisperr for React Native — package \`@whisperr/react-native\`

Pure TypeScript, ZERO native code and zero dependencies of its own: it works in
Expo Go, bare React Native, and dev clients with no pod install, no config
plugin, no prebuild. Do not add or modify anything under ios/ or android/ for
the SDK itself.

0) Expo or bare? Decide first — it changes storage install + key handling.
   Expo = \`expo\` in package.json dependencies (usually with app.json /
   app.config.* containing an "expo" key).

1) Install with the repo's package manager (pick by lockfile: pnpm-lock.yaml →
   pnpm, yarn.lock → yarn, bun.lockb → bun, else npm):
       <pm> add @whisperr/react-native

2) Durable storage — IMPORTANT. The SDK's offline queue is MEMORY-ONLY unless
   you inject an AsyncStorage-compatible adapter (\`getItem\`/\`setItem\`/
   \`removeItem\`); the SDK never imports native modules itself. In priority
   order:
   - \`@react-native-async-storage/async-storage\` already a dependency → import
     it and pass as \`storage\`.
   - The app already uses \`react-native-mmkv\` → reuse its existing instance
     with a 3-line adapter (do NOT add a new storage dep):
       const storage = {
         getItem: (k: string) => mmkv.getString(k) ?? null,
         setItem: (k: string, v: string) => { mmkv.set(k, v); },
         removeItem: (k: string) => { mmkv.delete(k); },
       };
   - Neither → add async-storage. Expo: run \`npx expo install
     @react-native-async-storage/async-storage\` via bash (installs the
     SDK-matched version; works in Expo Go — it ships in the Go client). Bare
     RN: \`<pm> add @react-native-async-storage/async-storage\` and note
     "run npx pod-install before the next iOS build" as a follow-up (it IS a
     native module; do not run pod install yourself).
   Never silently ship without storage — if you genuinely can't add it, say so
   in the summary.

3) Initialize ONCE via a module singleton, e.g. src/whisperr.ts (match the
   repo's source layout — src/, lib/, app/lib/…):
       import AsyncStorage from '@react-native-async-storage/async-storage';
       import { Whisperr } from '@whisperr/react-native';

       export const whisperr = Whisperr.init({
         apiKey: process.env.EXPO_PUBLIC_WHISPERR_KEY!,
         storage: AsyncStorage,
         baseUrl: '<INGESTION_BASE_URL from manifest>', // omit if it's the SDK default
       });
   Import the module for its side effect from the app entry: Expo Router →
   app/_layout.tsx (root layout); bare / React Navigation → App.tsx (or
   index.js). Prefer the singleton over <WhisperrProvider> — auth listeners,
   API clients, and non-component code can import it directly. If the codebase
   is strongly hook-oriented you may ADDITIONALLY wrap the root with
   <WhisperrProvider client={whisperr}> and use useWhisperr() in components —
   but never create a second client.
   Whisperr.init() is an idempotent singleton — safe under Fast Refresh and
   React StrictMode.

   Key handling (the key is a publishable ingestion key — shipping it in the
   bundle is expected):
   - Expo SDK 49+: put EXPO_PUBLIC_WHISPERR_KEY=<key> in .env (create or
     append) and mirror it in .env.example; reference via
     process.env.EXPO_PUBLIC_WHISPERR_KEY.
   - Bare RN with react-native-config: add WHISPERR_KEY to .env and read
     Config.WHISPERR_KEY.
   - Otherwise: a small constants file with the literal key is acceptable.

4) identify() right after the end-user is known — on login/signup success AND
   on session restore at app startup:
       whisperr.identify(user.id, {
         traits: { /* manifest traits sourced from the user object */ },
         email: user.email,           // shortcut → opted-in email channel
         phone: user.phone,           // shortcut → sms channel
         pushToken: expoPushToken,    // shortcut → push channel, if the app
                                      // registers for push (expo-notifications
                                      // or @react-native-firebase/messaging)
       });
   Call whisperr.reset() on logout (already-queued events keep their user).
   ANONYMOUS EVENTS ARE FINE: track() before identify() buffers on-device and
   attributes to the user retroactively on identify() — do NOT gate track()
   calls behind auth state, and do NOT skip pre-login manifest events.

5) track() in event handlers / business logic (onPress, mutation onSuccess,
   store/saga/thunk actions) — never in render:
       whisperr.track('event_type_from_manifest', { /* properties in scope */ });
   Synchronous fire-and-forget: it returns void — do NOT await it. Batching,
   retries, background flush are all internal. event_type verbatim snake_case
   from the manifest — the SDK client-side drops invalid names.

Notes / gotchas:
- Every call is sync void except flush(); the only sensible manual flush is
  \`await whisperr.flush()\` right before something destroys the process.
- The SDK auto-flushes on an interval, at 20 queued events, and when the app
  backgrounds. Don't sprinkle flush() calls.
- whisperr.screen(name) records a screen_viewed event — wire it to the
  navigation container's state-change callback ONLY if the manifest includes a
  screen/page-view style event; otherwise leave navigation alone.
- Works on the New Architecture and in Expo Go by construction (no native
  code). Never suggest expo prebuild / dev-client for this SDK.
`.trim();

export const reactNativePlaybook: Playbook = {
  target,
  detect,
  packageRef: "@whisperr/react-native (npm)",
  systemPrompt,
};
