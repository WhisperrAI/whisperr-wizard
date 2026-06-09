import type { Playbook, Detection, DetectContext } from "../../types.js";

const target = {
  id: "web-js",
  displayName: "Web (JavaScript / TypeScript)",
  language: "typescript",
  // Flip to "available" once @whisperr/web ships (Phase 2).
  availability: "planned" as const,
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
## SDK: Whisperr for Web (TypeScript/JavaScript) — package \`@whisperr/web\`

1) Dependency. Install with the repo's package manager (detect pnpm/yarn/npm
   from the lockfile): \`<pm> add @whisperr/web\`.

2) Initialize once at app entry (e.g. src/main.tsx, src/index.ts, or the root
   layout). Create a singleton client:
     import { Whisperr } from '@whisperr/web';
     export const whisperr = Whisperr.init({
       apiKey: import.meta.env.VITE_WHISPERR_KEY, // or process.env.NEXT_PUBLIC_... etc
       baseUrl: '<INGESTION_BASE_URL from manifest>',
     });
   Put the key in the project's env mechanism (Vite VITE_*, CRA REACT_APP_*,
   plain .env) and write the example var into .env / .env.example.

3) identify(). After auth resolves (login success, and on app load if a session
   is restored):
     whisperr.identify(user.id, {
       traits: { /* manifest traits */ },
       email: user.email, phone: user.phone,
     });
   Call whisperr.reset() on logout.

4) track(). For each manifest event, instrument the real handler:
     whisperr.track('event_type_from_manifest', { /* properties */ });
   In React, this belongs in event handlers / effects / mutation callbacks, not
   in render. Copy event_type verbatim (snake_case) from the manifest.

Notes:
- The SDK batches via /v1/events/batch and flushes on a timer + on
  visibilitychange/unload (sendBeacon). Fire-and-forget is fine.
- Only the NEXT_PUBLIC_/VITE_-style public env vars are exposed to the browser;
  the ingestion key is a public, rate-limited key so that is expected.
- If the project uses an analytics wrapper/provider pattern, follow it rather
  than scattering raw whisperr.track calls.
`.trim();

export const webPlaybook: Playbook = {
  target,
  detect,
  packageRef: "@whisperr/web (npm)",
  systemPrompt,
  verifyCommand: undefined,
};
