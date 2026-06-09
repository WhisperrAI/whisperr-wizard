import type { Playbook, Detection, DetectContext } from "../../types.js";

const target = {
  id: "web-js",
  displayName: "Web (JavaScript / TypeScript)",
  language: "typescript",
  availability: "available" as const,
};

/** True if package.json depends on any of `names`. */
function dependsOn(pkgJson: string, names: string[]): boolean {
  try {
    const pkg = JSON.parse(pkgJson);
    const all = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    } as Record<string, string>;
    return names.some((n) => n in all);
  } catch {
    return false;
  }
}

async function detect(ctx: DetectContext): Promise<Detection | null> {
  if (!(await ctx.exists("package.json"))) return null;
  const pkgJson = await ctx.read("package.json");
  const evidence = ["package.json"];
  let confidence = 0.4;

  // Defer to the more specific playbooks when their frameworks are present.
  if (dependsOn(pkgJson, ["next"])) return null;
  if (dependsOn(pkgJson, ["react-native", "expo"])) return null;

  if (dependsOn(pkgJson, ["react", "vue", "svelte", "@angular/core"])) {
    evidence.push("frontend framework dependency");
    confidence += 0.4;
  }
  if (await ctx.exists("index.html")) {
    evidence.push("index.html");
    confidence += 0.1;
  }
  return { target, confidence: Math.min(confidence, 0.95), evidence };
}

const systemPrompt = `
## SDK: Whisperr for Web — package \`@whisperr/web\` (+ \`@whisperr/react\` for React)

1) Install (detect pnpm/yarn/npm from the lockfile):
   - Vanilla / Vue / Svelte / Angular / plain TS: \`<pm> add @whisperr/web\`
   - React (not Next.js): \`<pm> add @whisperr/react @whisperr/web\`

2) Initialize once at app entry, using the app's PUBLIC env var (VITE_*,
   REACT_APP_*, etc.). Write the var into .env / .env.example.
   - Core (any framework): create a singleton in e.g. src/whisperr.ts:
       import { Whisperr } from '@whisperr/web';
       export const whisperr = Whisperr.init({
         apiKey: import.meta.env.VITE_WHISPERR_KEY,
         baseUrl: '<INGESTION_BASE_URL from manifest>', // omit if it's the default
       });
   - React: wrap the app root instead of a bare singleton:
       import { WhisperrProvider } from '@whisperr/react';
       <WhisperrProvider apiKey={import.meta.env.VITE_WHISPERR_KEY}>…</WhisperrProvider>

3) identify(). After auth resolves (login success, and on app load if a session
   is restored):
       whisperr.identify(user.id, { traits: { /* manifest traits */ }, email: user.email, phone: user.phone });
   React: const whisperr = useWhisperr();  then whisperr.identify(...).
   Call whisperr.reset() on logout.

4) track(). For each manifest event, instrument the real handler:
       whisperr.track('event_type_from_manifest', { /* properties */ });
   In React this belongs in event handlers / effects / mutation callbacks, never
   in render. Copy event_type verbatim (snake_case) from the manifest.

Notes:
- The SDK batches + flushes automatically (timer + on page hide). Fire-and-forget
  is fine; do NOT await track().
- It auto-captures pageviews — you only add the named business events.
- Only PUBLIC env vars (VITE_/REACT_APP_/NEXT_PUBLIC_) reach the browser; the
  ingestion key is meant to be public + rate-limited, so that's expected.
`.trim();

export const webPlaybook: Playbook = {
  target,
  detect,
  packageRef: "@whisperr/web (npm)",
  systemPrompt,
  verifyCommand: undefined,
};
