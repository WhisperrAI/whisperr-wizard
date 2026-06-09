import type { Playbook, Detection, DetectContext } from "../../types.js";

const target = {
  id: "react-native",
  displayName: "React Native",
  language: "typescript",
  availability: "planned" as const,
};

async function detect(ctx: DetectContext): Promise<Detection | null> {
  if (!(await ctx.exists("package.json"))) return null;
  const pkgJson = await ctx.read("package.json");
  let match = false;
  try {
    const pkg = JSON.parse(pkgJson);
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    match = "react-native" in all || "expo" in all;
  } catch {
    match = false;
  }
  if (!match) return null;
  const evidence = ["react-native / expo dependency"];
  let confidence = 0.85;
  if (await ctx.exists("app.json")) {
    evidence.push("app.json");
    confidence += 0.1;
  }
  return { target, confidence: Math.min(confidence, 1), evidence };
}

const systemPrompt = `
## SDK: Whisperr for React Native — package \`@whisperr/react-native\`

1) Install \`@whisperr/react-native\` with the repo's package manager. If it has
   native modules, run pod install for iOS (mention it; don't attempt to build).

2) Initialize once at the app root (App.tsx / app/_layout.tsx for Expo Router):
     import { Whisperr } from '@whisperr/react-native';
     Whisperr.init({ apiKey: <key from manifest/env>, baseUrl: <manifest baseUrl> });

3) identify() after auth resolves / on session restore; reset() on logout.
   For channels: email/phone where known, and the push token (expo-notifications
   or @react-native-firebase/messaging) if the app has push set up.

4) track() in event handlers / business logic, never in render. event_type
   verbatim from the manifest.

Notes:
- Persisted offline queue is built in (AsyncStorage); fire-and-forget is fine.
- Prefer an env/config mechanism (react-native-config, app.config) for the key
  if one exists; otherwise a constants file is acceptable.
`.trim();

export const reactNativePlaybook: Playbook = {
  target,
  detect,
  packageRef: "@whisperr/react-native (npm)",
  systemPrompt,
};
