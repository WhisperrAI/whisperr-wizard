/** Shared stack, authentication, and model configuration contracts. */

export interface SdkTarget {
  /** Stable id, e.g. "flutter", "web-js", "react-native", or "swift". */
  id: string;
  displayName: string;
  language: string;
  availability: "available" | "planned";
}

export interface Detection {
  target: SdkTarget;
  /** 0..1 confidence from bounded filesystem evidence. */
  confidence: number;
  evidence: string[];
}

export interface Playbook {
  target: SdkTarget;
  detect(ctx: DetectContext): Promise<Detection | null>;
  packageRef: string;
  /** Factual SDK installation and API guidance appended to the fresh prompt. */
  systemPrompt: string;
  /** Host-owned deterministic compile/lint command. */
  verifyCommand?: string;
}

export interface DetectContext {
  repoPath: string;
  read(relPath: string): Promise<string>;
  exists(relPath: string): Promise<boolean>;
  list(relDir: string): Promise<string[]>;
}

export interface WizardSession {
  /** Opaque token used for runtime calls and the OpenAI-compatible gateway. */
  token: string;
  appId: string;
  /** Epoch seconds. */
  expiresAt: number;
}

export interface WizardConfig {
  apiBaseUrl: string;
  openAIBaseUrl: string;
  primaryModel: string;
  primaryEffort: "low" | "medium" | "high" | "xhigh" | "max";
  primaryServiceTier: "priority" | "default";
  explorerModel: string;
  explorerEffort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns: number;
  /** Process-local development override. Never serialize this value. */
  directOpenAIKey?: string;
}
