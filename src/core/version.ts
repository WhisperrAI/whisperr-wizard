import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@whisperr/wizard";

/**
 * The published wizard version, stamped onto every run report.
 *
 * Walks up from this module looking for our own package.json rather than using
 * a fixed relative path. A fixed path cannot be right in both places: from
 * source this file sits at src/core/, but tsup bundles it into dist/index.js —
 * one directory shallower. The first version of this hardcoded the source depth
 * and reported "0.0.0" from every published binary.
 *
 * Checking the `name` matters too: walking up from a customer's node_modules
 * would otherwise find THEIR package.json first and report their version as
 * ours.
 */
export function packageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const { root } = parse(dir);

  while (true) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === PACKAGE_NAME && pkg.version) return pkg.version;
    } catch {
      /* no package.json here, or unreadable — keep walking */
    }
    if (dir === root) return "0.0.0";
    dir = dirname(dir);
  }
}
