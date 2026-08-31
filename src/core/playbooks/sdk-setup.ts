import type { SdkSetupMetadata } from "../../types.js";

const shared = [
  "Classify each saved auth anchor before editing: canonical implementation or caller.",
  "Use one canonical integration strategy. Callers may reach identify/reset transitively through a shared auth service.",
  "Do not duplicate lifecycle calls just to modify every surveyed anchor; anchors are guidance, not a checklist of files to edit.",
  "Never edit the generated bindings, never add named product events during setup, and self-review the diff once before finishing.",
].join("\n");

export function sdkSetupFor(target: string): SdkSetupMetadata {
  const stateful = (input: Omit<SdkSetupMetadata, "lifecycleMode" | "credentialMode" | "bindingStrategy" | "guide"> & { guide: string }): SdkSetupMetadata => ({
    lifecycleMode: "stateful",
    credentialMode: "publishable",
    bindingStrategy: "stateful-client",
    ...input,
    guide: `${input.guide}\n${shared}\nInitialize and bind once, identify the end user at a canonical login/session-restoration path, and reset at a canonical logout implementation.`,
  });
  const server = (input: Omit<SdkSetupMetadata, "lifecycleMode" | "credentialMode" | "bindingStrategy" | "guide"> & { guide: string }): SdkSetupMetadata => ({
    lifecycleMode: "per-user",
    credentialMode: "server-env",
    bindingStrategy: "per-user-client",
    ...input,
    guide: `${input.guide}\n${shared}\nThis is a server SDK: every identify/event wrapper receives the external user ID. Do not invent reset/logout behavior. Reference WHISPERR_API_KEY from deployment environment configuration.`,
  });
  switch (target) {
    case "nextjs": return stateful({ requiredPackages: ["@whisperr/next", "@whisperr/web"], initializationMarkers: ["WhisperrProvider", "Whisperr.init"], bindingMarkers: ["bindWhisperr("], allowedNewSetupModules: ["whisperr.ts", "whisperr.tsx", "WhisperrProvider.tsx"], guide: "Use @whisperr/next in the client boundary/provider and @whisperr/web only where its client is required." });
    case "web-js": return stateful({ requiredPackages: ["@whisperr/web"], initializationMarkers: ["Whisperr.init", "WhisperrProvider"], bindingMarkers: ["bindWhisperr("], allowedNewSetupModules: ["whisperr.ts", "whisperr.js", "whisperr.tsx", "whisperr.jsx"], guide: "Create one browser client or framework provider at the existing application entry." });
    case "react-native": return stateful({ requiredPackages: ["@whisperr/react-native"], initializationMarkers: ["Whisperr.init"], bindingMarkers: ["bindWhisperr("], allowedNewSetupModules: ["whisperr.ts", "whisperr.js"], guide: "Create one React Native singleton and import it from the root entry; reuse the repository's durable storage convention." });
    case "flutter": return stateful({ requiredPackages: ["whisperr"], initializationMarkers: ["Whisperr.initialize"], bindingMarkers: ["WhisperrEvents.bind("], allowedNewSetupModules: ["whisperr.dart", "whisperr_setup.dart"], guide: "Initialize before runApp and bind the generated Dart adapter to Whisperr.instance.track." });
    case "swift": return stateful({ requiredPackages: ["Whisperr"], initializationMarkers: ["Whisperr.initialize"], bindingMarkers: ["WhisperrEvents.bind("], allowedNewSetupModules: ["WhisperrSetup.swift", "WHISPERR_SETUP.md"], manualDependencyAllowed: true, guide: "Initialize at app launch and bind the generated Swift adapter. Never hand-edit a raw project.pbxproj solely to add Swift Package Manager." });
    case "python": return server({ requiredPackages: ["whisperr"], initializationMarkers: ["Whisperr("], bindingMarkers: ["bind_whisperr("], allowedNewSetupModules: ["whisperr_client.py", "whisperr_setup.py"], guide: "Create one process-wide Python client and bind it to the native generated Python adapter." });
    case "php": return server({ requiredPackages: ["whisperr/php"], initializationMarkers: ["new Whisperr", "Whisperr::"], bindingMarkers: ["bindWhisperr("], allowedNewSetupModules: ["WhisperrClient.php", "WhisperrSetup.php"], guide: "Configure the Laravel integration or one shared plain-PHP client, then bind the native generated PHP adapter." });
    default: return server({ requiredPackages: ["@whisperr/node"], initializationMarkers: ["new Whisperr", "Whisperr("], bindingMarkers: ["bindWhisperr("], allowedNewSetupModules: ["whisperr.ts", "whisperr.js", "whisperr-client.ts", "whisperr-client.js"], guide: "Create one process-wide Node client and bind it to the generated per-user adapter." });
  }
}
