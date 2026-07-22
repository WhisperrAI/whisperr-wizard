const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /Bearer\s+[A-Za-z0-9._~+\/-]+/gi,
  /\b(?:OPENAI_API_KEY|WHISPERR_WIZARD_DIRECT_OPENAI_KEY|WHISPERR_INGESTION_KEY)\s*=\s*["']?[^"'\s]+["']?/gi,
];

export function scrubError(error: unknown, secrets: readonly string[] = []): string {
  let text = error instanceof Error ? error.message : String(error);
  text = stripTerminalControls(text);
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(secret, "[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match) => {
      const assignment = match.indexOf("=");
      return assignment >= 0
        ? `${match.slice(0, assignment + 1)}[redacted]`
        : "[redacted]";
    });
  }
  return text.slice(0, 2000).trim();
}

export function sanitizedChildEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const name of [
    "OPENAI_API_KEY",
    "WHISPERR_WIZARD_DIRECT_OPENAI_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
  ]) {
    delete env[name];
  }
  return env;
}

function stripTerminalControls(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .replace(/ {2,}/g, " ");
}
