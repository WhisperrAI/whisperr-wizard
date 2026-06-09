import type { Playbook, Detection, DetectContext } from "../../types.js";

const target = {
  id: "flutter",
  displayName: "Flutter",
  language: "dart",
  availability: "available" as const,
};

async function detect(ctx: DetectContext): Promise<Detection | null> {
  const evidence: string[] = [];
  let confidence = 0;

  if (await ctx.exists("pubspec.yaml")) {
    evidence.push("pubspec.yaml");
    confidence += 0.6;
    const pubspec = await ctx.read("pubspec.yaml");
    if (/\bflutter\s*:/.test(pubspec) || /sdk:\s*flutter/.test(pubspec)) {
      evidence.push("flutter sdk in pubspec");
      confidence += 0.3;
    }
  }
  if (await ctx.exists("lib/main.dart")) {
    evidence.push("lib/main.dart");
    confidence += 0.2;
  }
  if (confidence === 0) return null;
  return { target, confidence: Math.min(confidence, 1), evidence };
}

const systemPrompt = `
## SDK: Whisperr for Flutter (Dart) — package \`whisperr\`

This SDK is published on pub.dev. Integrate it as follows.

1) Dependency. Add to pubspec.yaml under dependencies:
     whisperr: ^0.2.0
   Then the SDK expects \`flutter pub get\` to be run (run it via bash).

2) Initialize once, early, before runApp(), in lib/main.dart:
     import 'package:whisperr/whisperr.dart';
     await Whisperr.initialize(
       apiKey: '<INGESTION_API_KEY from manifest>',
       baseUrl: '<INGESTION_BASE_URL from manifest>', // omit if it equals the SDK default
     );
   If main() is not async, make it async and \`await\` the initialize call, or use
   WidgetsFlutterBinding.ensureInitialized() first.

3) identify(). Call right after the end-user is known — after successful
   login/signup and on session restore at startup:
     await Whisperr.instance.identify(
       '<stable external user id>',
       traits: { /* manifest traits, e.g. 'plan': user.plan */ },
       email: user.email,        // optional shortcut -> opted-in email channel
       phone: user.phone,        // optional shortcut -> SMS channel
       pushToken: fcmToken,      // optional shortcut -> push channel
     );
   Use the app's real stable id (auth uid / customer id), never a device id.
   On logout call \`await Whisperr.instance.reset();\`.

4) track(). For each manifest event, find where that user action actually
   happens and add:
     await Whisperr.instance.track('event_type_from_manifest', properties: { ... });
   event_type must be snake_case and copied verbatim from the manifest.

Notes / gotchas:
- The SDK queues + batches automatically; you do NOT need to await every track
  for delivery — awaiting just enqueues. Fire-and-forget is fine in UI handlers.
- Do not call track() inside build() methods or render loops — only in event
  handlers / business logic (onPressed, on success of an API call, in a bloc/
  cubit/provider action, etc.).
- Hardcoding the API key in Dart is acceptable for a client SDK (it is an
  ingestion key, scoped + rate-limited), but prefer --dart-define / a config
  file if the project already uses one.
- Verify with \`flutter analyze\`.
`.trim();

export const flutterPlaybook: Playbook = {
  target,
  detect,
  packageRef: "whisperr (pub.dev)",
  systemPrompt,
  verifyCommand: "flutter analyze",
};
