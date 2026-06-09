import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  clean: true,
  minify: false,
  // No sourcemap in the published package — it would embed the original TS
  // source (internal comments, endpoint wiring) on a public registry.
  sourcemap: false,
  // The Agent SDK ships a native helper binary; keep it external so it resolves
  // from node_modules at runtime rather than being bundled.
  external: ["@anthropic-ai/claude-agent-sdk"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
