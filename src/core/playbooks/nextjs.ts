import type { Playbook, Detection, DetectContext } from "../../types.js";

const target = {
  id: "nextjs",
  displayName: "Next.js",
  language: "typescript",
  availability: "available" as const,
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
## SDK: Whisperr for Next.js — package \`@whisperr/next\` (+ \`@whisperr/web\`)

1) Install: \`<pm> add @whisperr/next @whisperr/web\`. Put the key in
   NEXT_PUBLIC_WHISPERR_KEY in .env.local (and add it to .env.example).

2) Mount the provider in app/layout.tsx. It is already a 'use client' boundary,
   so it drops straight into the server-component layout — no wrapper file needed:
     import { WhisperrProvider } from '@whisperr/next';
     // inside <body>:
     <WhisperrProvider apiKey={process.env.NEXT_PUBLIC_WHISPERR_KEY!}>{children}</WhisperrProvider>
   Pages Router: wrap the tree in pages/_app.tsx with <WhisperrProvider apiKey=...>.

3) identify() after auth resolves on the client (in your session hook/effect);
   reset() on sign-out. Use the useWhisperr() hook inside 'use client' components.

4) track() in client components / event handlers / mutation callbacks:
     'use client';
     import { useWhisperr } from '@whisperr/next';
     const whisperr = useWhisperr();
     whisperr.track('generated_event_code', { ... });
   Do NOT call track from server components, route handlers, or getServerSideProps —
   it is a browser client. Copy the event code verbatim from the current server model.

Notes:
- Pageviews are auto-captured via the History API (covers Next client navigation).
- Provider init is idempotent (safe under React Strict Mode).
`.trim();

export const nextjsPlaybook: Playbook = {
  target,
  detect,
  packageRef: "@whisperr/next (npm)",
  systemPrompt,
};
