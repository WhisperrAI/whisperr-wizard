import pc from "picocolors";

/**
 * Whisperr terminal palette. Restrained and tasteful — signal blue accent on a
 * mostly monochrome canvas, matching the product's dark, editorial brand.
 * Truecolor where supported, graceful fallback to picocolors' 16-color set.
 */

const truecolor =
  process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit";

function rgb(r: number, g: number, b: number, text: string): string {
  if (!truecolor || !pc.isColorSupported) return text;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export const theme = {
  /** Signal blue — the one accent. */
  signal: (s: string) => rgb(91, 141, 239, s),
  /** Muted hairline grey for secondary text. */
  muted: (s: string) => rgb(140, 140, 150, s),
  /** Near-white primary text. */
  bright: (s: string) => pc.white(pc.bold(s)),
  dim: (s: string) => pc.dim(s),
  success: (s: string) => rgb(110, 207, 159, s),
  warn: (s: string) => rgb(240, 191, 105, s),
  alert: (s: string) => rgb(248, 113, 113, s),
  bold: (s: string) => pc.bold(s),
} as const;

/** The waveform mark, rendered in signal blue. */
export const wordmark = (() => {
  const mark = theme.signal("⌁");
  return `${mark} ${theme.bright("whisperr")} ${theme.muted("wizard")}`;
})();

/** A thin divider. */
export const divider = theme.dim("─".repeat(48));
