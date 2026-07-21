import { basename, isAbsolute, relative, resolve } from "node:path";

export type ToolPolicyDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

export interface ToolPolicyContext {
  repoPath: string;
}

export const SECRET_MATERIAL_DENIAL =
  "blocked: secret material - reference the variable name in .env.example instead of reading the real file";

const WRITE_OUTSIDE_REPO_DENIAL =
  "blocked: writes must stay inside the target repository";

export const SENSITIVE_WRITE_DENIAL =
  "blocked: refusing to write CI/git configuration";
export const PACKAGE_MANIFEST_WRITE_DENIAL =
  "blocked: dependency manifests must be updated through an approved package command";

const BASH_ALLOWLIST_DENIAL =
  "blocked: command is outside the allowlist - install approved SDK packages or use metadata-only git status/diff commands";

const CHAINED_COMMAND_DENIAL =
  "blocked: chained or substituted shell command - run one command at a time";

const SHELL_EXPANSION_DENIAL =
  "blocked: shell expansion or redirection is not allowed";

const ENV_EXAMPLES = new Set([".env.example", ".env.sample", ".env.template"]);
const SECRET_DIRECTORIES = new Set([".aws", ".ssh", ".gnupg"]);
const SECRET_EXACT_FILES = new Set([".netrc", ".npmrc", ".pypirc"]);
const SENSITIVE_WRITE_DIRECTORIES = new Set([".git", ".circleci", ".buildkite"]);
const SENSITIVE_WRITE_EXACT_FILES = new Set([
  ".gitlab-ci.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  ".drone.yml",
  "jenkinsfile",
]);
const PACKAGE_MANIFEST_FILES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "composer.json",
  "composer.lock",
  "pubspec.yaml",
  "pubspec.lock",
  "pyproject.toml",
  "poetry.lock",
  "pipfile",
  "pipfile.lock",
  "uv.lock",
]);
const PACKAGE_MANAGER_CONFIG_FILES = new Set([
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  ".pnpmfile.js",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  "pnpm-workspace.yaml",
]);
const PACKAGE_MANAGER_DIRECTORIES = new Set(["node_modules", ".yarn", ".pnpm-store"]);
const SECRET_SUFFIXES = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".tfvars",
];

export const JS_PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PYTHON_PACKAGE_MANAGERS = new Set(["pip", "pip3", "poetry", "pipenv", "uv"]);
const ALLOWED_JS_PACKAGES = new Set([
  "@whisperr/web",
  "@whisperr/react",
  "@whisperr/next",
  "@whisperr/react-native",
  "@whisperr/node",
  "@react-native-async-storage/async-storage",
]);
const ALLOWED_PYTHON_PACKAGES = new Set(["whisperr", "whisperr[django]"]);
const EXTERNAL_INSTALL_FLAGS = new Set([
  "-g",
  "--global",
  "--user",
  "--system",
  "--root",
  "--prefix",
  "--target",
  "-t",
  "--directory",
  "--working-dir",
  "--project-directory",
  "--modules-folder",
  "--cwd",
  "--dir",
  "-c",
]);

export function evaluateToolUse(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolPolicyContext,
): ToolPolicyDecision {
  switch (toolName) {
    case "Read":
      return evaluateReadLike(readPathInputs(input), readPathInputs(input), context);
    case "Grep":
      return evaluateReadLike(grepGlobPathInputs(input), grepPathInputs(input), context);
    case "Glob":
      return evaluateReadLike(grepGlobPathInputs(input), grepGlobPathInputs(input), context);
    case "Bash":
      return evaluateBash(input, context);
    case "Write":
    case "Edit":
      return evaluateWrite(input, context);
    default:
      return {
        behavior: "deny",
        message: `blocked: tool ${toolName} is not allowed by the wizard tool policy`,
      };
  }
}

export function isSecretPathLike(value: string): boolean {
  const parts = normalizePathLike(value).split("/").filter(Boolean);
  for (const rawPart of parts) {
    const part = stripOuterQuotes(rawPart.trim().toLowerCase());
    if (!part || part === "." || part === "**") continue;
    if (ENV_EXAMPLES.has(part)) continue;
    if (SECRET_DIRECTORIES.has(part)) return true;
    if (SECRET_EXACT_FILES.has(part)) return true;
    if (
      part === ".env" ||
      part === ".envrc" ||
      part.startsWith(".env.") ||
      part.startsWith(".env*")
    ) {
      return true;
    }
    if (
      part.startsWith("id_rsa") ||
      part.startsWith("id_ecdsa") ||
      part.startsWith("id_ed25519")
    ) {
      return true;
    }
    if (part.includes("credentials")) return true;
    if (part.startsWith("secrets.")) return true;
    if (SECRET_SUFFIXES.some((suffix) => part.endsWith(suffix))) return true;
  }
  return false;
}

export function isPathInsideRepo(pathValue: string, repoPath: string): boolean {
  if (pathValue.includes("..")) return false;
  const repoRoot = resolve(repoPath);
  const candidate = isAbsolute(pathValue)
    ? resolve(pathValue)
    : resolve(repoRoot, pathValue);
  const rel = relative(repoRoot, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function evaluateReadLike(
  secretValues: string[],
  repoPathValues: string[],
  context: ToolPolicyContext,
): ToolPolicyDecision {
  for (const value of secretValues) {
    if (isSecretPathLike(value)) {
      return { behavior: "deny", message: SECRET_MATERIAL_DENIAL };
    }
  }

  for (const value of repoPathValues) {
    if (!isPathInsideRepo(value, context.repoPath)) {
      return {
        behavior: "deny",
        message: "blocked: reads must stay inside the target repository",
      };
    }
  }

  return { behavior: "allow" };
}

function evaluateWrite(
  input: Record<string, unknown>,
  context: ToolPolicyContext,
): ToolPolicyDecision {
  const pathValue = firstString(input, ["file_path", "path"]);
  if (!pathValue) {
    return { behavior: "deny", message: "blocked: write target path is missing" };
  }
  if (!isPathInsideRepo(pathValue, context.repoPath)) {
    return { behavior: "deny", message: WRITE_OUTSIDE_REPO_DENIAL };
  }
  if (isPackageManagerWritePath(pathValue, context.repoPath)) {
    return { behavior: "deny", message: PACKAGE_MANIFEST_WRITE_DENIAL };
  }
  if (isSensitiveWritePath(pathValue, context.repoPath)) {
    return { behavior: "deny", message: SENSITIVE_WRITE_DENIAL };
  }
  return { behavior: "allow" };
}

function evaluateBash(
  input: Record<string, unknown>,
  context: ToolPolicyContext,
): ToolPolicyDecision {
  const command = firstString(input, ["command"]);
  if (!command) {
    return { behavior: "deny", message: "blocked: Bash command is missing" };
  }
  if (/[<>${}]/.test(command)) {
    return { behavior: "deny", message: SHELL_EXPANSION_DENIAL };
  }

  const split = splitShellSegments(command);
  if (split.hasCommandSubstitution || split.hadChain) {
    return { behavior: "deny", message: CHAINED_COMMAND_DENIAL };
  }

  const segmentDecisions = split.segments.map((segment) =>
    evaluateBashSegment(segment, context),
  );
  const denied = segmentDecisions.find((decision) => decision.behavior === "deny");
  if (denied) {
    return split.hadChain
      ? { behavior: "deny", message: CHAINED_COMMAND_DENIAL }
      : denied;
  }
  return { behavior: "allow" };
}

function evaluateBashSegment(
  segment: string,
  context: ToolPolicyContext,
): ToolPolicyDecision {
  const tokens = tokenizeShellCommand(segment);
  if (!tokens.length) return { behavior: "deny", message: BASH_ALLOWLIST_DENIAL };

  const command = tokens[0]?.toLowerCase() ?? "";
  const second = tokens[1]?.toLowerCase() ?? "";
  const third = tokens[2]?.toLowerCase() ?? "";

  if (packageCommandEscapesRepository(tokens, context)) {
    return { behavior: "deny", message: WRITE_OUTSIDE_REPO_DENIAL };
  }

  if (JS_PACKAGE_MANAGERS.has(command)) {
    if (
      (second === "install" || second === "add") &&
      onlyAllowedPackages(tokens.slice(2), ALLOWED_JS_PACKAGES)
    ) {
      return { behavior: "allow" };
    }
  }
  if (
    command === "npx" &&
    second === "--no-install" &&
    third === "expo" &&
    tokens.length === 5 &&
    tokens[3]?.toLowerCase() === "install" &&
    tokens[4]?.toLowerCase() === "@react-native-async-storage/async-storage"
  ) {
    return { behavior: "allow" };
  }

  if (PYTHON_PACKAGE_MANAGERS.has(command)) {
    if (
      (second === "install" || second === "add") &&
      onlyAllowedPackages(tokens.slice(2), ALLOWED_PYTHON_PACKAGES)
    ) {
      return { behavior: "allow" };
    }
    if (
      command === "uv" &&
      second === "pip" &&
      third === "install" &&
      onlyAllowedPackages(tokens.slice(3), ALLOWED_PYTHON_PACKAGES)
    ) {
      return { behavior: "allow" };
    }
  }

  if (command === "composer" && second === "require" && tokens.length === 3 && third === "whisperr/php") {
    return { behavior: "allow" };
  }
  if (
    (command === "flutter" || command === "dart") &&
    second === "pub" &&
    ((third === "get" && tokens.length === 3) ||
      (third === "add" && tokens.length === 4 && tokens[3] === "whisperr"))
  ) {
    return { behavior: "allow" };
  }
  if (command === "git") {
    return evaluateGitMetadataCommand(tokens);
  }

  return { behavior: "deny", message: BASH_ALLOWLIST_DENIAL };
}

function onlyAllowedPackages(tokens: string[], allowed: Set<string>): boolean {
  return tokens.length > 0 && tokens.every((token) => allowed.has(token.toLowerCase()));
}

function evaluateGitMetadataCommand(tokens: string[]): ToolPolicyDecision {
  const subcommand = tokens[1]?.toLowerCase();
  const args = tokens.slice(2).map((token) => token.toLowerCase());
  if (subcommand === "status") {
    const allowed = new Set([
      "--short",
      "-s",
      "--branch",
      "-b",
      "-sb",
      "--porcelain",
      "--porcelain=v1",
      "--porcelain=v2",
    ]);
    return args.every((arg) => allowed.has(arg))
      ? { behavior: "allow" }
      : { behavior: "deny", message: BASH_ALLOWLIST_DENIAL };
  }
  if (subcommand === "diff") {
    const outputModes = new Set([
      "--name-only",
      "--name-status",
      "--stat",
      "--numstat",
      "--shortstat",
      "--compact-summary",
    ]);
    const modifiers = new Set(["--cached", "--staged"]);
    const hasOutputMode = args.some((arg) => outputModes.has(arg));
    return hasOutputMode && args.every((arg) => outputModes.has(arg) || modifiers.has(arg))
      ? { behavior: "allow" }
      : { behavior: "deny", message: BASH_ALLOWLIST_DENIAL };
  }
  return { behavior: "deny", message: BASH_ALLOWLIST_DENIAL };
}

function packageCommandEscapesRepository(
  tokens: string[],
  context: ToolPolicyContext,
): boolean {
  const command = tokens[0]?.toLowerCase() ?? "";
  const isPackageCommand =
    JS_PACKAGE_MANAGERS.has(command) ||
    PYTHON_PACKAGE_MANAGERS.has(command) ||
    ["composer", "flutter", "dart"].includes(command);
  if (!isPackageCommand) return false;

  for (const token of tokens.slice(1)) {
    const lower = token.toLowerCase();
    if (
      EXTERNAL_INSTALL_FLAGS.has(lower) ||
      [...EXTERNAL_INSTALL_FLAGS].some((flag) => lower.startsWith(`${flag}=`))
    ) {
      return true;
    }
    const pathValue = lower.startsWith("file:") ? token.slice(5) : token;
    if (
      pathValue.startsWith("~") ||
      ((isAbsolute(pathValue) || pathValue.includes("..")) &&
        !isPathInsideRepo(pathValue, context.repoPath))
    ) {
      return true;
    }
  }
  return false;
}

function readPathInputs(input: Record<string, unknown>): string[] {
  return stringInputs(input, ["file_path", "path"]);
}

function grepGlobPathInputs(input: Record<string, unknown>): string[] {
  return stringInputs(input, ["file_path", "path", "pattern", "glob"]);
}

function grepPathInputs(input: Record<string, unknown>): string[] {
  return stringInputs(input, ["file_path", "path"]);
}

function stringInputs(input: Record<string, unknown>, keys: string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) values.push(value.trim());
  }
  return values;
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  return stringInputs(input, keys)[0];
}

function normalizePathLike(value: string): string {
  return stripOuterQuotes(value.trim()).replace(/\\/g, "/");
}

function repoRelativePath(pathValue: string, repoPath: string): string {
  const repoRoot = resolve(repoPath);
  const candidate = isAbsolute(pathValue)
    ? resolve(pathValue)
    : resolve(repoRoot, pathValue);
  return normalizePathLike(relative(repoRoot, candidate));
}

function isSensitiveWritePath(pathValue: string, repoPath: string): boolean {
  const parts = repoRelativePath(pathValue, repoPath)
    .split("/")
    .map((part) => stripOuterQuotes(part.trim().toLowerCase()))
    .filter(Boolean);
  const [first, second] = parts;
  if (!first) return false;
  if (SENSITIVE_WRITE_DIRECTORIES.has(first)) return true;
  if (first === ".github" && second === "workflows") return true;
  return parts.length === 1 && SENSITIVE_WRITE_EXACT_FILES.has(first);
}

function isPackageManagerWritePath(pathValue: string, repoPath: string): boolean {
  const parts = repoRelativePath(pathValue, repoPath)
    .split("/")
    .map((part) => stripOuterQuotes(part.trim().toLowerCase()))
    .filter(Boolean);
  const name = basename(pathValue).toLowerCase();
  return (
    PACKAGE_MANIFEST_FILES.has(name) ||
    PACKAGE_MANAGER_CONFIG_FILES.has(name) ||
    parts.some((part) => PACKAGE_MANAGER_DIRECTORIES.has(part))
  );
}

function stripOuterQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function splitShellSegments(command: string): {
  segments: string[];
  hadChain: boolean;
  hasCommandSubstitution: boolean;
} {
  const segments: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  let hadChain = false;
  let hasCommandSubstitution = false;

  const push = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];

    if (ch === "`" || (ch === "$" && next === "(")) {
      hasCommandSubstitution = true;
    }

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      current += ch;
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = undefined;
      current += ch;
      continue;
    }

    if (ch === "\"" || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    const two = `${ch}${next ?? ""}`;
    if (two === "&&" || two === "||") {
      hadChain = true;
      push();
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      hadChain = true;
      push();
      continue;
    }

    current += ch;
  }

  push();
  return { segments, hadChain, hasCommandSubstitution };
}

export function tokenizeShellCommand(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  let escaped = false;

  const push = () => {
    if (current) tokens.push(current);
    current = "";
  };

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }

    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      push();
      continue;
    }

    current += ch;
  }

  push();
  return tokens;
}
