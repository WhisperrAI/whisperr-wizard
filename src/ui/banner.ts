import { theme } from "./theme.js";

/**
 * Intro banner. Kept small and tasteful — a waveform glyph, the wordmark, and a
 * one-line promise. No oversized ASCII art.
 */
export function banner(): string {
  const wave = theme.signal("∿∿∿");
  const title = `${theme.bright("Whisperr")} ${theme.signal("Wizard")}`;
  const tagline = theme.muted(
    "Integrate Whisperr into your app — one command, fully wired.",
  );
  return [
    "",
    `  ${wave}  ${title}`,
    `  ${tagline}`,
    "",
  ].join("\n");
}

/** A compact step header, e.g. step("1", "Detecting your stack"). */
export function step(n: string, label: string): string {
  return `${theme.signal(theme.bold(n))}  ${theme.bright(label)}`;
}
