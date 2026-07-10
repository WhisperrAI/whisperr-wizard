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

test(".envrc is denied", () => {
  assert.equal(policy("Read", { file_path: join(repoPath, ".envrc") }).behavior, "deny");
});

test("git log -p -- .env is denied", () => {
  assert.equal(policy("Bash", { command: "git log -p -- .env" }).behavior, "deny");
});

test("git diff with a plain path stays allowed", () => {
  assert.equal(policy("Bash", { command: "git diff src/index.ts" }).behavior, "allow");
});
