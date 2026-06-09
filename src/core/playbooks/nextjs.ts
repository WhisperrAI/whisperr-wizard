import type { Playbook, Detection, DetectContext } from "../../types.js";

const target = {
  id: "nextjs",
  displayName: "Next.js",
  language: "typescript",
  availability: "planned" as const,
};

async function detect(ctx: DetectContext): Promise<Detection | null> {
  if (!(await ctx.exists("package.json"))) return null;
  const pkgJson = await ctx.read("package.json");
  let isNext = false;
  try {
    const pkg = JSON.parse(pkgJson);
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    isNext = "next" in all;
  } catch {
    isNext = false;
  }
  if (!isNext && !(await ctx.exists("next.config.js")) && !(await ctx.exists("next.config.mjs")))
    return null;
  const evidence = ["next dependency"];
  let confidence = 0.85;
  if (await ctx.exists("app")) {
    evidence.push("app/ router");
    confidence += 0.1;
  } else if (await ctx.exists("pages")) {
    evidence.push("pages/ router");
    confidence += 0.05;
  }
  return { target, confidence: Math.min(confidence, 1), evidence };
}

const systemPrompt = `
## SDK: Whisperr for Web in Next.js — package \`@whisperr/web\`

Same SDK as plain web, with Next-specific wiring.

1) Install \`@whisperr/web\`. Put the key in NEXT_PUBLIC_WHISPERR_KEY in
   .env.local (and add it to .env.example).

2) Whisperr runs client-side. Create a client provider:
   - App Router: a 'use client' component (e.g. app/whisperr-provider.tsx) that
     calls Whisperr.init(...) in a useEffect and renders children; mount it in
     app/layout.tsx.
   - Pages Router: init in pages/_app.tsx inside a useEffect.

3) identify() after auth resolves on the client (e.g. in your auth/session
   hook). reset() on sign-out.

4) track() in client components / event handlers / mutation callbacks. Do NOT
   call track from server components, route handlers, or getServerSideProps —
   this SDK is a browser client. Copy event_type verbatim from the manifest.

Notes:
- Guard against double-init under React Strict Mode (init is idempotent, but
  wire it so it only runs once).
`.trim();

export const nextjsPlaybook: Playbook = {
  target,
  detect,
  packageRef: "@whisperr/web (npm)",
  systemPrompt,
};
