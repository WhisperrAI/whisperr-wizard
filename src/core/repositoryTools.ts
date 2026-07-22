import { spawn } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import {
  INGESTION_BASE_URL_PLACEHOLDER,
  INGESTION_KEY_PLACEHOLDER,
} from "./generationPrompt.js";
import { sanitizedChildEnv, scrubError } from "./scrub.js";
import {
  evaluateToolUse,
  isSecretPathLike,
  JS_PACKAGE_MANAGERS,
  tokenizeShellCommand,
} from "./toolPolicy.js";

const MAX_READ_BYTES = 40_000;
const MAX_SEARCH_BYTES = 200_000;
const MAX_FILES = 500;
const MAX_COMMAND_OUTPUT = 8_000;
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".next"]);

export interface RepositoryToolOptions {
  repoPath: string;
  ingestion: { apiKey: string; baseUrl: string };
  onActivity?: (message: string) => void | Promise<void>;
  onRepositoryChange?: () => void | Promise<void>;
}

export function createReadOnlyRepositoryTools(
  options: Pick<RepositoryToolOptions, "repoPath" | "ingestion" | "onActivity">,
): Tool[] {
  return createReadTools(options);
}

export function createRepositoryTools(options: RepositoryToolOptions): Tool[] {
  const readTools = createReadTools(options);
  const editFile = tool({
    name: "edit_file",
    description:
      "Replace one exact, unique text block in an existing repository file. Never include credential values; source keys from local configuration.",
    parameters: z.object({
      path: z.string().min(1),
      oldText: z.string().min(1),
      newText: z.string(),
    }),
    async execute({ path, oldText, newText }) {
      rejectGenericSecretWrite(path);
      enforce("Edit", { path }, options.repoPath);
      const destination = await resolveExistingInside(options.repoPath, path, "Edit");
      rejectGenericSecretWrite(destination.relativePath);
      const current = await readFile(destination.absolutePath, "utf8");
      const oldMaterialized = materialize(oldText, options.ingestion);
      const occurrences = current.split(oldMaterialized).length - 1;
      if (occurrences !== 1) {
        return { ok: false, error: `Expected one exact match in ${path}; found ${occurrences}.` };
      }
      const next = current.replace(
        oldMaterialized,
        materialize(newText, options.ingestion),
      );
      await writeFile(destination.absolutePath, next, "utf8");
      await options.onRepositoryChange?.();
      await options.onActivity?.(`Edited ${path}`);
      return { ok: true, path };
    },
  });
  const createFile = tool({
    name: "create_file",
    description:
      "Create a new repository file. Fails if it already exists. Never include credential values; source keys from local configuration.",
    parameters: z.object({ path: z.string().min(1), content: z.string() }),
    async execute({ path, content }) {
      rejectGenericSecretWrite(path);
      enforce("Write", { path }, options.repoPath);
      const destination = await resolveWriteInside(options.repoPath, path, "Write");
      rejectGenericSecretWrite(destination.relativePath);
      try {
        await stat(destination.absolutePath);
        return { ok: false, error: `${path} already exists; use edit_file.` };
      } catch {
        // Expected for a new file.
      }
      await mkdir(dirname(destination.absolutePath), { recursive: true });
      await writeFile(
        destination.absolutePath,
        materialize(content, options.ingestion),
        {
        encoding: "utf8",
        flag: "wx",
        },
      );
      await options.onRepositoryChange?.();
      await options.onActivity?.(`Created ${path}`);
      return { ok: true, path };
    },
  });
  const configureIngestionEnv = tool({
    name: "configure_ingestion_env",
    description:
      "Host-owned helper that sets the ingestion key in an existing or new local .env file without exposing its value.",
    parameters: z.object({
      path: z.string().min(1),
      variableName: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    }),
    async execute({ path, variableName }) {
      enforce("Write", { path }, options.repoPath);
      if (!isWritableEnvPath(path)) {
        return { ok: false, error: "The path must be a local .env file, not an example file." };
      }
      const destination = await resolveWriteInside(options.repoPath, path, "Write");
      if (!isWritableEnvPath(destination.relativePath)) {
        throw new Error("blocked: resolved ingestion environment path is not a local .env file");
      }
      if (!(await isSafeLocalEnvTarget(destination.repoRoot, destination.relativePath))) {
        return {
          ok: false,
          error: "The local environment file must be ignored by Git before the ingestion key can be written.",
        };
      }
      let current = "";
      try {
        current = await readFile(destination.absolutePath, "utf8");
      } catch {
        await mkdir(dirname(destination.absolutePath), { recursive: true });
      }
      const line = `${variableName}=${options.ingestion.apiKey}`;
      const pattern = new RegExp(`^${escapeRegExp(variableName)}=.*$`, "m");
      const next = pattern.test(current)
        ? current.replace(pattern, line)
        : `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`;
      await writeFile(destination.absolutePath, next, { encoding: "utf8", mode: 0o600 });
      await options.onRepositoryChange?.();
      await options.onActivity?.(`Configured ${variableName} in ${path}`);
      return { ok: true, path, variableName };
    },
  });
  const runCommand = tool({
    name: "run_repository_command",
    description:
      "Run one policy-allowlisted package-manager or read-only git command in the repository. No command chaining or network utilities.",
    parameters: z.object({ command: z.string().min(1) }),
    async execute({ command }) {
      enforce("Bash", { command }, options.repoPath);
      await options.onActivity?.(`Running ${short(command)}`);
      const result = await spawnCommand(options.repoPath, command);
      return {
        ...result,
        output: redact(result.output, options.ingestion.apiKey),
      };
    },
  });
  return [...readTools, editFile, createFile, configureIngestionEnv, runCommand];
}

function createReadTools(
  options: Pick<RepositoryToolOptions, "repoPath" | "ingestion" | "onActivity">,
): Tool[] {
  const readFileTool = tool({
    name: "read_repository_file",
    description: "Read a non-secret text file inside the selected repository.",
    parameters: z.object({ path: z.string().min(1) }),
    async execute({ path }) {
      enforce("Read", { path }, options.repoPath);
      const content = await readTextPrefix(
        (await resolveExistingInside(options.repoPath, path, "Read")).absolutePath,
        MAX_READ_BYTES,
      );
      await options.onActivity?.(`Reading ${path}`);
      return redact(content, options.ingestion.apiKey);
    },
  });
  const listFiles = tool({
    name: "list_repository_files",
    description: "List bounded, non-secret repository files below a directory.",
    parameters: z.object({ path: z.string().min(1) }),
    async execute({ path }) {
      enforce("Glob", { path, pattern: "*" }, options.repoPath);
      const files = await walkFiles(options.repoPath, path);
      await options.onActivity?.(`Scanning ${path}`);
      return files;
    },
  });
  const searchFiles = tool({
    name: "search_repository",
    description:
      "Search non-secret text files for a literal string and return matching paths and line excerpts.",
    parameters: z.object({ path: z.string().min(1), query: z.string().min(1) }),
    async execute({ path, query }) {
      enforce("Grep", { path, pattern: query }, options.repoPath);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const needle = query.toLowerCase();
      for (const file of await walkFiles(options.repoPath, path)) {
        if (matches.length >= 100) break;
        try {
          const content = await readTextPrefix(
            join(options.repoPath, file),
            MAX_SEARCH_BYTES,
          );
          for (const [index, line] of content.split("\n").entries()) {
            if (line.toLowerCase().includes(needle)) {
              matches.push({
                path: file,
                line: index + 1,
                text: redact(line.slice(0, 500), options.ingestion.apiKey),
              });
              if (matches.length >= 100) break;
            }
          }
        } catch {
          // Skip binary, unreadable, or concurrently removed files.
        }
      }
      await options.onActivity?.(`Searching for ${short(query)}`);
      return matches;
    },
  });
  return [readFileTool, listFiles, searchFiles];
}

async function readTextPrefix(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function walkFiles(repoPath: string, start: string): Promise<string[]> {
  const resolved = await resolveExistingInside(repoPath, start, "Glob");
  const queue = [resolved.absolutePath];
  const files: string[] = [];
  while (queue.length && files.length < MAX_FILES) {
    const directory = queue.shift()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      const rel = relative(resolved.repoRoot, directory);
      if (rel && !isSecretPathLike(rel)) files.push(rel);
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      const absolute = join(directory, entry.name);
      const rel = relative(resolved.repoRoot, absolute);
      if (isSecretPathLike(rel)) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) queue.push(absolute);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }
  return files.sort();
}

function enforce(toolName: string, input: Record<string, unknown>, repoPath: string): void {
  const decision = evaluateToolUse(toolName, input, { repoPath });
  if (decision.behavior === "deny") throw new Error(decision.message);
}

function resolveInside(repoPath: string, path: string): string {
  const absolute = resolve(repoPath, path);
  const rel = relative(resolve(repoPath), absolute);
  if (!rel || (!rel.startsWith("..") && !rel.startsWith("/"))) return absolute;
  throw new Error("blocked: path must stay inside the target repository");
}

interface ResolvedRepositoryPath {
  absolutePath: string;
  relativePath: string;
  repoRoot: string;
}

async function resolveExistingInside(
  repoPath: string,
  path: string,
  toolName: "Read" | "Edit" | "Glob",
): Promise<ResolvedRepositoryPath> {
  const lexical = resolveInside(repoPath, path);
  const actual = await realpath(lexical);
  return authorizeResolvedPath(repoPath, actual, toolName);
}

async function resolveWriteInside(
  repoPath: string,
  path: string,
  toolName: "Write",
): Promise<ResolvedRepositoryPath> {
  const lexical = resolveInside(repoPath, path);
  try {
    const actual = await realpath(lexical);
    return authorizeResolvedPath(repoPath, actual, toolName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let ancestor = dirname(lexical);
  while (true) {
    try {
      const actualAncestor = await realpath(ancestor);
      await assertResolvedInside(repoPath, actualAncestor);
      const effective = resolve(actualAncestor, relative(ancestor, lexical));
      return authorizeResolvedPath(repoPath, effective, toolName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

async function authorizeResolvedPath(
  repoPath: string,
  actual: string,
  toolName: "Read" | "Edit" | "Glob" | "Write",
): Promise<ResolvedRepositoryPath> {
  const repoRoot = await realpath(resolve(repoPath));
  const relativePath = relative(repoRoot, actual);
  if (relativePath !== "" && (relativePath.startsWith("..") || relativePath.startsWith("/"))) {
    throw new Error("blocked: resolved path must stay inside the target repository");
  }
  enforce(
    toolName,
    toolName === "Glob" ? { path: relativePath || ".", pattern: "*" } : { path: relativePath || "." },
    repoRoot,
  );
  return { absolutePath: actual, relativePath: relativePath || ".", repoRoot };
}

async function assertResolvedInside(repoPath: string, actual: string): Promise<void> {
  const rel = relative(await realpath(resolve(repoPath)), actual);
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))) return;
  throw new Error("blocked: resolved path must stay inside the target repository");
}

function materialize(
  value: string,
  ingestion: RepositoryToolOptions["ingestion"],
): string {
  return value.replaceAll(INGESTION_BASE_URL_PLACEHOLDER, ingestion.baseUrl);
}

function redact(value: string, ingestionKey: string): string {
  return value
    .replaceAll(ingestionKey, INGESTION_KEY_PLACEHOLDER)
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(?:OPENAI_API_KEY|WHISPERR_WIZARD_DIRECT_OPENAI_KEY)\s*=\s*["']?[^"'\s]+["']?/gi,
      (match) => `${match.slice(0, match.indexOf("=") + 1)}[redacted]`,
    );
}

function rejectGenericSecretWrite(path: string): void {
  if (isSecretPathLike(path)) {
    throw new Error(
      "blocked: generic edits to secret files are denied; use configure_ingestion_env",
    );
  }
}

function isExampleEnvPath(path: string): boolean {
  return [".env.example", ".env.sample", ".env.template"].includes(
    basename(path).toLowerCase(),
  );
}

function isWritableEnvPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (name === ".env" || name.startsWith(".env.")) && !isExampleEnvPath(path);
}

function spawnCommand(
  cwd: string,
  command: string,
): Promise<{ ok: boolean; exitCode: number | null; output: string }> {
  return new Promise((resolveResult) => {
    const [executable, ...parsedArgs] = tokenizeShellCommand(command);
    if (!executable) {
      resolveResult({ ok: false, exitCode: null, output: "Invalid command." });
      return;
    }
    const args = [...parsedArgs];
    if (JS_PACKAGE_MANAGERS.has(executable.toLowerCase())) {
      args.push("--ignore-scripts");
    }
    if (executable.toLowerCase() === "composer") {
      args.push("--no-scripts", "--no-plugins", "--no-interaction");
    }
    let invocation: { executable: string; args: string[] };
    try {
      invocation = repositoryCommandInvocation(executable, args);
    } catch (error) {
      resolveResult({ ok: false, exitCode: null, output: scrubError(error) });
      return;
    }
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      env: {
        ...sanitizedChildEnv(),
        npm_config_ignore_scripts: "true",
        PNPM_CONFIG_IGNORE_SCRIPTS: "true",
        YARN_ENABLE_SCRIPTS: "false",
      },
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > MAX_COMMAND_OUTPUT * 2) output = output.slice(-MAX_COMMAND_OUTPUT);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => killProcessTree(child.pid, () => child.kill("SIGKILL")), 120_000);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolveResult({
        ok: exitCode === 0,
        exitCode,
        output: output.slice(-MAX_COMMAND_OUTPUT),
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveResult({ ok: false, exitCode: null, output: scrubError(error) });
    });
  });
}

const WINDOWS_COMMAND_SHIMS: Record<string, string> = {
  npm: "npm.cmd",
  npx: "npx.cmd",
  pnpm: "pnpm.cmd",
  yarn: "yarn.cmd",
  composer: "composer.bat",
  flutter: "flutter.bat",
  dart: "dart.bat",
};

export function repositoryCommandInvocation(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec = process.env.ComSpec || "cmd.exe",
): { executable: string; args: string[] } {
  if (platform !== "win32" || !WINDOWS_COMMAND_SHIMS[executable.toLowerCase()]) {
    return { executable, args };
  }
  const tokens = [WINDOWS_COMMAND_SHIMS[executable.toLowerCase()]!, ...args];
  if (tokens.some((token) => !/^[A-Za-z0-9@_./:\[\]-]+$/.test(token))) {
    throw new Error("blocked: invalid Windows package command argument");
  }
  return { executable: comspec, args: ["/d", "/s", "/c", tokens.join(" ")] };
}

function killProcessTree(pid: number | undefined, fallback: () => void): void {
  if (pid && process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    let fellBack = false;
    const runFallback = () => {
      if (fellBack) return;
      fellBack = true;
      fallback();
    };
    killer.once("error", runFallback);
    killer.once("close", (code) => {
      if (code !== 0) runFallback();
    });
    return;
  }
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // The process may have exited between the timeout and the signal.
    }
  }
  fallback();
}

async function isSafeLocalEnvTarget(repoPath: string, path: string): Promise<boolean> {
  if (!(await commandExitZero("git", ["rev-parse", "--is-inside-work-tree"], repoPath))) {
    return true;
  }
  return commandExitZero("git", ["check-ignore", "--quiet", "--", path], repoPath);
}

function commandExitZero(executable: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolveResult) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      stdio: "ignore",
      env: sanitizedChildEnv(),
    });
    child.once("error", () => resolveResult(false));
    child.once("close", (code) => resolveResult(code === 0));
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function short(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
