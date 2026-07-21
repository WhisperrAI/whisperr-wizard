import type { Playbook, Detection, DetectContext } from "../../types.js";

const target = {
  id: "php",
  displayName: "PHP (backend)",
  language: "php",
  availability: "available" as const,
};

// Framework markers in composer.json that confirm a PHP web backend.
const FRAMEWORKS = [
  "laravel/framework",
  "symfony/",
  "slim/slim",
  "laminas/",
  "cakephp/",
  "yiisoft/",
  "codeigniter4/",
];

async function detect(ctx: DetectContext): Promise<Detection | null> {
  if (!(await ctx.exists("composer.json"))) return null;
  const composer = (await ctx.read("composer.json")).toLowerCase();
  const evidence = ["composer.json"];
  let confidence = 0.5;

  if (FRAMEWORKS.some((f) => composer.includes(f))) {
    evidence.push("php framework");
    confidence += 0.35;
  }
  if (await ctx.exists("artisan")) {
    evidence.push("artisan (Laravel)");
    confidence += 0.15;
  }
  return { target, confidence: Math.min(confidence, 0.95), evidence };
}

const systemPrompt = `
## SDK: Whisperr for PHP (server-side) — package \`whisperr/php\` (Laravel facade + service provider included)

This is a BACKEND surface. Instrument events at the real SERVER-SIDE moment they
happen — inside controllers/request handlers, webhook handlers, billing logic,
queued jobs, and console commands. The events in your plan originate on the
server (payments, subscription/lifecycle changes, server-computed thresholds);
they will NOT be in any UI. Do not look for click handlers / Blade views.

The ONE thing that's different from a browser SDK: \`track()\` and \`identify()\`
take the end-user id as the FIRST argument — the server has no session to infer
it from. Source the real user id at each call site.

1) Install:
     composer require whisperr/php

2) Config. Set the key in the environment (.env), never hardcoded:
     WHISPERR_API_KEY=__WHISPERR_INGESTION_KEY__
   The host disables Composer plugins and scripts during installation. For
   Laravel, report \`php artisan package:discover\` as a manual follow-up so the
   included service provider and \`Whisperr\` facade are registered. Do not run
   Artisan from the wizard.
   On non-Laravel PHP, construct one client and reuse it:
     use Whisperr\\Whisperr;
     $whisperr = new Whisperr(['api_key' => getenv('WHISPERR_API_KEY')]);

3) identify(externalUserId, [...]). Where you already know the user (after login/
   signup, or when user-level traits/contact channels change):
     use Whisperr\\Laravel\\Facades\\Whisperr;
     Whisperr::identify(auth()->id(), ['traits' => ['plan' => $user->plan], 'email' => $user->email]);

4) track(externalUserId, eventType, properties). Find the real server-side moment
   and source the user id from what's in scope:
     - In a controller:   Whisperr::track(auth()->id(), 'plan_upgraded', ['plan' => $plan]);
     - In a webhook/job:  no auth() — get the id from the domain object
       (e.g. \$subscription->user_id, or map the Stripe customer to your user):
         Whisperr::track(\$subscription->user_id, 'subscription_cancelled', ['reason' => \$reason]);
   Copy event_type verbatim (snake_case) from the plan. If you genuinely can't
   source a user id at the only sensible site, leave a one-line
   \`// TODO(whisperr): need user id to track <event>\` and move on.
   On plain PHP use \`$whisperr->track(...)\` on your shared instance instead of the facade.

5) Lifecycle. On Laravel the buffered events flush automatically AFTER the
   response is sent (the service provider hooks \`terminating\`), so tracking adds
   no response latency. The client also flushes on shutdown. In short-lived
   scripts/commands call \`Whisperr::flush()\` (or \`$whisperr->flush()\`) before exit.

Notes / gotchas:
- Events buffer in memory during the request and send in a batch on flush. Fire-
  and-forget is fine; don't block on track()/identify().
- track()/identify() no-op silently if the user id is empty — pass a real id
  (guard webhook code where auth() is null).
- Use the same stable user id everywhere so server + client events line up.
`.trim();

export const phpPlaybook: Playbook = {
  target,
  detect,
  packageRef: "whisperr/php (Packagist)",
  systemPrompt,
  verifyCommand: undefined,
};
