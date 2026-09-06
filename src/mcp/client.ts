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
  constructor(public readonly status: number, message: string) {
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
      // The connector challenges with `WWW-Authenticate`; surface it, because it names where to
      // authenticate and is the only useful thing in an otherwise empty refusal.
      const challenge = res.headers.get('www-authenticate') ?? '';
      throw new ViaMcpAuthError(res.status, `credential refused${challenge ? ` — ${challenge}` : ''}`);
    }
    if (!res.ok) throw new Error(`MCP request failed: HTTP ${res.status}`);

    const payload = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
    if (payload.error) throw new Error(`MCP error ${payload.error.code}: ${payload.error.message}`);
    return payload.result;
  }

  return {
    async initialize() {
      return (await rpc('initialize', {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'via-agent-sdk', version: '0.1.0' },
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
