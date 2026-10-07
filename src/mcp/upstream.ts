/**
 * An MCP CLIENT for the servers the governing proxy stands in front of — Slack's, Gmail's, a
 * payments server, or a stand-in that records calls instead of making them.
 *
 * Three transports, one session shape (initialize → tools/list → tools/call):
 *   • stdio — spawn the server, newline-delimited JSON-RPC over its stdin/stdout (stderr passes
 *     through), the way Claude Desktop and Cursor launch MCP servers;
 *   • Streamable HTTP — POST JSON-RPC, answered as JSON or as an event stream, with the session
 *     id the server hands back;
 *   • in-process — a `handleRpc`, for stand-ins and tests.
 *
 * Node built-ins only, like the rest of this package. Server→client requests (sampling,
 * elicitation) are not passed through yet: an upstream that sends one gets no answer. A server's
 * notifications are not listened to: when its tools change, the agent says so (`refresh`).
 */
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type { JsonRpcMessage } from './server.js';

export interface UpstreamTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** MCP tool annotations — hints from the server, not guarantees. */
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

/**
 * The MCP server behind an upstream: what it says it is (`initialize`), and how it is reached.
 * Never a URL path, arguments, environment or headers: those can hold credentials.
 */
export interface UpstreamServer {
  name?: string;
  version?: string;
  title?: string;
  /** `stdio` for a local server, `http` for a remote one; absent for an in-process one. */
  transport?: 'stdio' | 'http';
  /** A remote server's host (`mcp.slack.com`), or a local server's command name (`npx`). */
  host?: string;
}

export interface UpstreamResult {
  content: { type: string; text?: string; [k: string]: unknown }[];
  isError?: boolean;
  structuredContent?: unknown;
}

/** What a caller may add to ONE `tools/call` beyond its arguments. */
export interface UpstreamCallExtra {
  /** Rides `params._meta` — MCP's own slot for per-request metadata, so it reaches every transport. */
  meta?: Record<string, unknown>;
  /**
   * Streamable HTTP only: headers for this one request, for a gateway that reads headers and not
   * bodies. They never replace a header the transport or the upstream's own credential sets.
   */
  headers?: Record<string, string>;
}

export interface Upstream {
  /** The service this server is, as the organization will see it grouped: "Slack", "Gmail". */
  readonly service: string;
  /** The server behind it, once the handshake is done. Optional for upstreams written by hand. */
  readonly server?: UpstreamServer;
  listTools(): Promise<UpstreamTool[]>;
  callTool(name: string, args: Record<string, unknown>, extra?: UpstreamCallExtra): Promise<UpstreamResult>;
  close(): Promise<void>;
}

export interface UpstreamSpec {
  service: string;
  /** stdio: the command to spawn, its arguments, environment and working directory. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Streamable HTTP: the endpoint, and any headers (an upstream's own credential goes here). */
  url?: string;
  headers?: Record<string, string>;
  /** Per request. Default 60 s. */
  timeoutMs?: number;
}

const PROTOCOL = '2025-06-18';
const CLIENT_INFO = { name: 'via-proxy', version: '0.1.0' };

/** `headers` are per request and only an HTTP transport has anywhere to put them. */
type Send = (msg: JsonRpcMessage, headers?: Record<string, string>) => Promise<JsonRpcMessage | null>;

function session(service: string, reached: Pick<UpstreamServer, 'transport' | 'host'>, send: Send, notify: (msg: JsonRpcMessage) => Promise<void>, close: () => Promise<void>): Upstream & { init(): Promise<void> } {
  let seq = 0;
  const server: UpstreamServer = { ...reached };
  const rpc = async (method: string, params?: Record<string, unknown>, headers?: Record<string, string>): Promise<Record<string, unknown>> => {
    const resp = await send({ jsonrpc: '2.0', id: `${service}-${++seq}`, method, ...(params ? { params } : {}) }, headers);
    if (!resp) throw new Error(`upstream ${service}: no response to ${method}`);
    if (resp.error) throw new Error(`upstream ${service}: ${method} failed — ${typeof resp.error === 'object' ? JSON.stringify(resp.error) : String(resp.error)}`);
    return (resp.result ?? {}) as Record<string, unknown>;
  };
  return {
    service,
    server,
    async init() {
      const r = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO });
      Object.assign(server, serverInfoOf(r.serverInfo));
      await notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    async listTools() {
      const out: UpstreamTool[] = [];
      let cursor: string | undefined;
      // Paginated per the spec; bounded so a server that always returns a cursor cannot spin us.
      for (let page = 0; page < 50; page++) {
        const r = (await rpc('tools/list', cursor ? { cursor } : undefined)) as { tools?: UpstreamTool[]; nextCursor?: string };
        out.push(...(r.tools ?? []));
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      return out;
    },
    async callTool(name, args, extra) {
      const r = (await rpc('tools/call', { name, arguments: args, ...(extra?.meta ? { _meta: extra.meta } : {}) }, extra?.headers)) as Partial<UpstreamResult>;
      return {
        content: Array.isArray(r.content) ? r.content : [],
        ...(r.isError ? { isError: true } : {}),
        ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
      };
    },
    close,
  };
}

/** An upstream in this process: a `handleRpc` (a stand-in, or a server under test). */
export async function inProcessUpstream(service: string, handleRpc: (msg: JsonRpcMessage) => Promise<JsonRpcMessage | null>): Promise<Upstream> {
  const s = session(service, {}, handleRpc, async (m) => { await handleRpc(m); }, async () => {});
  await s.init();
  return s;
}

/** Connect to an MCP server by command (stdio) or URL (Streamable HTTP), and complete the handshake. */
export async function connectUpstream(spec: UpstreamSpec): Promise<Upstream> {
  if (spec.command) return stdioUpstream(spec);
  if (spec.url) return httpUpstream(spec);
  throw new Error(`upstream ${spec.service}: give a command (stdio) or a url (Streamable HTTP)`);
}

async function stdioUpstream(spec: UpstreamSpec): Promise<Upstream> {
  const child = spawn(spec.command!, spec.args ?? [], { cwd: spec.cwd, env: { ...process.env, ...(spec.env ?? {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map<string, { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let gone: Error | null = null;
  const fail = (e: Error): void => {
    gone = e;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(e);
      pending.delete(id);
    }
  };
  child.on('error', (e) => fail(new Error(`upstream ${spec.service}: ${e.message}`)));
  child.on('exit', (code, signal) => fail(new Error(`upstream ${spec.service} exited (${signal ?? code})`)));
  createInterface({ input: child.stdout }).on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(text) as JsonRpcMessage;
    } catch {
      return; // a server that logs to stdout: ignore what is not JSON-RPC
    }
    if (msg.method !== undefined || msg.id == null) return; // server→client request or notification: not passed through yet
    const p = pending.get(String(msg.id));
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(String(msg.id));
    p.resolve(msg);
  });
  const timeoutMs = spec.timeoutMs ?? 60_000;
  const write = (msg: JsonRpcMessage): void => {
    if (gone) throw gone;
    child.stdin.write(JSON.stringify(msg) + '\n');
  };
  const send: Send = (msg) =>
    new Promise((resolve, reject) => {
      const id = String(msg.id);
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`upstream ${spec.service}: ${String(msg.method)} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        write(msg);
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e as Error);
      }
    });
  const s = session(spec.service, { transport: 'stdio', host: basename(spec.command!) }, send, async (m) => write(m), async () => {
    child.stdin.end();
    child.kill();
  });
  await s.init();
  return s;
}

async function httpUpstream(spec: UpstreamSpec): Promise<Upstream> {
  let sessionId: string | undefined;
  const post: Send = async (msg, perCall) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      ...(spec.headers ?? {}),
    };
    // Per-call headers add, never replace: a name the transport or the upstream's credential
    // already set (in any letter case) is dropped rather than merged into it.
    const taken = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
    for (const [k, v] of Object.entries(perCall ?? {})) if (!taken.has(k.toLowerCase())) headers[k] = v;
    const res = await fetch(spec.url!, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(spec.timeoutMs ?? 60_000),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (msg.id === undefined) return null; // a notification: 202, no body
    if (!res.ok) throw new Error(`upstream ${spec.service}: HTTP ${res.status} on ${String(msg.method)}`);
    const text = await res.text();
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const m = JSON.parse(line.slice(5).trim()) as JsonRpcMessage;
          if (m.id === msg.id) return m;
        } catch {
          /* keep scanning */
        }
      }
      throw new Error(`upstream ${spec.service}: no response to ${String(msg.method)} in the event stream`);
    }
    return JSON.parse(text) as JsonRpcMessage;
  };
  const s = session(spec.service, { transport: 'http', host: new URL(spec.url!).hostname }, post, async (m) => { await post(m); }, async () => {});
  await s.init();
  return s;
}

/** The server's own `serverInfo`: its name, version and title, the ones that are strings. */
function serverInfoOf(info: unknown): Pick<UpstreamServer, 'name' | 'version' | 'title'> {
  const i = (info && typeof info === 'object' ? info : {}) as Record<string, unknown>;
  const out: Pick<UpstreamServer, 'name' | 'version' | 'title'> = {};
  for (const k of ['name', 'version', 'title'] as const) if (typeof i[k] === 'string' && i[k]) out[k] = i[k] as string;
  return out;
}
