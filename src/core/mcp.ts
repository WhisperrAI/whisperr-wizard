import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import open from "open";

export const INTEGRATION_CONTRACT = "2.0.0";
const DEFAULT_SCOPES = "integration:read registration:write test:write";
const MAX_MESSAGE = 256 * 1024;
type Json = Record<string, unknown>;
type Fetch = typeof fetch;
type Tokens = { access_token: string; refresh_token?: string; expires_in: number };

export function mcpBase(raw: string): string {
  const url = new URL(raw);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname) ||
    (!local && (url.protocol !== "https:" || !(url.hostname === "whisperr.net" || url.hostname.endsWith(".whisperr.net")))) ||
    (local && !["https:", "http:"].includes(url.protocol))) {
    throw new Error("MCP requires a Whisperr HTTPS origin or an explicit loopback development origin.");
  }
  return url.origin;
}

async function boundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, result = "";
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return result + decoder.decode();
      bytes += item.value.byteLength;
      if (bytes > 1024 * 1024) throw new Error("MCP response exceeds the size limit.");
      result += decoder.decode(item.value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function jsonRequest(request: Fetch, url: string, init: RequestInit = {}): Promise<Json> {
  const response = await request(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Whisperr authorization failed (${response.status}). Reconnect in the browser.`);
  const value: unknown = JSON.parse(await boundedText(response));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid authorization response.");
  return value as Json;
}
function tokenResult(raw: Json): Tokens {
  if (typeof raw.access_token !== "string" || !raw.access_token.startsWith("wmcp_") || raw.access_token.startsWith("wmcp_r_") ||
    typeof raw.expires_in !== "number" || raw.expires_in < 1 || raw.expires_in > 3600 ||
    (raw.refresh_token !== undefined && (typeof raw.refresh_token !== "string" || !raw.refresh_token.startsWith("wmcp_r_")))) {
    throw new Error("Whisperr returned an invalid MCP credential.");
  }
  return raw as unknown as Tokens;
}

/** OAuth is explicit and browser-bound. No provider/ingest token is accepted,
 * no credentials are written to disk, and the callback listens on loopback only. */
export class MCPBrowserAuthorization {
  private tokens?: Tokens;
  private expiresAt = 0;
  private clientID?: string;
  private pending?: Promise<string>;
  constructor(
    readonly base: string,
    private readonly scopes = DEFAULT_SCOPES,
    private readonly request: Fetch = fetch,
    private readonly launch: (url: string) => Promise<unknown> = open,
    private readonly log: (message: string) => void = (message) => { process.stderr.write(message + "\n"); },
  ) { this.base = mcpBase(base); }

  accessToken(): Promise<string> {
    if (this.tokens && Date.now() < this.expiresAt - 30_000) return Promise.resolve(this.tokens.access_token);
    if (!this.pending) this.pending = this.obtain().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private accept(raw: Json): string {
    this.tokens = tokenResult(raw);
    this.expiresAt = Date.now() + this.tokens.expires_in * 1000;
    return this.tokens.access_token;
  }
  private async obtain(): Promise<string> {
    if (this.tokens?.refresh_token && this.clientID) {
      // A rotating refresh token is never retried after an uncertain result.
      const refresh = this.tokens.refresh_token;
      this.tokens = undefined;
      return this.accept(await jsonRequest(this.request, this.base + "/oauth/mcp/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: this.clientID, resource: this.base + "/mcp" }),
      }));
    }
    const resource = await jsonRequest(this.request, this.base + "/.well-known/oauth-protected-resource/mcp");
    const metadata = await jsonRequest(this.request, this.base + "/.well-known/oauth-authorization-server");
    if (resource.resource !== this.base + "/mcp" || !Array.isArray(resource.authorization_servers) || !resource.authorization_servers.includes(this.base) ||
      metadata.issuer !== this.base || metadata.authorization_endpoint !== this.base + "/oauth/mcp/authorize" ||
      metadata.token_endpoint !== this.base + "/oauth/mcp/token" || metadata.registration_endpoint !== this.base + "/oauth/mcp/register") {
      throw new Error("MCP authorization metadata does not match the selected Whisperr server.");
    }
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let callbackOrigin = "";
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    // Attach a handler immediately: cancellation can arrive before browser open.
    void codePromise.catch(() => {});
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", callbackOrigin);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      const received = url.searchParams.get("state") ?? "";
      const validState = /^[A-Za-z0-9_-]{43}$/.test(received) && received.length === state.length && timingSafeEqual(Buffer.from(received), Buffer.from(state));
      if (req.method !== "GET" || req.headers.host !== new URL(callbackOrigin).host || url.origin !== callbackOrigin || url.pathname !== "/oauth/callback" ||
        url.searchParams.getAll("state").length !== 1 || !validState) { res.writeHead(400); res.end("Invalid authorization callback."); return; }
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || url.searchParams.getAll("code").length !== 1 || !code || code.length > 256) {
        res.writeHead(400); res.end("Authorization was not approved."); rejectCode(new Error("MCP authorization was not approved.")); return;
      }
      res.end("Whisperr is connected. You can close this tab."); resolveCode(code);
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") { server.close(); throw new Error("Unable to open the local authorization callback."); }
    callbackOrigin = `http://127.0.0.1:${address.port}`;
    const redirect = callbackOrigin + "/oauth/callback";
    const timer = setTimeout(() => rejectCode(new Error("MCP browser approval timed out.")), 10 * 60_000);
    try {
      const client = await jsonRequest(this.request, this.base + "/oauth/mcp/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Whisperr local MCP bridge", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
      });
      if (typeof client.client_id !== "string") throw new Error("Invalid MCP client registration.");
      this.clientID = client.client_id;
      const authorize = this.base + "/oauth/mcp/authorize?" + new URLSearchParams({ response_type: "code", client_id: this.clientID, redirect_uri: redirect, resource: this.base + "/mcp", state, code_challenge: challenge, code_challenge_method: "S256", scope: this.scopes });
      this.log("Approve this coding assistant in Whisperr:\n" + authorize);
      await this.launch(authorize).catch(() => {});
      const code = await codePromise;
      return this.accept(await jsonRequest(this.request, this.base + "/oauth/mcp/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: this.clientID, redirect_uri: redirect, resource: this.base + "/mcp", code_verifier: verifier }),
      }));
    } finally { clearTimeout(timer); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
}

/** Minimal client for our stateless MCP endpoint. Business rules and completion
 * checks are fetched from the server; this client has no gap/registration logic. */
export class IntegrationMCPClient {
  private nextID = 1;
  private protocolVersion = "2025-11-25";
  constructor(readonly base: string, private readonly token: () => Promise<string>, private readonly request: Fetch = fetch) { this.base = mcpBase(base); }

  async forward(message: Json): Promise<Json | undefined> {
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded) > MAX_MESSAGE || message.jsonrpc !== "2.0" || Array.isArray(message) || typeof message.method !== "string") throw new Error("Invalid MCP message.");
    // Interactive login has its own deadline; do not spend the HTTP budget
    // while the customer is reading and approving browser consent.
    const token = await this.token();
    const response = await this.request(this.base + "/mcp", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(35_000),
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": this.protocolVersion }, body: encoded,
    });
    if (!response.ok) throw new Error(`MCP request rejected (${response.status}); reconnect or repair permissions. No automatic mutation retry was attempted.`);
    if (response.status === 202) return undefined;
    const body = await boundedText(response);
    let decoded: unknown;
    if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
      // Streamable HTTP permits SSE for a request result. This server is
      // stateless; unsolicited sampling/roots requests are never accepted.
      const events = body.replace(/\r\n/g, "\n").split("\n\n").map((event) => event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")).filter(Boolean);
      decoded = events.map((event) => JSON.parse(event) as Json).find((event) => event.id === message.id && ("result" in event || "error" in event));
    } else { decoded = JSON.parse(body); }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Invalid MCP response.");
    const result = decoded as Json;
    if (result.jsonrpc !== "2.0" || result.id !== message.id) throw new Error("MCP response does not match its request.");
    if (message.method === "initialize" && result.result && typeof result.result === "object") {
      const version = (result.result as Json).protocolVersion;
      if (typeof version !== "string" || !["2025-11-25", "2026-07-28"].includes(version)) throw new Error("Unsupported MCP protocol version.");
      this.protocolVersion = version;
    }
    return result;
  }
  async initialize(): Promise<void> {
    const response = await this.forward({ jsonrpc: "2.0", id: this.nextID++, method: "initialize", params: { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo: { name: "Whisperr executor", version: INTEGRATION_CONTRACT } } });
    if (response?.error) throw new Error("MCP initialization failed.");
    await this.forward({ jsonrpc: "2.0", method: "notifications/initialized" });
    const playbook = await this.call("get_integration_playbook");
    if (playbook.contract_version !== INTEGRATION_CONTRACT) throw new Error("Integration contract mismatch; update the executor, do not retry.");
  }
  async call(tool: string, args: Json = {}): Promise<Json> {
    const response = await this.forward({ jsonrpc: "2.0", id: this.nextID++, method: "tools/call", params: { name: tool, arguments: { ...args, contract_version: INTEGRATION_CONTRACT } } });
    if (response?.error || !response?.result || typeof response.result !== "object") throw new Error("MCP tool request failed.");
    const result = response.result as Json;
    if (result.isError || !result.structuredContent || typeof result.structuredContent !== "object") throw new Error("MCP tool rejected the request. Inspect the server's integration status before retrying.");
    return result.structuredContent as Json;
  }
}

export async function serveMCPStdio(client: IntegrationMCPClient, input: Readable, output: Writable): Promise<void> {
  input.setEncoding("utf8");
  const write = async (message: Json) => {
    if (!output.write(JSON.stringify(message) + "\n")) await once(output, "drain");
  };
  let buffer = "";
  for await (const chunk of input) {
    buffer += String(chunk);
    if (Buffer.byteLength(buffer) > MAX_MESSAGE) throw new Error("MCP input exceeds the size limit.");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let request: Json | undefined;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid JSON-RPC.");
        request = parsed as Json;
        const response = await client.forward(request);
        if (response) await write(response);
      } catch {
        // No raw HTTP body, token, URL, or thrown dependency error reaches stdout.
        if (!request || "id" in request) await write({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32000, message: "Whisperr MCP request failed. Check authorization and integration status; mutations were not retried." } });
      }
    }
  }
  if (buffer.trim()) throw new Error("MCP input ended without a newline.");
}

export async function runMCPBridge(args: string[]): Promise<void> {
  let base = process.env.WHISPERR_WIZARD_API_BASE ?? "https://api.whisperr.net";
  let scopes = DEFAULT_SCOPES;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--api" && args[i + 1]) base = args[++i]!;
    else if (args[i] === "--scopes" && args[i + 1]) scopes = args[++i]!;
    else throw new Error("Usage: whisperr mcp [--api <Whisperr origin>] [--scopes <space-separated scopes>]");
  }
  base = mcpBase(base);
  const auth = new MCPBrowserAuthorization(base, scopes);
  await serveMCPStdio(new IntegrationMCPClient(base, () => auth.accessToken()), process.stdin, process.stdout);
}
