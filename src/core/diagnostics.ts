import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { scrubText } from "./scrub.js";
import { wizardStateRoot } from "./resumeState.js";

export type DiagnosticValue = string | number | boolean | null | undefined;
export type DiagnosticData = Record<string, DiagnosticValue>;

const SENSITIVE_FIELD =
  /(?:body|headers?|prompt|source|modelOutput|reasoning|subprocessOutput|env(?:ironment)?|deviceCode|userCode|verificationUrl|apiKey|token|secret|password)/i;
const UNSAFE_DIRECTORY_MESSAGE = "Wizard diagnostics directory is not secure.";

export class WizardDiagnostics {
  readonly invocationId: string;
  readonly path: string;
  private readonly secrets = new Set<string>();
  private fd: number | undefined;

  private constructor(path: string, invocationId: string, fd: number) {
    this.path = path;
    this.invocationId = invocationId;
    this.fd = fd;
  }

  static create(
    repoPath: string,
    env: NodeJS.ProcessEnv = process.env,
    now = new Date(),
  ): WizardDiagnostics {
    const configuredRoot = env.WHISPERR_WIZARD_LOG_DIR;
    const logRoot = resolve(configuredRoot ?? join(wizardStateRoot(env), "logs"));
    assertOutsideRepository(logRoot, resolve(repoPath));
    const directory = preparePrivateDirectory(logRoot);
    assertOutsideRepository(directory.realPath, realpathOrResolved(repoPath));

    const invocationId = randomUUID();
    const timestamp = now.toISOString().replaceAll(":", "-");
    const path = join(logRoot, `${timestamp}-${invocationId}.jsonl`);
    const fd = createPrivateFile(path, logRoot, directory);
    return new WizardDiagnostics(path, invocationId, fd);
  }

  registerSecrets(...values: Array<string | undefined>): void {
    for (const value of values) {
      if (value) this.secrets.add(value);
    }
  }

  log(event: string, data: DiagnosticData = {}): void {
    if (this.fd === undefined) return;
    const record: Record<string, string | number | boolean | null> = {
      timestamp: new Date().toISOString(),
      invocationId: this.invocationId,
      event: scrubText(event, [...this.secrets], 80),
    };
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || SENSITIVE_FIELD.test(key)) continue;
      record[key] =
        typeof value === "string" ? scrubText(value, [...this.secrets], 300) : value;
    }
    try {
      writeSync(this.fd, `${JSON.stringify(record)}\n`);
    } catch {
      this.close();
    }
  }

  close(): void {
    if (this.fd === undefined) return;
    const fd = this.fd;
    this.fd = undefined;
    try {
      fsyncSync(fd);
    } catch {
      // Best effort when the underlying filesystem cannot sync.
    }
    try {
      closeSync(fd);
    } catch {
      // Closing diagnostics must not mask the wizard result.
    }
  }
}

interface PrivateDirectory {
  realPath: string;
  stats: Stats;
}

function preparePrivateDirectory(path: string): PrivateDirectory {
  try {
    lstatSync(path);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throwUnsafeDirectory();
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } catch (mkdirError) {
      // Another process may have created the directory after the lstat.
      if (!isErrorCode(mkdirError, "EEXIST")) throwUnsafeDirectory();
    }
  }

  const stats = privateDirectoryStats(path);
  let realPath: string;
  try {
    realPath = realpathSync(path);
  } catch {
    throwUnsafeDirectory();
  }

  const confirmedStats = privateDirectoryStats(path);
  if (!sameFile(stats, confirmedStats)) throwUnsafeDirectory();
  return { realPath, stats: confirmedStats };
}

function createPrivateFile(
  path: string,
  directoryPath: string,
  directory: PrivateDirectory,
): number {
  let fd: number | undefined;
  try {
    assertDirectoryUnchanged(directoryPath, directory);
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    // The file was created exclusively; use its descriptor so no replacement path can be followed.
    fchmodSync(fd, 0o600);
    const fileStats = fstatSync(fd);
    if (
      !fileStats.isFile() ||
      fileStats.nlink !== 1 ||
      (fileStats.mode & 0o777) !== 0o600 ||
      !ownedByCurrentUser(fileStats)
    ) {
      throwUnsafeDirectory();
    }

    assertDirectoryUnchanged(directoryPath, directory);
    if (dirname(realpathSync(path)) !== directory.realPath) throwUnsafeDirectory();
    return fd;
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The fixed creation failure below is the only error exposed to the caller.
      }
    }
    throwUnsafeDirectory();
  }
}

function privateDirectoryStats(path: string): Stats {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch {
    throwUnsafeDirectory();
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    (stats.mode & 0o077) !== 0 ||
    !ownedByCurrentUser(stats)
  ) {
    throwUnsafeDirectory();
  }
  return stats;
}

function assertDirectoryUnchanged(path: string, expected: PrivateDirectory): void {
  const stats = privateDirectoryStats(path);
  let realPath: string;
  try {
    realPath = realpathSync(path);
  } catch {
    throwUnsafeDirectory();
  }
  if (!sameFile(stats, expected.stats) || realPath !== expected.realPath) {
    throwUnsafeDirectory();
  }
}

function ownedByCurrentUser(stats: Stats): boolean {
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function throwUnsafeDirectory(): never {
  throw new Error(UNSAFE_DIRECTORY_MESSAGE);
}

function realpathOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function sanitizeRequestPath(path: string): string {
  const withoutFragment = path.split("#", 1)[0] ?? "";
  const withoutQuery = withoutFragment.split("?", 1)[0] ?? "";
  const normalized = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  return scrubText(normalized, [], 300);
}

export function diagnosticErrorData(error: unknown): DiagnosticData {
  const candidate =
    typeof error === "object" && error !== null
      ? (error as { name?: unknown; status?: unknown; requestId?: unknown; code?: unknown })
      : undefined;
  return {
    errorType:
      candidate && typeof candidate.name === "string"
        ? candidate.name.slice(0, 80)
        : typeof error,
    status:
      candidate && typeof candidate.status === "number" ? candidate.status : undefined,
    requestId:
      candidate && typeof candidate.requestId === "string"
        ? candidate.requestId.slice(0, 200)
        : undefined,
    errorCode:
      candidate &&
      typeof candidate.code === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(candidate.code)
        ? candidate.code
        : undefined,
  };
}

function assertOutsideRepository(candidate: string, repoPath: string): void {
  const rel = relative(repoPath, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error("Wizard diagnostics directory must be outside the target repository.");
  }
}
