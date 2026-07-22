import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { RunContext, type FunctionTool } from "@openai/agents";
import {
  createRepositoryTools,
  repositoryCommandInvocation,
} from "../src/core/repositoryTools.js";

test("repository tools deny .env reads and shell exfiltration without leaking content", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "whisperr-sandbox-"));
  const sentinel = "WHISPERR_SENTINEL_SECRET=sk-SENTINEL-DO-NOT-LEAK";
  await writeFile(join(repoPath, ".env"), `${sentinel}\n`, "utf8");
  try {
    const tools = createRepositoryTools({
      repoPath,
      ingestion: { apiKey: "ingestion-secret", baseUrl: "https://ingest.test" },
    });
    for (const [name, input] of [
      ["read_repository_file", { path: ".env" }],
      ["run_repository_command", { command: "cat .env" }],
    ] as const) {
      const entry = tools.find(
        (candidate): candidate is FunctionTool =>
          candidate.type === "function" && candidate.name === name,
      );
      assert.ok(entry);
      const output = await entry.invoke(new RunContext(), JSON.stringify(input));
      assert.equal(JSON.stringify(output).includes(sentinel), false);
      assert.match(JSON.stringify(output), /blocked|error/i);
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("repository tools reject symlinks that resolve outside the repository", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "whisperr-sandbox-"));
  const outsidePath = join(tmpdir(), `whisperr-outside-${process.pid}.txt`);
  await writeFile(outsidePath, "outside secret\n", "utf8");
  await symlink(outsidePath, join(repoPath, "linked.txt"));
  try {
    const entry = createRepositoryTools({
      repoPath,
      ingestion: { apiKey: "ingestion-secret", baseUrl: "https://ingest.test" },
    }).find(
      (candidate): candidate is FunctionTool =>
        candidate.type === "function" && candidate.name === "read_repository_file",
    );
    assert.ok(entry);
    const output = await entry.invoke(
      new RunContext(),
      JSON.stringify({ path: "linked.txt" }),
    );
    assert.equal(JSON.stringify(output).includes("outside secret"), false);
    assert.match(JSON.stringify(output), /blocked|error/i);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
    await rm(outsidePath, { force: true });
  }
});

test("repository tools reauthorize in-repository symlink destinations", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "whisperr-sandbox-"));
  const sentinel = "IN_REPOSITORY_SECRET_SENTINEL";
  await mkdir(join(repoPath, ".github/workflows"), { recursive: true });
  await writeFile(join(repoPath, ".env"), `${sentinel}\n`, "utf8");
  await writeFile(join(repoPath, ".github/workflows/deploy.yml"), "name: deploy\n", "utf8");
  await symlink(".env", join(repoPath, "safe.txt"));
  await symlink(".github/workflows/deploy.yml", join(repoPath, "safe.yml"));
  await symlink(".github/workflows", join(repoPath, "safe-ci"));
  try {
    const tools = createRepositoryTools({
      repoPath,
      ingestion: { apiKey: "ingestion-secret", baseUrl: "https://ingest.test" },
    });
    const read = await functionTool(tools, "read_repository_file").invoke(
      new RunContext(),
      JSON.stringify({ path: "safe.txt" }),
    );
    assert.equal(JSON.stringify(read).includes(sentinel), false);
    assert.match(JSON.stringify(read), /blocked|error/i);

    for (const [name, input] of [
      ["edit_file", { path: "safe.yml", oldText: "name: deploy", newText: "name: changed" }],
      ["create_file", { path: "safe-ci/new.yml", content: "name: new" }],
    ] as const) {
      const output = await functionTool(tools, name).invoke(
        new RunContext(),
        JSON.stringify(input),
      );
      assert.match(JSON.stringify(output), /blocked|error/i);
    }
    assert.equal(
      await readFile(join(repoPath, ".github/workflows/deploy.yml"), "utf8"),
      "name: deploy\n",
    );
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("configure_ingestion_env rejects a symlink to a non-env destination", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "whisperr-sandbox-"));
  await mkdir(join(repoPath, ".github/workflows"), { recursive: true });
  const workflow = join(repoPath, ".github/workflows/deploy.yml");
  await writeFile(workflow, "name: deploy\n", "utf8");
  await symlink(".github/workflows/deploy.yml", join(repoPath, ".env.local"));
  try {
    const configure = functionTool(
      createRepositoryTools({
        repoPath,
        ingestion: { apiKey: "ingestion-secret", baseUrl: "https://ingest.test" },
      }),
      "configure_ingestion_env",
    );
    const output = await configure.invoke(
      new RunContext(),
      JSON.stringify({ path: ".env.local", variableName: "WHISPERR_KEY" }),
    );
    assert.match(JSON.stringify(output), /blocked|error/i);
    assert.equal(await readFile(workflow, "utf8"), "name: deploy\n");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("host tools keep ingestion credentials out of source and configure only local env", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "whisperr-sandbox-"));
  const ingestionKey = "public-ingestion-secret";
  try {
    const tools = createRepositoryTools({
      repoPath,
      ingestion: { apiKey: ingestionKey, baseUrl: "https://ingest.test" },
    });
    const create = functionTool(tools, "create_file");
    const read = functionTool(tools, "read_repository_file");
    const configure = functionTool(tools, "configure_ingestion_env");

    await create.invoke(
      new RunContext(),
      JSON.stringify({
        path: "src/config.ts",
        content: `export const key = "__WHISPERR_INGESTION_KEY__";`,
      }),
    );
    assert.equal(
      await readFile(join(repoPath, "src/config.ts"), "utf8"),
      `export const key = "__WHISPERR_INGESTION_KEY__";`,
    );
    const visible = await read.invoke(
      new RunContext(),
      JSON.stringify({ path: "src/config.ts" }),
    );
    assert.equal(JSON.stringify(visible).includes(ingestionKey), false);
    assert.match(JSON.stringify(visible), /__WHISPERR_INGESTION_KEY__/);

    const configured = await configure.invoke(
      new RunContext(),
      JSON.stringify({ path: ".env.local", variableName: "VITE_WHISPERR_KEY" }),
    );
    assert.equal(JSON.stringify(configured).includes(ingestionKey), false);
    assert.equal(
      await readFile(join(repoPath, ".env.local"), "utf8"),
      `VITE_WHISPERR_KEY=${ingestionKey}\n`,
    );
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("configure_ingestion_env refuses a tracked environment file", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "whisperr-sandbox-"));
  const envPath = join(repoPath, ".env.local");
  try {
    await promisify(execFile)("git", ["-C", repoPath, "init"]);
    await writeFile(envPath, "EXISTING=value\n", "utf8");
    await promisify(execFile)("git", ["-C", repoPath, "add", "-f", ".env.local"]);
    const configure = functionTool(
      createRepositoryTools({
        repoPath,
        ingestion: { apiKey: "public-ingestion-secret", baseUrl: "https://ingest.test" },
      }),
      "configure_ingestion_env",
    );

    const output = await configure.invoke(
      new RunContext(),
      JSON.stringify({ path: ".env.local", variableName: "VITE_WHISPERR_KEY" }),
    );

    assert.match(JSON.stringify(output), /ignored by Git/i);
    assert.equal(await readFile(envPath, "utf8"), "EXISTING=value\n");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("Windows package commands use a validated cmd shim invocation", () => {
  assert.deepEqual(
    repositoryCommandInvocation(
      "npm",
      ["install", "@whisperr/web", "--ignore-scripts"],
      "win32",
      "C:\\Windows\\System32\\cmd.exe",
    ),
    {
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd install @whisperr/web --ignore-scripts"],
    },
  );
  assert.throws(() =>
    repositoryCommandInvocation("npm", ["install", "bad&command"], "win32"),
  );
});

function functionTool(tools: ReturnType<typeof createRepositoryTools>, name: string) {
  const entry = tools.find(
    (candidate): candidate is FunctionTool =>
      candidate.type === "function" && candidate.name === name,
  );
  assert.ok(entry, `missing tool ${name}`);
  return entry;
}
