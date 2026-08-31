import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { generateBindings } from "../src/engine/bindings.js";

const event = { eventId: "event", code: "payment_completed", name: "Payment", reasoning: "Payment committed", anchorFile: "checkout.ts", payloadSchema: { total: "number", count: "integer", paid: "boolean", result: "null", plan: "string" } };
const expected = { total: 42.5, count: 2, paid: true, result: null, plan: "pro" };

for (const target of ["web-js", "node"]) test(`${target} emitted TypeScript compiles, preserves JSON types and rejects stringified numbers`, () => {
  const dir = mkdtempSync(join(tmpdir(), "wizard-typed-ts-"));
  const binding = generateBindings(target, [event]);
  const bind = target === "node"
    ? "bindWhisperr({ track: (_userId, _event, payload) => console.log(JSON.stringify(payload)) });"
    : "bindWhisperr({ track: (_event, payload) => console.log(JSON.stringify(payload)) });";
  const invoke = `WhisperrEvents.paymentCompleted(${target === "node" ? '"stable-id", ' : ""}{ total: 42.5, count: 2, paid: true, result: null, plan: "pro" });`;
  writeFileSync(join(dir, "bindings.ts"), `${binding.content}\n${bind}\n${invoke}`);
  const compiler = resolve("node_modules/typescript/bin/tsc");
  const args = [compiler, join(dir, "bindings.ts"), "--module", "commonjs", "--target", "ES2022", "--strict", "--skipLibCheck", "--types", "node", "--typeRoots", resolve("node_modules/@types"), "--outDir", join(dir, "out")];
  execFileSync(process.execPath, args, { stdio: "pipe" });
  const emitted = execFileSync(process.execPath, [join(dir, "out/bindings.js")], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(emitted), expected);
  writeFileSync(join(dir, "bindings.ts"), `${binding.content}\n${invoke.replace("total: 42.5", 'total: "42.5"')}`);
  assert.notEqual(spawnSync(process.execPath, args).status, 0, "number registration must not accept string output");
});

test("emitted JavaScript contains no TypeScript assertions and preserves null and numeric values", () => {
  const dir = mkdtempSync(join(tmpdir(), "wizard-typed-js-"));
  const binding = generateBindings("web-js", [event], ["app.js"]);
  const file = join(dir, "bindings.mjs");
  writeFileSync(file, `${binding.content}\nbindWhisperr({ track: (_event, payload) => console.log(JSON.stringify(payload)) });\nWhisperrEvents.paymentCompleted(${JSON.stringify(expected)});`);
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [file], { encoding: "utf8" })), expected);
});

test("emitted Swift compiles and preserves primitive JSON instead of stringifying", (t) => {
  if (spawnSync("swift", ["--version"]).status !== 0) { t.skip("Swift compiler not installed"); return; }
  const dir = mkdtempSync(join(tmpdir(), "wizard-typed-swift-"));
  const file = join(dir, "Bindings.swift");
  const binding = generateBindings("swift", [event]);
  writeFileSync(file, `${binding.content}\nWhisperrEvents.bind { _, payload in\nlet data = try! JSONSerialization.data(withJSONObject: payload)\nprint(String(data: data, encoding: .utf8)!)\n}\nWhisperrEvents.paymentCompleted(total: 42.5, count: 2, paid: true, result: NSNull(), plan: "pro")`);
  const emitted = execFileSync("swift", [file], { encoding: "utf8", timeout: 60_000 });
  assert.deepEqual(JSON.parse(emitted), expected);
});

test("emitted Dart compiles and preserves nullable primitive payloads", (t) => {
  if (spawnSync("dart", ["--version"]).status !== 0) { t.skip("Dart compiler not installed"); return; }
  const dir = mkdtempSync(join(tmpdir(), "wizard-typed-dart-"));
  const file = join(dir, "bindings.dart");
  const binding = generateBindings("flutter", [event]);
  writeFileSync(file, `import 'dart:convert';\n${binding.content}\nvoid main() {\nWhisperrEvents.bind((_, payload) => print(jsonEncode(payload)));\nWhisperrEvents.paymentCompleted(total: 42.5, count: 2, paid: true, result: null, plan: 'pro');\n}`);
  const emitted = execFileSync("dart", ["run", file], { encoding: "utf8", timeout: 60_000 });
  assert.deepEqual(JSON.parse(emitted), expected);
});
