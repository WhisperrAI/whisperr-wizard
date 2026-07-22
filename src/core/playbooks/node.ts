import type { Playbook, Detection, DetectContext } from "../../types.js";

const target = {
  id: "node",
  displayName: "Node.js (backend)",
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

const BACKEND_FRAMEWORKS = [
  "express",
  "fastify",
  "koa",
  "@nestjs/core",
  "hapi",
  "@hapi/hapi",
  "restify",
  "hono",
  "h3",
  "@adonisjs/core",
];

// Frontend frameworks mean this is a client app — the wrong target for the
// *backend* SDK. The web / nextjs / react-native playbooks own those.
const FRONTEND_FRAMEWORKS = [
  "react",
  "vue",
  "svelte",
  "@angular/core",
  "next",
  "react-native",
  "expo",
];

const SERVER_ENTRYPOINTS = [
  "server.js",
  "server.ts",
  "src/server.ts",
  "src/server.js",
  "app.js",
  "src/app.ts",
  "src/index.ts",
  "index.js",
];

async function detect(ctx: DetectContext): Promise<Detection | null> {
  if (!(await ctx.exists("package.json"))) return null;
  const pkgJson = await ctx.read("package.json");
  const evidence = ["package.json"];
  let confidence = 0;

  if (dependsOn(pkgJson, BACKEND_FRAMEWORKS)) {
    evidence.push("backend framework dependency");
    confidence += 0.7;
  }

  const hasFrontend = dependsOn(pkgJson, FRONTEND_FRAMEWORKS);
  const hasIndexHtml = await ctx.exists("index.html");
  // Purely a frontend app and no backend signal → defer to the frontend
  // playbooks rather than wiring the server SDK into a browser bundle.
  if ((hasFrontend || hasIndexHtml) && confidence === 0) return null;

  for (const f of SERVER_ENTRYPOINTS) {
    if (await ctx.exists(f)) {
      evidence.push(f);
      confidence += 0.15;
      break;
    }
  }

  // No known framework, but a node-style start script and no frontend → still a
  // backend worth instrumenting (custom http server, worker, etc.).
  if (confidence === 0 && !hasFrontend && !hasIndexHtml) {
    try {
      const pkg = JSON.parse(pkgJson);
      const start = String(pkg.scripts?.start ?? "");
      if (/\b(node|nodemon|ts-node|tsx)\b/.test(start)) {
        // Outranks the generic web playbook's package.json-only 0.4 floor.
        evidence.push("node start script");
        confidence += 0.5;
      }
    } catch {
      /* unparseable package.json — leave confidence as is */
    }
  }

  if (confidence === 0) return null;
  return { target, confidence: Math.min(confidence, 0.95), evidence };
}

const systemPrompt = `
## SDK: Whisperr for Node (server-side) — package \`@whisperr/node\` (+ \`@whisperr/node/express\` for Express)

This is a BACKEND surface. Instrument events at the real SERVER-SIDE moment they
happen — inside request handlers, webhook handlers, billing logic, queue/cron
jobs, and service methods. The events in your plan are the ones that originate on
the server (payments, subscription/lifecycle changes, server-computed
thresholds); they will NOT be in any UI. Do not look for click/screen handlers.

The ONE thing that's different from the browser SDK: \`track()\` and
\`identify()\` take the end-user id as the FIRST argument — the server has no
persisted session to infer it from. Source the real user id at each call site.

1) Install (detect pnpm/yarn/npm from the lockfile):
     <pm> add @whisperr/node

2) Create one shared client module, e.g. src/whisperr.ts (or .js):
     import { createWhisperr } from '@whisperr/node';
     export const whisperr = createWhisperr({
       apiKey: process.env.WHISPERR_API_KEY!,
       baseUrl: '__WHISPERR_INGESTION_BASE_URL__', // omit if it's the default
     });
   Put WHISPERR_API_KEY in the app's server config and add it to .env /
   .env.example. This is a SERVER env var — never a public/VITE_/NEXT_PUBLIC_ one.

3) identify(externalUserId, { ... }). Call where you already know the user —
   after signup, or when user-level traits/contact channels change:
     whisperr.identify(user.id, { traits: { plan: user.plan }, email: user.email });
   Use the same stable id you use everywhere else for that user, so server and
   client events land on one timeline.

4) track(externalUserId, eventType, properties). For each plan event, find the
   real server-side moment and source the user id from what's in scope:
     - In a request handler:   whisperr.track(req.user.id, 'plan_upgraded', { plan });
     - In a webhook/cron/job:  there's no request — get the id from the domain
       object (e.g. subscription.userId, or map the Stripe customer to your user):
         whisperr.track(subscription.userId, 'subscription_cancelled', { reason });
   Copy event_type verbatim (snake_case) from the plan. If you genuinely can't
   source a user id at the only sensible site, leave a one-line
   \`// TODO(whisperr): need user id to track <event>\` and move on.

5) Express only — if this app uses Express, mount the adapter AFTER auth so the
   user is resolvable, then use the per-request helper at call sites:
     import { whisperrExpress } from '@whisperr/node/express';
     app.use(whisperrExpress(whisperr)); // pass { resolveUser } if your auth isn't req.user.id
     // ...later, in a route:
     req.whisperr.track('payment_failed', { amount_cents });

6) Lifecycle. Flush on graceful shutdown so queued events aren't lost:
     process.on('SIGTERM', () => { whisperr.shutdown(); });
   In serverless handlers (Lambda/Vercel/Cloud Functions), \`await whisperr.flush()\`
   before returning, since the runtime freezes after the response.

Notes / gotchas:
- The client queues + batches + retries automatically. Fire-and-forget is fine;
  do NOT await track()/identify() — only await flush()/shutdown().
- track()/identify() no-op silently if the user id is empty — make sure you pass
  a real id.
- One client instance per process (the exported singleton). Don't create a new
  client per request.
`.trim();

export const nodePlaybook: Playbook = {
  target,
  detect,
  packageRef: "@whisperr/node (npm)",
  systemPrompt,
  verifyCommand: undefined,
};
