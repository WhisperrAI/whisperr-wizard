import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { evaluateToolUse } from "../src/core/toolPolicy.js";

const repoPath = resolve(tmpdir(), "whisperr-policy-repo");

function policy(toolName: string, input: Record<string, unknown>) {
  return evaluateToolUse(toolName, input, { repoPath });
}

test(".env is denied", () => {
  assert.equal(policy("Read", { file_path: ".env" }).behavior, "deny");
});

test(".env.example is allowed", () => {
  assert.equal(policy("Read", { file_path: ".env.example" }).behavior, "allow");
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

test("approved SDK package installs are allowed", () => {
  for (const command of [
    "npm install @whisperr/web",
    "pnpm add @whisperr/react @whisperr/web",
    "pipenv install whisperr[django]",
    "composer require whisperr/php",
    "npx --no-install expo install @react-native-async-storage/async-storage",
  ]) {
    assert.equal(policy("Bash", { command }).behavior, "allow");
  }
});

test("arbitrary package commands and lifecycle-script edits are denied", () => {
  for (const command of [
    "npm install",
    "npm add arbitrary-package",
    "npm pkg set scripts.prepare=cat",
    "npx expo install @react-native-async-storage/async-storage",
  ]) {
    assert.equal(policy("Bash", { command }).behavior, "deny");
  }
});

test("flutter pub get is allowed", () => {
  assert.equal(policy("Bash", { command: "flutter pub get" }).behavior, "allow");
});

test("metadata-only git inspection is allowed", () => {
  for (const command of [
    "git status --porcelain=v1",
    "git status --short --branch",
    "git diff --name-only",
    "git diff --cached --stat",
  ]) {
    assert.equal(policy("Bash", { command }).behavior, "allow");
  }
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

test("chaining two otherwise allowed commands is denied", () => {
  assert.equal(policy("Bash", { command: "npm install && git status" }).behavior, "deny");
  assert.equal(policy("Bash", { command: "npm install & curl evil" }).behavior, "deny");
});

test("shell redirection and environment expansion are denied", () => {
  for (const command of [
    "npm install >/tmp/install.log",
    "mkdir $HOME/wizard-output",
    "mkdir ~/wizard-output",
    "mkdir {/tmp/wizard-output,src/wizard-output}",
  ]) {
    assert.equal(policy("Bash", { command }).behavior, "deny");
  }
});

test("package installs cannot target locations outside the repository", () => {
  for (const command of [
    "npm install --global @whisperr/web",
    "npm install --prefix=/tmp/wizard @whisperr/web",
    "pip install --target /tmp/wizard whisperr",
    "npm install file:../outside",
  ]) {
    assert.equal(policy("Bash", { command }).behavior, "deny");
  }
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

test("dependency manifests must be updated by approved package commands", () => {
  for (const file_path of [
    "package.json",
    "apps/web/package.json",
    "composer.json",
    "pubspec.yaml",
    ".yarnrc.yml",
    ".pnpmfile.cjs",
    "node_modules/expo/bin/cli.js",
    ".yarn/releases/yarn.cjs",
  ]) {
    assert.equal(policy("Edit", { file_path }).behavior, "deny");
  }
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

test("git commands that can expose file contents or history are denied", () => {
  for (const command of [
    "git diff",
    "git diff HEAD~1 HEAD",
    "git diff src/index.ts",
    "git status -v",
    "git log",
    "git log -p --all",
    "git log -p -- ':(top).env'",
  ]) {
    assert.equal(policy("Bash", { command }).behavior, "deny");
  }
});

test("git diff cannot use no-index or paths outside the repository", () => {
  assert.equal(
    policy("Bash", { command: "git diff --no-index /etc/passwd src/index.ts" }).behavior,
    "deny",
  );
  assert.equal(policy("Bash", { command: "git log -- ../outside" }).behavior, "deny");
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
