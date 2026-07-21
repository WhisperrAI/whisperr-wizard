import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  minify: false,
  // No sourcemap in the published package — it would embed the original TS
  // source (internal comments, endpoint wiring) on a public registry.
  sourcemap: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
