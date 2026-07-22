import { stripVTControlCharacters } from "node:util";

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /Bearer\s+[A-Za-z0-9._~+\/-]+/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)? PRIVATE KEY-----|$)/gi,
  /["']?\b(?:[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|ACCESS[_-]?KEY|AUTH)[A-Z0-9_]*)\b["']?\s*(?:=|:)\s*["']?[^"'\s,;}]+["']?/gi,
];

export function scrubError(error: unknown, secrets: readonly string[] = []): string {
  const text = error instanceof Error ? error.message : String(error);
  return scrubText(text, secrets, 2000);
}

export function scrubText(
  value: string,
  secrets: readonly string[] = [],
  maxLength = 2000,
): string {
  let text = stripTerminalControls(value);
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
  text = text.replace(
    /\b(https?:\/\/)([^\s\/@]+):([^\s@\/]+)@([^\s?#]+)([^\s]*)/gi,
    "$1[redacted]@$4$5",
  );
  text = text.replace(/\b(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?[redacted]");
  return text.slice(0, maxLength).trim();
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
  return stripVTControlCharacters(value)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/[\u2028\u2029]/g, " ")
    .replace(/ {2,}/g, " ");
}
