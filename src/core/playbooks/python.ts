import type { Playbook, Detection, DetectContext } from "../../types.js";

const target = {
  id: "python",
  displayName: "Python (backend)",
  language: "python",
  availability: "available" as const,
};

const PROJECT_FILES = [
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "setup.cfg",
  "Pipfile",
];

// Substrings that, if found in the dependency files, mark this as a Python web
// backend worth instrumenting.
const WEB_FRAMEWORKS = [
  "django",
  "flask",
  "fastapi",
  "starlette",
  "sanic",
  "aiohttp",
  "tornado",
  "bottle",
  "falcon",
  "litestar",
];

async function detect(ctx: DetectContext): Promise<Detection | null> {
  const present: string[] = [];
  for (const f of PROJECT_FILES) {
    if (await ctx.exists(f)) present.push(f);
  }
  const hasManage = await ctx.exists("manage.py");
  if (present.length === 0 && !hasManage) return null;

  const evidence = [...present];
  let confidence = present.length ? 0.5 : 0.3;

  let deps = "";
  for (const f of present) deps += (await ctx.read(f)).toLowerCase() + "\n";
  if (WEB_FRAMEWORKS.some((fw) => deps.includes(fw))) {
    evidence.push("python web framework");
    confidence += 0.35;
  }
  if (hasManage) {
    evidence.push("manage.py");
    confidence += 0.2;
  }

  return { target, confidence: Math.min(confidence, 0.95), evidence };
}

const systemPrompt = `
## SDK: Whisperr for Python (server-side) — package \`whisperr\` (Django middleware in \`whisperr.django\`)

This is a BACKEND surface. Instrument events at the real SERVER-SIDE moment they
happen — inside views/request handlers, webhook handlers, billing logic, Celery
tasks, and management commands. The events in your plan originate on the server
(payments, subscription/lifecycle changes, server-computed thresholds); they will
NOT be in any UI. Do not look for click/screen handlers.

The ONE thing that's different from a browser SDK: \`track()\` and \`identify()\`
take the end-user id as the FIRST argument — the server has no persisted session
to infer it from. Source the real user id at each call site.

1) Install (detect the project's tool — pip/poetry/pipenv/uv from the lockfile or
   pyproject): add \`whisperr\` (use \`whisperr[django]\` on a Django project).

2) Create one shared client, e.g. app/whisperr_client.py:
     import os
     from whisperr import Whisperr
     whisperr = Whisperr(
         api_key=os.environ["WHISPERR_API_KEY"],
         base_url="__WHISPERR_INGESTION_BASE_URL__",  # omit if it's the default
     )
   Put WHISPERR_API_KEY in the app's server config / .env (server-side secret).

3) identify(external_user_id, ...). Where you already know the user (signup, or
   when user-level traits/contact channels change):
     whisperr.identify(user.id, traits={"plan": user.plan}, email=user.email)

4) track(external_user_id, event_type, properties). Find the real server-side
   moment and source the user id from what's in scope:
     - In a handler/view:   whisperr.track(request.user.id, "plan_upgraded", {"plan": plan})
     - In a webhook/task:   there's no request — get the id from the domain object
       (e.g. subscription.user_id, or map the Stripe customer to your user):
         whisperr.track(subscription.user_id, "subscription_cancelled", {"reason": reason})
   Copy event_type verbatim (snake_case) from the plan. If you genuinely can't
   source a user id at the only sensible site, leave a one-line
   \`# TODO(whisperr): need user id to track <event>\` and move on.

5) Django only — register the middleware AFTER the auth middleware in settings.py,
   then use the per-request helper in views:
     # settings.py
     WHISPERR_API_KEY = os.environ["WHISPERR_API_KEY"]
     MIDDLEWARE = [ ..., "django.contrib.auth.middleware.AuthenticationMiddleware",
                    "whisperr.django.WhisperrMiddleware" ]
     # views.py
     request.whisperr.track("payment_failed", {"amount_cents": amount})
   For Celery/webhook/management-command code (no request), use the shared client
   or whisperr.django.get_client() with the user id from your data.

6) Lifecycle. The client flushes in the background and on interpreter exit
   (atexit). In short-lived processes (management commands, scripts, serverless),
   call \`whisperr.flush()\` before returning so queued events aren't lost.

Notes / gotchas:
- The client queues + batches + retries automatically on a daemon thread. Fire-
  and-forget is fine; do NOT block on track()/identify() — only flush()/shutdown().
- track()/identify() no-op silently if the user id is empty — pass a real id.
- One client instance per process. Don't construct a new client per request.
`.trim();

export const pythonPlaybook: Playbook = {
  target,
  detect,
  packageRef: "whisperr (PyPI)",
  systemPrompt,
  verifyCommand: undefined,
};
