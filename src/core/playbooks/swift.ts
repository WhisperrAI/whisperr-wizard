import type { Playbook, Detection, DetectContext } from "../../types.js";

const target = {
  id: "swift",
  displayName: "Swift (iOS)",
  language: "swift",
  availability: "planned" as const,
};

async function detect(ctx: DetectContext): Promise<Detection | null> {
  const evidence: string[] = [];
  let confidence = 0;

  if (await ctx.exists("Package.swift")) {
    evidence.push("Package.swift");
    confidence += 0.6;
  }
  const root = await ctx.list(".");
  if (root.some((f) => f.endsWith(".xcodeproj"))) {
    evidence.push("xcodeproj");
    confidence += 0.5;
  }
  if (root.some((f) => f.endsWith(".xcworkspace"))) {
    evidence.push("xcworkspace");
    confidence += 0.3;
  }
  if (await ctx.exists("Podfile")) {
    evidence.push("Podfile");
    confidence += 0.2;
  }
  if (confidence === 0) return null;
  return { target, confidence: Math.min(confidence, 1), evidence };
}

const systemPrompt = `
## SDK: Whisperr for Swift (iOS) — Swift Package \`Whisperr\`

1) Add the Swift Package dependency (github.com/WhisperrAI/whisperr-swift). If the
   project uses Package.swift, add it there; if it's an .xcodeproj/.xcworkspace,
   you cannot edit the project graph reliably from the shell — instead leave a
   clearly commented setup note and the exact import + init code, and report it
   as a manual follow-up.

2) Initialize once at launch in the App struct (SwiftUI) or
   application(_:didFinishLaunchingWithOptions:) (UIKit):
     import Whisperr
     Whisperr.initialize(apiKey: "<key>", baseUrl: "<manifest baseUrl>")

3) identify() after the user is known / on session restore:
     Whisperr.shared.identify("<external user id>", traits: [...], email: ..., phone: ...)
   reset() on logout. Push channel = APNs device token if the app registers for
   remote notifications.

4) track() in action handlers / view-model methods, not in view body:
     Whisperr.shared.track("event_type_from_manifest", properties: [ ... ])
   event_type verbatim (snake_case) from the manifest.

Notes:
- Prefer reading the key from Info.plist / an xcconfig if the project uses one.
- Do not attempt to run xcodebuild; verification is the human's step here.
`.trim();

export const swiftPlaybook: Playbook = {
  target,
  detect,
  packageRef: "Whisperr (Swift Package)",
  systemPrompt,
};
