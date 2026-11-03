/**
 * THE CONNECTION WRAPPER — the governing proxy inside the agent's process, for frameworks that take an MCP
 * connection object (AI SDK's `createMCPClient({ transport })`, the MCP SDK `Client` that Google GenAI's
 * `mcpToTool` and Strands' `McpClient` take).
 *
 * It wraps the transport the developer would have passed and watches the JSON-RPC on it: a `tools/list` answer is
 * declared under the server's service as it comes back; a `tools/call` is checked before it is sent — refused, it
 * never leaves the process and the framework gets the refusal as the tool's result; allowed, it carries the call
 * proof in `_meta` and its outcome is reported when the server answers. Every other message passes through as it was.
 * The framework keeps its own connection, so a server it signed in to (OAuth) needs no second sign-in.
 *
 * A call checked here must not be checked again by a framework hook: `checks(service, tool)` says which tools a
 * wrapped connection serves, and a call made inside `runChecked` (a hook that has already checked it) passes
 * through unchecked.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ViaGuard, GuardCheck } from '../guard.js';
import type { DeclaredTool } from './declare.js';
import { callProofExtra } from './proxy.js';
import { audienceOf, refusalText } from './refusal.js';
import { defaultPlainReason, type JsonRpcMessage } from './server.js';
import type { ToolRegistry } from './tool-registry.js';
import type { McpServerSpec, UpstreamServer, UpstreamTool } from './upstream.js';

/**
 * What every MCP client transport has: AI SDK's `MCPTransport` and the MCP SDK's `Transport` alike. Each library types
 * its messages its own way (the MCP SDK's `send` also takes a batch), so the message is `any` here: the wrapper reads
 * it as JSON-RPC and passes anything else through.
 */
export interface McpTransportLike {
  start(): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(message: any, options?: any): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  close(...args: any[]): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage?(message: any, extra?: any): void;
  onerror?(error: Error): void;
  onclose?(): void;
}

export interface McpConnectionOptions {
  /** The server's `https` origin: the party each call's proof is for (v0.3 §16.16). A local server has none, and no proof. */
  origin?: string;
  /** The server behind the connection, recorded with each tool declared. */
  server?: UpstreamServer;
}

/** The MCP side of `via()`. */
export interface ViaMcp {
  /** `inner`, with each `tools/list` declared under `service` and each `tools/call` checked before it is sent. */
  transport<T extends McpTransportLike>(service: string, inner: T, options?: McpConnectionOptions): T;
  /** True when a wrapped connection checks this tool's calls: a framework hook leaves those to it. */
  checks(service: string, tool: string): boolean;
  /** A stdio server entry rewritten to run behind the governing proxy; a remote one as it is. */
  route(spec: McpServerSpec): McpServerSpec;
}

export interface ViaMcpDeps {
  guard: Pick<ViaGuard, 'check' | 'settle'>;
  tools: Pick<ToolRegistry, 'add'>;
  plainReason?: (reason?: string) => string;
  onWarning?: (message: string) => void;
}

const checkedHere = new AsyncLocalStorage<true>();

/**
 * Run `fn` as a call a framework hook has already checked: a wrapped connection it reaches sends it unchecked, so
 * the call is checked once.
 */
export function runChecked<T>(fn: () => T): T {
  return checkedHere.run(true, fn);
}

export function createViaMcp(deps: ViaMcpDeps): ViaMcp {
  const served = new Map<string, Set<string>>();
  return {
    transport: (service, inner, options = {}) =>
      governTransport(deps, service, inner, options, (name) => {
        const names = served.get(service) ?? new Set<string>();
        names.add(name);
        served.set(service, names);
      }),
    checks: (service, tool) => served.get(service)?.has(tool) ?? false,
    route: (spec) => routeStdio(spec),
  };
}

type Id = string | number;
const isMessage = (m: unknown): m is JsonRpcMessage => typeof m === 'object' && m !== null && !Array.isArray(m);
const isRequest = (m: unknown, method: string): m is JsonRpcMessage & { id: Id } => isMessage(m) && m.method === method && m.id !== undefined && m.id !== null;
const isResponse = (m: unknown): m is JsonRpcMessage & { id: Id } => isMessage(m) && m.method === undefined && m.id !== undefined && m.id !== null;

function governTransport<T extends McpTransportLike>(deps: ViaMcpDeps, service: string, inner: T, options: McpConnectionOptions, serve: (tool: string) => void): T {
  const plainReason = deps.plainReason ?? defaultPlainReason;
  const warn = deps.onWarning ?? ((m: string) => void process.stderr.write(`via: ${m}\n`));
  const listing = new Set<Id>();
  const calls = new Map<Id, GuardCheck>();
  let handler: McpTransportLike['onmessage'];

  const deliver = (message: unknown, extra?: unknown): void => handler?.call(inner, message, extra);

  const send = async (message: unknown, sendOptions?: unknown): Promise<void> => {
    if (isRequest(message, 'tools/list')) listing.add(message.id);
    if (!isRequest(message, 'tools/call') || checkedHere.getStore()) return inner.send(message, sendOptions);

    const name = String(message.params?.name ?? '');
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    const checked = await deps.guard.check(name, args, audienceOf(options.origin));
    if (!checked.proceed) {
      // Answered here, after `send` returns, as the server would have: the framework reads it as the tool's result.
      const result = { content: [{ type: 'text', text: refusalText({ name, service }, checked, plainReason) }], isError: true };
      queueMicrotask(() => deliver({ jsonrpc: '2.0', id: message.id, result }));
      return;
    }
    const meta = callProofExtra(checked.outcome)?.meta;
    const sent = meta ? { ...message, params: { ...message.params, _meta: { ...((message.params?._meta as object) ?? {}), ...meta } } } : message;
    calls.set(message.id, checked);
    try {
      await inner.send(sent, sendOptions);
    } catch (e) {
      calls.delete(message.id);
      await deps.guard.settle(checked, { error: e }).catch((r: unknown) => warn(`reporting ${name}'s outcome failed: ${String(r)}`));
      throw e;
    }
  };

  const receive = (message: unknown, extra?: unknown): void => {
    if (!isResponse(message)) return deliver(message, extra);
    if (listing.delete(message.id)) declare(message);
    const checked = calls.get(message.id);
    if (!checked) return deliver(message, extra);
    calls.delete(message.id);
    // The outcome is reported before the framework gets the result, as `ViaGuard.call` does.
    void deps.guard
      .settle(checked, failureOf(message))
      .catch((e: unknown) => warn(`reporting a call's outcome failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => deliver(message, extra));
  };

  const declare = (message: JsonRpcMessage): void => {
    const listed = ((message.result as { tools?: UpstreamTool[] } | undefined)?.tools ?? []).filter((t) => typeof t?.name === 'string');
    for (const t of listed) serve(t.name);
    const tools: DeclaredTool[] = listed.map((t) => ({
      name: t.name,
      ...(t.title ? { title: t.title } : {}),
      ...(t.description ? { description: t.description } : {}),
      ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
      ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
      ...(t.annotations ? { annotations: t.annotations } : {}),
      service,
      ...(options.server ? { server: options.server } : {}),
    }));
    if (tools.length) void deps.tools.add(tools).catch(() => {}); // the registry warns on its own
  };

  // A Proxy rather than a copy: every other member (`start`, `close`, `sessionId`, `setProtocolVersion`, flags a
  // library reads) stays the inner transport's own, called on it, so private fields and getters keep working.
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'send') return send;
      if (prop === 'onmessage') return handler;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
    set(target, prop, value) {
      if (prop !== 'onmessage') return Reflect.set(target, prop, value, target);
      handler = value as McpTransportLike['onmessage'];
      target.onmessage = handler ? receive : undefined;
      return true;
    },
  });
}

/** What became of a call, from the server's answer: an error response or an `isError` result is a failure. */
function failureOf(message: JsonRpcMessage): { error?: string } {
  if (message.error) return { error: (message.error as { message?: string }).message ?? 'the server answered with an error' };
  const result = message.result as { isError?: boolean; content?: { type: string; text?: string }[] } | undefined;
  if (!result?.isError) return {};
  const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
  return { error: text || 'the tool reported an error' };
}

/** The command a routed stdio entry runs: the governing proxy, from the project's own install. */
export const PROXY_COMMAND = { command: 'npx', args: ['--no-install', 'humanos-agent', 'proxy'] } as const;

/**
 * A stdio server entry, rewritten to run the governing proxy in front of it (`humanos-agent proxy --service <name>
 * -- <command> <args>`): every tool declared from the server's list, every call checked. A remote entry comes back
 * as it is, left to the framework's own check; an entry already routed, unchanged.
 */
export function routeStdio(spec: McpServerSpec, via: { command: string; args: readonly string[] } = PROXY_COMMAND): McpServerSpec {
  if (!spec.command) return spec;
  if (spec.command === via.command && via.args.every((a, i) => spec.args?.[i] === a)) return spec;
  return { ...spec, command: via.command, args: [...via.args, '--service', spec.service, '--', spec.command, ...(spec.args ?? [])] };
}
