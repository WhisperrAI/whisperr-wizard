import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  clean: true,
  minify: false,
  sourcemap: true,
  // The Agent SDK ships a native helper binary; keep it external so it resolves
  // from node_modules at runtime rather than being bundled.
  external: ["@anthropic-ai/claude-agent-sdk"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
