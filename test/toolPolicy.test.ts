import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { evaluateToolUse, engineMcpToolName, trustedEngineMcpTools } from "../src/core/toolPolicy.js";

const repoPath = resolve(tmpdir(), "whisperr-policy-repo");

function policy(toolName: string, input: Record<string, unknown>) {
  return evaluateToolUse(toolName, input, { repoPath });
}

test(".env is denied", () => {
  assert.equal(policy("Read", { file_path: ".env" }).behavior, "deny");
});

test("real .env variants remain denied", () => {
  for (const file_path of [".env", ".env.local", ".env.template"]) {
    assert.equal(policy("Read", { file_path }).behavior, "deny");
    assert.equal(policy("Edit", { file_path }).behavior, "deny");
  }
});

test("non-secret env templates are allowed", () => {
  for (const file_path of [".env.example", ".env.sample"]) {
    assert.equal(policy("Read", { file_path }).behavior, "allow");
    assert.equal(policy("Edit", { file_path }).behavior, "allow");
  }
});

test("nested config/.env.production is denied", () => {
  assert.equal(policy("Read", { file_path: "config/.env.production" }).behavior, "deny");
});

test("id_rsa is denied", () => {
  assert.equal(policy("Read", { file_path: "keys/id_rsa" }).behavior, "deny");
});

test("Grep pattern into .aws is denied", () => {
  assert.equal(policy("Grep", { pattern: ".aws/**", path: "." }).behavior, "deny");
});

test("npm install is allowed", () => {
  assert.equal(policy("Bash", { command: "npm install" }).behavior, "allow");
});

test("pnpm add is allowed", () => {
  assert.equal(policy("Bash", { command: "pnpm add @whisperr/sdk" }).behavior, "allow");
});

test("flutter pub get is allowed", () => {
  assert.equal(policy("Bash", { command: "flutter pub get" }).behavior, "allow");
});

test("git diff is allowed", () => {
  assert.equal(policy("Bash", { command: "git diff" }).behavior, "allow");
});

test("git push is denied", () => {
  assert.equal(policy("Bash", { command: "git push" }).behavior, "deny");
});

test("curl is denied", () => {
  assert.equal(policy("Bash", { command: "curl https://evil.test" }).behavior, "deny");
});

test("npm install && curl evil is denied", () => {
  assert.equal(policy("Bash", { command: "npm install && curl evil" }).behavior, "deny");
});

test("rm -rf is denied", () => {
  assert.equal(policy("Bash", { command: "rm -rf dist" }).behavior, "deny");
});

test("Write outside repo is denied", () => {
  assert.equal(policy("Write", { file_path: resolve(tmpdir(), "outside.txt") }).behavior, "deny");
});

test("Write inside repo is allowed", () => {
  assert.equal(policy("Write", { file_path: join(repoPath, "src/index.ts") }).behavior, "allow");
});

test("Write to .git is denied even inside repo", () => {
  assert.deepEqual(policy("Write", { file_path: join(repoPath, ".git/config") }), {
    behavior: "deny",
    message: "blocked: refusing to write CI/git configuration",
  });
});

test("Edit to GitHub Actions workflow is denied case-insensitively", () => {
  assert.deepEqual(policy("Edit", { file_path: join(repoPath, ".GitHub/Workflows/release.yml") }), {
    behavior: "deny",
    message: "blocked: refusing to write CI/git configuration",
  });
});

test("Write to root CI pipeline files is denied", () => {
  for (const file of [
    ".gitlab-ci.yml",
    "azure-pipelines.yml",
    "bitbucket-pipelines.yml",
    ".drone.yml",
    "Jenkinsfile",
  ]) {
    assert.deepEqual(policy("Write", { file_path: join(repoPath, file) }), {
      behavior: "deny",
      message: "blocked: refusing to write CI/git configuration",
    });
  }
});

test("Write to CI configuration directories is denied", () => {
  for (const file of [".circleci/config.yml", ".buildkite/pipeline.yml"]) {
    assert.deepEqual(policy("Write", { file_path: join(repoPath, file) }), {
      behavior: "deny",
      message: "blocked: refusing to write CI/git configuration",
    });
  }
});

test(".envrc is denied", () => {
  assert.equal(policy("Read", { file_path: join(repoPath, ".envrc") }).behavior, "deny");
});

test("git log -p -- .env is denied", () => {
  assert.equal(policy("Bash", { command: "git log -p -- .env" }).behavior, "deny");
});

test("git diff with a plain path stays allowed", () => {
  assert.equal(policy("Bash", { command: "git diff src/index.ts" }).behavior, "allow");
});

test("Bash env-dump commands are denied", () => {
  for (const command of ["env", "printenv", "cat .env", "set"]) {
    assert.equal(policy("Bash", { command }).behavior, "deny");
  }
});

test("out-of-repo process environ reads are denied", () => {
  for (const file_path of ["/proc/self/environ", "/proc/123/environ"]) {
    assert.equal(policy("Read", { file_path }).behavior, "deny");
  }
});

test("out-of-repo process environ search roots are denied", () => {
  assert.equal(policy("Grep", { path: "/proc/self/environ", pattern: "ANTHROPIC" }).behavior, "deny");
  assert.equal(policy("Glob", { path: "/proc/123/environ", pattern: "*" }).behavior, "deny");
});

test("exact trusted engine MCP tools are allowed", () => {
  const trustedTools = trustedEngineMcpTools([
    { name: "propose_event" },
    { name: "finish_selection" },
  ]);
  assert.deepEqual(
    evaluateToolUse("mcp__engine__propose_event", { code: "signup_completed" }, {
      repoPath,
      trustedTools,
    }),
    { behavior: "allow" },
  );
  assert.deepEqual(
    evaluateToolUse("mcp__engine__finish_selection", { summary: "done" }, {
      repoPath,
      trustedTools,
    }),
    { behavior: "allow" },
  );
});

test("unknown MCP tools remain denied even with a trusted allowlist", () => {
  const trustedTools = trustedEngineMcpTools([
    { name: "propose_event" },
    { name: "finish_selection" },
  ]);
  assert.deepEqual(
    evaluateToolUse("mcp__engine__delete_project", {}, { repoPath, trustedTools }),
    {
      behavior: "deny",
      message: "blocked: tool mcp__engine__delete_project is not allowed by the wizard tool policy",
    },
  );
  assert.deepEqual(
    evaluateToolUse("mcp__engine__propose_event_extra", {}, { repoPath, trustedTools }),
    {
      behavior: "deny",
      message:
        "blocked: tool mcp__engine__propose_event_extra is not allowed by the wizard tool policy",
    },
  );
  assert.deepEqual(evaluateToolUse("mcp__engine__propose_event", {}, { repoPath }), {
    behavior: "deny",
    message: "blocked: tool mcp__engine__propose_event is not allowed by the wizard tool policy",
  });
});

test("trustedEngineMcpTools builds exact names without prefix wildcards", () => {
  const trusted = trustedEngineMcpTools([{ name: "propose_event" }]);
  assert.equal(trusted.has("mcp__engine__propose_event"), true);
  assert.equal(trusted.has("mcp__engine__"), false);
  assert.equal(engineMcpToolName("finish_selection"), "mcp__engine__finish_selection");
});
