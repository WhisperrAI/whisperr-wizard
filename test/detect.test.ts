import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { detectStack } from "../src/core/detect.js";

test("detectStack prefers Laravel/PHP over a frontend asset package", async () => {
  const repo = await fixture({
    "composer.json": JSON.stringify({ require: { "laravel/framework": "^11.0" } }),
    artisan: "",
    "package.json": JSON.stringify({ dependencies: { react: "^18.0.0", vite: "^5.0.0" } }),
  });

  const detections = await detectStack(repo);
  assert.equal(detections[0]?.target.id, "php");
});

test("detectStack recognizes Flutter and Next.js specifically", async () => {
  const flutter = await fixture({
    "pubspec.yaml": "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    "lib/main.dart": "void main() {}\n",
  });
  assert.equal((await detectStack(flutter))[0]?.target.id, "flutter");

  const next = await fixture({
    "package.json": JSON.stringify({ dependencies: { next: "^14.0.0", react: "^18.0.0" } }),
    "app/page.tsx": "export default function Page() { return null; }\n",
  });
  assert.equal((await detectStack(next))[0]?.target.id, "nextjs");
});

test("detectStack prefers React Native over generic web, for Expo and bare RN", async () => {
  const expo = await fixture({
    "package.json": JSON.stringify({
      dependencies: { expo: "~51.0.0", react: "18.2.0", "react-native": "0.74.0" },
    }),
    "app.json": JSON.stringify({ expo: { name: "demo" } }),
  });
  const expoDetections = await detectStack(expo);
  assert.equal(expoDetections[0]?.target.id, "react-native");
  assert.ok(!expoDetections.some((d) => d.target.id === "web-js"));

  const bare = await fixture({
    "package.json": JSON.stringify({
      dependencies: { react: "18.2.0", "react-native": "0.75.0" },
    }),
  });
  assert.equal((await detectStack(bare))[0]?.target.id, "react-native");
});

test("detectStack recognizes Swift projects (SPM, Xcode, Tuist)", async () => {
  const spm = await fixture({
    "Package.swift": "// swift-tools-version: 5.9\n",
    "Sources/App/main.swift": "",
  });
  assert.equal((await detectStack(spm))[0]?.target.id, "swift");

  const xcode = await fixture({
    "MyApp.xcodeproj/project.pbxproj": "",
    "MyApp/AppDelegate.swift": "",
  });
  assert.equal((await detectStack(xcode))[0]?.target.id, "swift");

  const tuist = await fixture({
    "Project.swift": "import ProjectDescription\n",
  });
  assert.equal((await detectStack(tuist))[0]?.target.id, "swift");
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "whisperr-wizard-"));
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const path = join(root, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }),
  );
  return root;
}
