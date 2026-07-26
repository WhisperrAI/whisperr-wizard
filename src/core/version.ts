import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);

/**
 * The published wizard version. Lives here rather than in the CLI entry point
 * so the run reporter can stamp it without importing the entry module (which
 * self-executes on import).
 */
export function packageVersion(): string {
  try {
    const packagePath = join(dirname(modulePath), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
