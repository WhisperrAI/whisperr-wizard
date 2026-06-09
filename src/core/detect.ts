import { readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Detection, DetectContext } from "../types.js";
import { ALL_PLAYBOOKS } from "./playbooks/index.js";

/** Build a cached, bounded filesystem context rooted at `repoPath`. */
export function makeDetectContext(repoPath: string): DetectContext {
  const cache = new Map<string, string>();

  return {
    repoPath,
    async read(relPath: string): Promise<string> {
      if (cache.has(relPath)) return cache.get(relPath)!;
      let content = "";
      try {
        content = await readFile(join(repoPath, relPath), "utf8");
      } catch {
        content = "";
      }
      cache.set(relPath, content);
      return content;
    },
    async exists(relPath: string): Promise<boolean> {
      try {
        await stat(join(repoPath, relPath));
        return true;
      } catch {
        return false;
      }
    },
    async list(relDir: string): Promise<string[]> {
      try {
        const entries = await readdir(join(repoPath, relDir), {
          withFileTypes: true,
        });
        return entries.map((e) => e.name);
      } catch {
        return [];
      }
    },
  };
}

/**
 * Run every playbook's detector and return matches, highest confidence first.
 * Multiple matches are possible (e.g. a Next.js repo also matches generic web);
 * the caller decides whether to auto-pick or ask.
 */
export async function detectStack(repoPath: string): Promise<Detection[]> {
  const ctx = makeDetectContext(repoPath);
  const results = await Promise.all(
    ALL_PLAYBOOKS.map((p) => p.detect(ctx).catch(() => null)),
  );
  return results
    .filter((d): d is Detection => d !== null)
    .sort((a, b) => b.confidence - a.confidence);
}
