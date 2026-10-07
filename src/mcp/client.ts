/**
 * The MCP CLIENT — how a VIA-native agent reaches the Humanos connector (`apps/mcp`).
 *
 * `server.ts` in this folder is the other direction: it exposes the agent's OWN tools to an LLM
 * host over stdio. This file is the agent CONSUMING the platform's tools over HTTP, and it was
 * missing — the omission that `spec/MCP-JOURNEYS.md` was written to find (journey A4, direction
 * D3).
 *
 * **It authenticates with the organization's API key, not OAuth.** A third-party agent has no key,
 * so a person consents on its behalf; an agent built with this SDK needs none of that, because its
 * authority is the org's — established at registration under that key and carried by
 * `AFFILIATION`. Nobody is delegating anything, so there is nothing to consent to.
 *
 * No dependencies: `node:crypto` and global `fetch`. This package ships source to agent builders
 * and stays free of platform internals, which is also why the HMAC below is implemented here
 * rather than imported. The scheme is a **wire contract**, so the risk is drift — pinned by a
 * golden vector in `agent2/test/via-mcp-client.spec.ts` generated from the platform's own
 * implementation.
 */
import { createHmac } from 'node:crypto';
import type { McpTool } from '../types.js';

/** Sent as `clientInfo.version`; keep in step with package.json. */
export const SDK_VERSION = '0.1.2';

export interface ViaMcpClientOptions {
  /** Full endpoint, e.g. `https://mcp.humanos.tech/mcp`. */
  url: string;
  /** The organization API key the platform issued. */
  apiKey: string;
  /** That key's signing secret. */
  signatureSecret: string;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Overridable for tests; defaults to `Date.now`. */
  now?: () => number;
  protocolVersion?: string;
}

export interface ViaToolResult {
  /** The tool's text content, joined. */
  text: string;
  /** True when the server refused — a decision, not a transport failure. Do not retry. */
  isError: boolean;
}

export interface ViaMcpClient {
  initialize(): Promise<{ serverInfo: { name: string; version: string }; protocolVersion: string }>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<ViaToolResult>;
}

/** Raised when the connector refuses the credential — distinct from a tool refusing a request. */
export class ViaMcpAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** The connector's response body: parsed JSON when it is JSON, the text otherwise. */
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ViaMcpAuthError';
  }
}

/**
 * HMAC-SHA256 over `<timestamp>.<body>`, or the timestamp alone when the body is empty — hex.
 *
 * Exported because the golden-vector test signs through it directly. Any change here is a
 * wire-breaking change.
 */
export function signRequest(body: string, secret: string, timestamp: number): string {
  const toSign = body ? `${timestamp}.${body}` : String(timestamp);
  return createHmac('sha256', secret).update(toSign).digest('hex');
}

export function createViaMcpClient(options: ViaMcpClientOptions): ViaMcpClient {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const protocolVersion = options.protocolVersion ?? '2025-06-18';
  let id = 0;

  async function rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    // Serialise ONCE and send the exact bytes that were signed. Re-stringifying for the request
    // would risk a different key order from the string the HMAC covered, and the server verifies
    // against its own re-serialisation of what it parsed — so any divergence here is a signature
    // failure that looks like a credential problem.
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) });
    const timestamp = now();

    const res = await doFetch(options.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Both media types are required on POST even though this server answers with JSON.
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${options.apiKey}`,
        'x-timestamp': String(timestamp),
        'x-signature': signRequest(body, options.signatureSecret, timestamp),
        'MCP-Protocol-Version': protocolVersion,
      },
      body,
    });

    if (res.status === 401 || res.status === 403) {
      // The body is the only thing that tells the failures apart ("Invalid signature" from the
      // HMAC guard, `invalid_token` from the OAuth layer), so it goes in the message and on the
      // error. The `WWW-Authenticate` challenge names where to authenticate; keep it too.
      const body = await readErrorBody(res);
      const reason = errorReason(body);
      const challenge = res.headers.get('www-authenticate') ?? '';
      throw new ViaMcpAuthError(res.status, `credential refused (HTTP ${res.status})${reason ? `: ${reason}` : ''}${challenge ? ` [${challenge}]` : ''}`, body);
    }
    if (!res.ok) {
      const reason = errorReason(await readErrorBody(res));
      throw new Error(`MCP request failed: HTTP ${res.status}${reason ? `: ${reason}` : ''}`);
    }

    const payload = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
    if (payload.error) throw new Error(`MCP error ${payload.error.code}: ${payload.error.message}`);
    return payload.result;
  }

  return {
    async initialize() {
      return (await rpc('initialize', {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'via-agent-sdk', version: SDK_VERSION },
      })) as { serverInfo: { name: string; version: string }; protocolVersion: string };
    },

    async listTools() {
      const result = (await rpc('tools/list')) as { tools?: McpTool[] };
      return result.tools ?? [];
    },

    async callTool(name, args = {}) {
      const result = (await rpc('tools/call', { name, arguments: args })) as {
        content?: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = (result.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
      // A refusal arrives as a RESULT with `isError`, not as a JSON-RPC error, and the difference
      // matters: the request was understood and denied. Callers should surface the reason rather
      // than retry it.
      return { text, isError: result.isError === true };
    },
  };
}

/** The error response body: parsed JSON when it is JSON, the text otherwise, undefined when empty. */
async function readErrorBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The server's own words from an error body. Nest answers `{ message }` (an array for validation
 * errors), OAuth answers `{ error, error_description }`, JSON-RPC answers `{ error: { message } }`.
 * Anything else (a proxy's HTML page) is cut short.
 */
function errorReason(body: unknown): string {
  if (typeof body === 'string') return body.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!body || typeof body !== 'object') return '';
  const { message, error_description: description, error } = body as { message?: unknown; error_description?: unknown; error?: unknown };
  if (typeof message === 'string' && message) return message;
  if (Array.isArray(message)) return message.join('; ');
  if (typeof description === 'string' && description) return description;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
  return '';
}
