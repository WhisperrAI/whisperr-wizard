import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { SdkSetupMetadata } from "../types.js";
import { eventWrapperName, type GeneratedBindings } from "./bindings.js";
import type { RegisteredEvent, SurveyArtifact } from "./selection.js";

export interface SetupValidationCheck {
  id: string;
  message: string;
  files: string[];
}

export interface SetupValidationResult {
  ok: boolean;
  passed: SetupValidationCheck[];
  failed: SetupValidationCheck[];
  warnings: SetupValidationCheck[];
  evidenceFiles: string[];
  manualConfigurationWarnings: string[];
}

export interface AssessSetupInput {
  repoPath: string;
  target: string;
  metadata: SdkSetupMetadata;
  bindings: GeneratedBindings;
  allowedFiles: string[];
  editedFiles: string[];
  registered: RegisteredEvent[];
  survey?: SurveyArtifact;
  forbidProductEvents?: boolean;
}

export async function assessSdkSetup(input: AssessSetupInput): Promise<SetupValidationResult> {
  const passed: SetupValidationCheck[] = [];
  const failed: SetupValidationCheck[] = [];
  const warnings: SetupValidationCheck[] = [];
  const manualConfigurationWarnings: string[] = [];
  const allowed = new Set(input.allowedFiles.map(normalize));
  const edited = input.editedFiles.map(normalize);
  const contents = new Map<string, string>();
  for (const file of allowed) {
    try {
      contents.set(file, await readFile(safePath(input.repoPath, file), "utf8"));
    } catch {
      // Allowed new modules and optional manifests need not exist.
    }
  }
  const evidenceFiles = [...contents.keys()].sort();
  const nonGenerated = [...contents].filter(([file]) => file !== normalize(input.bindings.relativePath));
  const combined = nonGenerated.map(([, content]) => content).join("\n");
  const filesMatching = (test: (content: string) => boolean) =>
    nonGenerated.filter(([, content]) => test(content)).map(([file]) => file);
  const record = (ok: boolean, id: string, message: string, files: string[] = []) =>
    (ok ? passed : failed).push({ id, message, files: [...new Set(files)].sort() });

  const outOfScope = edited.filter((file) => !allowed.has(file));
  record(outOfScope.length === 0, "scope", "all SDK setup edits stay inside the setup allowlist", outOfScope);

  const generated = contents.get(normalize(input.bindings.relativePath));
  record(generated === input.bindings.content, "generated-binding", "generated bindings exactly match deterministic output", [input.bindings.relativePath]);

  const dependencyFiles = evidenceFiles.filter(isDependencyFile);
  const dependencyText = dependencyFiles.map((file) => contents.get(file) ?? "").join("\n");
  let packagesPresent = input.metadata.requiredPackages.every((pkg) => dependencyText.includes(pkg));
  const safeSwiftManifest = dependencyFiles.some((file) => /(?:Package\.swift|Project\.swift|project\.yml|Podfile)$/.test(file));
  if (!packagesPresent && input.target === "swift" && input.metadata.manualDependencyAllowed && !safeSwiftManifest) {
    packagesPresent = true;
    manualConfigurationWarnings.push("Add the Whisperr Swift package to the application target in Xcode (File → Add Package Dependencies…).");
    warnings.push({ id: "manual-dependency", message: "Swift package installation requires an Xcode project change outside the safe setup sandbox", files: [] });
  }
  record(packagesPresent, "dependency", `expected SDK dependency is declared (${input.metadata.requiredPackages.join(", ")})`, dependencyFiles);

  const initFiles = filesMatching((content) => input.metadata.initializationMarkers.some((marker) => content.includes(marker)));
  record(initFiles.length > 0, "initialization", "target-appropriate SDK initialization/provider/client exists", initFiles);

  const bindingFiles = filesMatching((content) => input.metadata.bindingMarkers.some((marker) => content.includes(marker)));
  record(bindingFiles.length > 0, "binding", "generated event adapter is bound to the SDK client", bindingFiles);

  const identifyFiles = filesMatching((content) => /\bidentify\s*\(\s*[^)\s]/.test(content));
  record(identifyFiles.length > 0, "identify", input.metadata.lifecycleMode === "per-user" ? "at least one identify call passes an end-user ID" : "at least one canonical end-user identify placement exists", identifyFiles);

  const resetFiles = filesMatching((content) => /\breset\s*\(/.test(content));
  if (input.metadata.lifecycleMode === "stateful") {
    record(resetFiles.length > 0, "reset", "stateful client has at least one canonical logout reset placement", resetFiles);
  } else {
    passed.push({ id: "per-user-lifecycle", message: "server target uses per-user identity and does not require reset", files: identifyFiles });
    if (resetFiles.length > 0) warnings.push({ id: "server-reset", message: "server target contains reset calls that are not required by its per-user lifecycle", files: resetFiles });
  }

  const productEventFiles = filesMatching((content) => input.registered.some((event) =>
    content.includes(eventWrapperName(event.code, input.target)) ||
    new RegExp(`(?:track|emit)\\s*\\([^\\n]*[\"']${escapeRegExp(event.code)}[\"']`).test(content)
  ));
  if (input.forbidProductEvents !== false) {
    record(productEventFiles.length === 0, "no-product-events", "SDK setup does not add named product event calls", productEventFiles);
  }

  const bindingCalls = countMatches(combined, input.metadata.bindingMarkers);
  if (bindingCalls > 1) warnings.push({ id: "duplicate-binding", message: "multiple adapter binding calls found; keep one canonical binding", files: bindingFiles });
  if (input.metadata.lifecycleMode === "stateful" && countRegex(combined, /\breset\s*\(/g) > 1) {
    warnings.push({ id: "duplicate-reset", message: "multiple reset calls found; confirm they share one canonical logout implementation", files: resetFiles });
  }
  for (const anchor of [...(input.survey?.identifyAnchors ?? []), ...(input.survey?.logoutAnchors ?? [])]) {
    if (!edited.includes(normalize(anchor.file))) warnings.push({ id: "caller-anchor", message: "surveyed anchor was left unchanged; this is valid when it calls a canonical shared implementation", files: [normalize(anchor.file)] });
  }
  if (input.metadata.credentialMode === "server-env" && !serverCredentialPresent(input.target, combined)) {
    failed.push({ id: "server-credential", message: "server setup must reference WHISPERR_API_KEY instead of hardcoding a credential", files: initFiles });
  }

  return { ok: failed.length === 0, passed, failed, warnings, evidenceFiles, manualConfigurationWarnings };
}

export function formatSetupFailures(result: SetupValidationResult): string {
  return result.failed.map((check) => `${check.id}: ${check.message}${check.files.length ? ` [${check.files.join(", ")}]` : ""}`).join("; ");
}

function normalize(file: string): string { return file.replaceAll("\\", "/").replace(/^\.\//, ""); }
function safePath(rootPath: string, file: string): string {
  const root = resolve(rootPath);
  const path = resolve(root, file);
  if (path === root || !path.startsWith(root + sep)) throw new Error(`unsafe setup file path: ${file}`);
  return path;
}
function isDependencyFile(file: string): boolean { return /(^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|requirements\.txt|Pipfile|Package\.swift|Project\.swift|project\.yml|Podfile|pubspec\.yaml|composer\.(?:json|lock))$/.test(file); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function countRegex(value: string, regex: RegExp): number { return [...value.matchAll(regex)].length; }
function countMatches(value: string, markers: string[]): number { return markers.reduce((sum, marker) => sum + value.split(marker).length - 1, 0); }
function serverCredentialPresent(target: string, content: string): boolean {
  if (target === "python") return /(?:os\.(?:environ|getenv)|getenv)\s*(?:\[|\()\s*["']WHISPERR_API_KEY/.test(content);
  if (target === "php") return /(?:getenv|env|config)\s*\(\s*["']WHISPERR_API_KEY/.test(content);
  return /(?:process\.env(?:\.|\[['"])|Deno\.env\.get\s*\(\s*['"])WHISPERR_API_KEY/.test(content);
}
