import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  sanitizeRequestPath,
  WizardDiagnostics,
} from "../src/core/diagnostics.js";
import { scrubError } from "../src/core/scrub.js";

test("diagnostics creates one private JSONL file outside the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "wizard-diagnostics-"));
  const repo = join(root, "customer-repository-name");
  const logs = join(root, "logs");
  await mkdir(repo);

  const diagnostics = WizardDiagnostics.create(repo, {
    WHISPERR_WIZARD_LOG_DIR: logs,
  });
  diagnostics.log("invocation_start", { forced: false });
  diagnostics.log("invocation_end", { outcome: "completed", exitCode: 0 });
  diagnostics.close();

  const files = await readdir(logs);
  assert.equal(files.length, 1);
  assert.match(
    files[0]!,
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f-]{36}\.jsonl$/,
  );
  assert.equal(files[0]!.includes("customer"), false);
  assert.equal((await stat(logs)).mode & 0o777, 0o700);
  assert.equal((await stat(diagnostics.path)).mode & 0o777, 0o600);

  const records = (await readFile(diagnostics.path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(records.map((record) => record.event), [
    "invocation_start",
    "invocation_end",
  ]);
  assert.equal(records[0]!.invocationId, records[1]!.invocationId);
});

test("diagnostics applies dynamic exact-secret and strict patterned redaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "wizard-redaction-"));
  const repo = join(root, "repo");
  const logs = join(root, "logs");
  await mkdir(repo);
  const diagnostics = WizardDiagnostics.create(repo, {
    WHISPERR_WIZARD_LOG_DIR: logs,
  });
  diagnostics.registerSecrets("opaque-session-value");
  diagnostics.log("activity", {
    activity:
      "\u001b]8;;https://evil.test\u0007open\u001b[31m opaque-session-value " +
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature " +
      "api_token=token-value https://user:pass@example.test/path?key=value",
    body: "forbidden-response-body",
    headers: "authorization: opaque-session-value",
  });
  diagnostics.close();

  const contents = await readFile(diagnostics.path, "utf8");
  for (const forbidden of [
    "opaque-session-value",
    "eyJhbGciOiJIUzI1NiJ9",
    "token-value",
    "user:pass",
    "key=value",
    "forbidden-response-body",
    "authorization",
    "\u001b",
  ]) {
    assert.equal(contents.includes(forbidden), false, forbidden);
  }
  assert.match(contents, /\[redacted\]/);
});

test("diagnostics refuses a log directory inside the customer repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "wizard-outside-"));
  const repo = join(root, "repo");
  await mkdir(repo);

  assert.throws(
    () =>
      WizardDiagnostics.create(repo, {
        WHISPERR_WIZARD_LOG_DIR: join(repo, ".logs"),
      }),
    /outside the target repository/,
  );
});

test("diagnostics rejects an existing shared log directory without changing its mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "wizard-shared-logs-"));
  const repo = join(root, "repo");
  const logs = join(root, "logs");
  await mkdir(repo);
  await mkdir(logs);
  await chmod(logs, 0o755);

  assert.throws(
    () => WizardDiagnostics.create(repo, { WHISPERR_WIZARD_LOG_DIR: logs }),
    { message: "Wizard diagnostics directory is not secure." },
  );
  assert.equal((await stat(logs)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(logs), []);
});

test("diagnostics uses an existing owner-private log directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "wizard-private-logs-"));
  const repo = join(root, "repo");
  const logs = join(root, "logs");
  await mkdir(repo);
  await mkdir(logs);
  await chmod(logs, 0o700);

  const diagnostics = WizardDiagnostics.create(repo, {
    WHISPERR_WIZARD_LOG_DIR: logs,
  });
  diagnostics.close();

  assert.equal((await stat(logs)).mode & 0o777, 0o700);
  assert.equal((await stat(diagnostics.path)).mode & 0o777, 0o600);
});

test("diagnostics rejects a log-directory symlink into the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "wizard-symlink-"));
  const repo = join(root, "repo");
  const logs = join(root, "logs");
  await mkdir(repo);
  await chmod(repo, 0o755);
  await symlink(repo, logs, "dir");

  assert.throws(
    () => WizardDiagnostics.create(repo, { WHISPERR_WIZARD_LOG_DIR: logs }),
    { message: "Wizard diagnostics directory is not secure." },
  );
  assert.equal((await stat(repo)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(repo), []);
});

test("diagnostics defaults to the existing wizard state root logs directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "wizard-state-"));
  const repo = join(root, "repo");
  const state = join(root, "state");
  await mkdir(repo);
  const diagnostics = WizardDiagnostics.create(repo, {
    WHISPERR_WIZARD_STATE_DIR: state,
  });
  diagnostics.close();

  assert.equal(diagnostics.path.startsWith(join(state, "logs")), true);
});

test("request paths and errors discard URL credentials and query values", () => {
  assert.equal(
    sanitizeRequestPath("/wizard/runs/run_1?token=secret#fragment"),
    "/wizard/runs/run_1",
  );
  const scrubbed = scrubError(
    "GET https://user:pass@example.test/path?token=secret and PASSWORD=hunter2",
  );
  assert.equal(scrubbed.includes("user:pass"), false);
  assert.equal(scrubbed.includes("token=secret"), false);
  assert.equal(scrubbed.includes("hunter2"), false);
  assert.equal(
    scrubError('{"access_token":"json-secret"}').includes("json-secret"),
    false,
  );
  assert.equal(
    scrubError("-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----"),
    "[redacted]",
  );
});

test("scrubError produces bounded one-line terminal-safe text", () => {
  const scrubbed = scrubError(
    "useful first line\r\nsecond line\u001b[31m red\u001b[0m\u009b32m green\u0007 " +
      "a".repeat(3_000),
  );

  assert.match(scrubbed, /useful first line second line/);
  assert.match(scrubbed, /red/);
  assert.equal(scrubbed.length, 2_000);
  assert.equal(/[\r\n\u2028\u2029]/u.test(scrubbed), false);
  // eslint-disable-next-line no-control-regex
  assert.equal(/[\x00-\x1f\x7f-\x9f]/.test(scrubbed), false);
});
