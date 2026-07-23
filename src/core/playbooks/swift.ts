import type { Playbook, Detection, DetectContext } from "../../types.js";

const target = {
  id: "swift",
  displayName: "Swift (iOS / Apple)",
  language: "swift",
  availability: "available" as const,
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
  if (await ctx.exists("Project.swift")) {
    evidence.push("Project.swift (Tuist)");
    confidence += 0.4;
  }
  if (await ctx.exists("project.yml")) {
    evidence.push("project.yml (XcodeGen)");
    confidence += 0.3;
  }
  if (confidence === 0) return null;
  return { target, confidence: Math.min(confidence, 1), evidence };
}

const systemPrompt = `
## SDK: Whisperr for Swift — Swift Package \`Whisperr\` (github.com/WhisperrAI/whisperr-swift)

Platforms: iOS 13+, macOS 12+, tvOS 13+, watchOS 6+. The client is a Swift
ACTOR: every call is \`await\`ed, and identify()/track() are throwing. Getting
the concurrency and JSONValue details below right is what makes the diff
compile first try.

1) Dependency — pick by how the project is defined:
   - Package.swift: add to the package's dependencies
         .package(url: "https://github.com/WhisperrAI/whisperr-swift.git", from: "0.1.0")
     and \`"Whisperr"\` to the app target's dependencies array.
   - Tuist (Project.swift) or XcodeGen (project.yml): these manifests are plain
     text — add the SPM package + product there following the file's existing
     style.
   - Raw .xcodeproj / .xcworkspace only: do NOT hand-edit project.pbxproj to
     add a package reference (fragile, breaks the project on a bad GUID).
     Write ALL the integration code anyway (imports, init, identify, track),
     add a short WHISPERR_SETUP.md with the one manual step — Xcode → File →
     Add Package Dependencies… → \`https://github.com/WhisperrAI/whisperr-swift\`
     → add "Whisperr" to the app target — and report that as the single manual
     follow-up in your summary.

2) Initialize once at launch.
   SwiftUI:
       import Whisperr

       @main
       struct MyApp: App {
           init() {
               Task { await Whisperr.initialize(apiKey: "<INGESTION_API_KEY>") }
           }
           // ... existing body
       }
   UIKit: same Task { } inside application(_:didFinishLaunchingOptions:).
   Only pass a base URL if the manifest's differs from the SDK default:
       await Whisperr.initialize(apiKey: "...", baseURL: URL(string: "<INGESTION_BASE_URL>")!)
   Note baseURL takes a URL, not a String. Prefer reading the key from
   Info.plist / an .xcconfig if the project already uses that pattern;
   otherwise a literal is acceptable (publishable ingestion key).

3) identify() right after the end-user is known — login/signup success AND
   session restore. All calls go through the async optional singleton
   \`await Whisperr.shared\`; in synchronous contexts wrap in Task { }:
       Task {
           try? await Whisperr.shared?.identify(
               user.id,                    // stable external id — never a device id
               traits: ["plan": .string(user.plan)],
               email: user.email,          // shortcut → opted-in email channel
               phone: user.phone,          // shortcut → sms channel
               pushToken: apnsTokenHex     // if the app registers for remote notifications
           )
       }
   Logout:
       Task { await Whisperr.shared?.reset() }   // flushes, then clears the user
   For explicit channel consent/verification use WhisperrChannel:
       channels: [.email("a@b.com", verified: true), .sms("+1555…", optedIn: false)]

4) track() in action handlers / view-model methods — never in a View body:
       Task {
           try? await Whisperr.shared?.track(
               "event_type_from_manifest",
               properties: ["amount_cents": .number(Double(amountCents)),
                            "plan": .string(plan)]
           )
       }
   Awaiting only ENQUEUES (delivery batches in the background) — \`try? await\`
   inside Task { } is the correct fire-and-forget in UI code. In an already-
   async throwing context, plain \`try await\` is fine. event_type verbatim
   snake_case from the manifest.

CRITICAL — JSONValue typing for properties/traits:
   Values are \`JSONValue\`, not \`Any\`. LITERALS convert automatically —
   \`["plan": "pro", "amount": 42, "active": true]\` compiles as-is — but
   VARIABLES must be wrapped: \`.string(user.plan)\`, \`.number(Double(count))\`,
   \`.bool(flag)\`, \`.array(...)\`, \`.object(...)\`. Mixing literals and wrapped
   variables in one dictionary is fine. Forgetting the wrapper is the #1
   compile error — check every non-literal value you pass.

CRITICAL — no anonymous buffering in this SDK:
   track() THROWS WhisperrClientError.missingUserID until identify() has run in
   this process (or when you pass \`userID:\` explicitly). Session restore must
   therefore call identify() early at startup. Do not place track() on
   pre-auth surfaces (onboarding, login screen) unless you pass
   \`userID: "<id>"\` — if a manifest event genuinely happens before the user
   exists, skip it and note it in the summary.

Notes / gotchas:
- \`Whisperr.shared\` is \`async\` and optional — the call shape is always
  \`await Whisperr.shared?.method(...)\`. Never store it in a non-async global.
- The queue persists via UserDefaults and survives restarts; retries, backoff,
  and auth-pause semantics are built in. No manual flush() needed.
- Do not run xcodebuild, swift build, or tests — the human verifies in Xcode.
`.trim();

export const swiftPlaybook: Playbook = {
  target,
  detect,
  packageRef: "whisperr-swift (Swift Package)",
  systemPrompt,
};
