/**
 * THE GOVERNING PROXY — `ViaGuard` in front of MCP servers you did not write.
 *
 * `startViaMcpServer` governs tools that live in the same process. This is its sibling for the
 * other case: an agent that uses someone else's MCP servers (Slack's, Gmail's, a payments API).
 * The agent connects to the proxy; the proxy connects to the servers; every `tools/call` passes
 * the same guard an embedded agent runs — challenge, a proof over THIS call signed with the
 * proxy's own key, `via_verify` on Humanos — and only an allow reaches the server. The servers'
 * credentials live here, not in the agent, so there is no path around the gate: this is where a
 * call is BLOCKED, not advised (plan §9 item 5, for agents we build).
 *
 * At start: the servers' tools are merged into one surface (a name two servers share is prefixed
 * with the service), declared to Humanos with the service and the servers' OWN annotations — so
 * the Tools tab fills itself with facts, not with what a model chose to say — and the mandates
 * this actor holds are fetched. Per call: the mandate is picked (the person's `allowed_tools`
 * naming the tool, else a pinned action declaring every parameter the tool takes, else a plain
 * authorization), a guard per mandate verifies, the outcome is reported. A call that needs the
 * person's co-sign returns the approve link at once — an MCP tool call must not hang for minutes —
 * and the retry with the same arguments presents that approval by its id.
 */
import { ViaDeniedError, ViaGuard } from '../guard.js';
import type { ViaAgentKey } from '../key-provider.js';
import { unwrapUserParamValues } from '../sdk.js';
import type { StepUpRef } from '../types.js';
import type { ViaMcpClient } from './client.js';
import { McpGuardVerifier, getMandates } from './guard-verifier.js';
import { defaultPlainReason, type JsonRpcMessage } from './server.js';
import type { Upstream, UpstreamResult, UpstreamTool } from './upstream.js';

type Held = Awaited<ReturnType<typeof getMandates>>[number];

/** One tool of the merged surface. */
export interface ProxiedTool {
  /** The name the agent sees — the upstream's, prefixed with the service only where two servers share it. */
  exposedName: string;
  /** The upstream's own name — the one rules and mandates speak of. */
  upstreamName: string;
  service: string;
  upstream: Upstream;
  definition: UpstreamTool;
}

export interface ViaMcpProxyConfig {
  upstreams: Upstream[];
  /** The Humanos connector, on the organization's key (`createViaMcpClient`). */
  humanos: ViaMcpClient;
  /** The proxy's own key — it is the agent actor — and the DID it registered under. */
  agentKey: ViaAgentKey;
  did: string;
  /** Declare the merged surface to Humanos at start (default true). */
  declare?: boolean;
  /** `observe` records denials and runs the tool anyway (the adoption ramp); default `enforce`. */
  mode?: 'observe' | 'enforce';
  /** Override which held mandate a call runs under. */
  mandateFor?: (tool: ProxiedTool, held: Held[]) => Held | undefined;
  /**
   * Wait for the person's co-sign in place (a test, or a host that renders MCP elicitation).
   * Without it a step-up returns the approve link to the agent and the retry carries the approval.
   */
  onStepUp?: (info: { tool: string; params: Record<string, unknown>; stepUp?: StepUpRef }) => Promise<boolean>;
  plainReason?: (reason?: string) => string;
  serverInfo?: { name: string; version: string };
  instructions?: string;
  /** How stale the mandate list may be before a call with no match re-fetches it (default 5 s). */
  mandateRefreshMs?: number;
}

export interface ViaMcpProxy {
  did: string;
  tools: ProxiedTool[];
  handleRpc: (msg: JsonRpcMessage) => Promise<JsonRpcMessage | null>;
  /** What was declared to Humanos at start, per service. */
  declared: { services: string[]; tools: number } | null;
  refreshMandates(): Promise<Held[]>;
  close(): Promise<void>;
}

/** Raised inside the guard when a step-up is open and nobody waits for it in place. */
export class ViaStepUpPendingError extends Error {
  constructor(readonly stepUp: StepUpRef | undefined) {
    super('step-up pending: the person has not approved this call yet');
    this.name = 'ViaStepUpPendingError';
  }
}

class UpstreamToolError extends Error {
  constructor(readonly result: UpstreamResult) {
    super(textOf(result) || 'the upstream tool reported an error');
    this.name = 'UpstreamToolError';
  }
}

const textOf = (r: UpstreamResult): string => r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
const slug = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));
const text = (t: string, isError = false): Record<string, unknown> => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/** JSON Schema → the flat parameter shape Humanos declares: type, description, required, and a list's element type. */
export function declaredParams(schema: Record<string, unknown> | undefined): Record<string, { type: string; description?: string; required?: boolean; items?: string }> {
  const props = ((schema ?? {}).properties ?? {}) as Record<string, { type?: unknown; description?: unknown; items?: { type?: unknown } }>;
  const required = new Set(Array.isArray((schema ?? {}).required) ? ((schema as { required: string[] }).required) : []);
  const out: Record<string, { type: string; description?: string; required?: boolean; items?: string }> = {};
  for (const [name, p] of Object.entries(props)) {
    // JSON Schema allows ["string", "null"]; the platform wants one word.
    const type = Array.isArray(p.type) ? String((p.type as unknown[]).find((x) => x !== 'null') ?? 'string') : typeof p.type === 'string' ? p.type : 'string';
    out[name] = {
      type: type.slice(0, 40),
      ...(typeof p.description === 'string' && p.description.trim() ? { description: p.description.trim().slice(0, 500) } : {}),
      ...(required.has(name) ? { required: true } : {}),
      ...(type === 'array' && typeof p.items?.type === 'string' ? { items: p.items.type.slice(0, 40) } : {}),
    };
  }
  return out;
}

/**
 * Which held mandate a call runs under. Exact first — the person's `allowed_tools` names the tool
 * (the "which tools" preset makes every service mandate exact) — then a pinned action that
 * declares every parameter the tool takes, then a plain authorization. A mandate whose
 * `allowed_tools` leaves the tool out never matches: the person already said no.
 */
export function pickMandate(tool: ProxiedTool, held: Held[]): Held | undefined {
  const params = Object.keys(((tool.definition.inputSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {});
  const rank = (h: Held): number => {
    const up = unwrapUserParamValues(h.mandate.credentialSubject.mandate.userParams as never);
    if (Array.isArray(up.allowed_tools)) return (up.allowed_tools as unknown[]).includes(tool.upstreamName) ? 3 : 0;
    if (!h.action) return 1;
    const declared = ((h.action.content ?? {}) as { executionParams?: Record<string, unknown> }).executionParams ?? {};
    // A tool with no parameters says nothing about which action is its: only an exact match or an authorization.
    return params.length > 0 && params.every((p) => p in declared) ? 2 : 0;
  };
  let best: Held | undefined;
  let bestRank = 0;
  for (const h of held) {
    const r = rank(h);
    if (r > bestRank) {
      best = h;
      bestRank = r;
    }
  }
  return best;
}

export async function startViaMcpProxy(cfg: ViaMcpProxyConfig): Promise<ViaMcpProxy> {
  const plainReason = cfg.plainReason ?? defaultPlainReason;
  const verifier = new McpGuardVerifier(cfg.humanos);
  const pick = cfg.mandateFor ?? pickMandate;

  // ── the merged surface ──
  const listed = await Promise.all(cfg.upstreams.map(async (u) => ({ u, tools: await u.listTools() })));
  const seen = new Map<string, number>();
  for (const { tools: ts } of listed) for (const t of ts) seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
  const tools: ProxiedTool[] = [];
  for (const { u, tools: ts } of listed) {
    for (const t of ts) {
      tools.push({ exposedName: (seen.get(t.name) ?? 0) > 1 ? `${slug(u.service)}__${t.name}` : t.name, upstreamName: t.name, service: u.service, upstream: u, definition: t });
    }
  }
  const byName = new Map(tools.map((t) => [t.exposedName, t]));
  const services = [...new Set(tools.map((t) => t.service))];

  // ── declare it: one call per service, so each replaces only its own list ──
  let declared: ViaMcpProxy['declared'] = null;
  if (cfg.declare !== false) {
    for (const service of services) {
      const ts = tools.filter((t) => t.service === service);
      if (ts.length > 200) process.stderr.write(`via-proxy: ${service} has ${ts.length} tools; the first 200 are declared\n`);
      const r = await cfg.humanos.callTool('via_declare_tools', {
        did: cfg.did,
        tools: ts.slice(0, 200).map((t) => ({
          name: t.upstreamName,
          ...(t.definition.description ? { description: t.definition.description.slice(0, 1000) } : {}),
          service,
          params: declaredParams(t.definition.inputSchema),
          ...(typeof t.definition.annotations?.readOnlyHint === 'boolean' ? { readOnlyHint: t.definition.annotations.readOnlyHint } : {}),
          ...(typeof t.definition.annotations?.destructiveHint === 'boolean' ? { destructiveHint: t.definition.annotations.destructiveHint } : {}),
        })),
      });
      if (r.isError) throw new Error(`via_declare_tools refused for ${service}: ${r.text}`);
    }
    declared = { services, tools: tools.length };
  }

  // ── the mandates this actor holds ──
  let held: Held[] = [];
  let fetchedAt = 0;
  const refreshMandates = async (): Promise<Held[]> => {
    held = await getMandates(cfg.humanos, cfg.did);
    fetchedAt = Date.now();
    return held;
  };
  await refreshMandates();

  // One guard per mandate; step-ups opened for exactly one call, keyed by mandate + tool + arguments.
  const guards = new Map<string, ViaGuard>();
  const pending = new Map<string, StepUpRef>();
  const termsKey = (mandateId: string, tool: string, args: Record<string, unknown>): string => `${mandateId}|${tool}|${stable(args)}`;
  const guardFor = (h: Held): ViaGuard => {
    let g = guards.get(h.mandate.id);
    if (!g) {
      g = new ViaGuard({
        mandate: h.mandate,
        agentKey: cfg.agentKey,
        verifier,
        compiled: h.compiled,
        mode: cfg.mode ?? 'enforce',
        onRechallenge: async (info) => {
          const { tool: _discriminator, ...args } = info.params;
          if (info.stepUp) pending.set(termsKey(h.mandate.id, info.tool, args), info.stepUp);
          if (cfg.onStepUp) return cfg.onStepUp(info);
          throw new ViaStepUpPendingError(info.stepUp);
        },
      });
      guards.set(h.mandate.id, g);
    }
    return g;
  };

  const callTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = byName.get(name);
    if (!tool) return text(`Unknown tool ${name}.`, true);
    let h = pick(tool, held);
    if (!h && Date.now() - fetchedAt > (cfg.mandateRefreshMs ?? 5_000)) h = pick(tool, await refreshMandates()); // a person may have just accepted one
    if (!h) {
      return text(
        `No mandate covers ${tool.upstreamName} (${tool.service}). Nothing was sent to ${tool.service}. ` +
          `A mandate comes from a person: the organization publishes a policy for ${tool.service} and the person accepts one under it.`,
        true,
      );
    }
    const key = termsKey(h.mandate.id, tool.upstreamName, args);
    const approval = pending.get(key);
    try {
      const out = await guardFor(h).call<UpstreamResult>(
        tool.upstreamName,
        args,
        async (a) => {
          const r = await tool.upstream.callTool(tool.upstreamName, a);
          if (r.isError) throw new UpstreamToolError(r); // reported as ACTION_FAILED, then surfaced as the server said it
          return r;
        },
        approval ? { stepUpId: approval.id } : {},
      );
      pending.delete(key);
      const r = out.result;
      if (!r) return text('', false);
      return { content: r.content, ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}) };
    } catch (e) {
      if (e instanceof ViaStepUpPendingError) {
        const link = e.stepUp?.approveLink;
        return text(
          `This call needs the person's approval before it reaches ${tool.service}${link ? `: ${link}` : ''}${e.stepUp?.expiresAt ? ` (until ${e.stepUp.expiresAt})` : ''}. ` +
            `Show them the link; once they have approved, call ${tool.exposedName} again with exactly the same arguments.`,
          true,
        );
      }
      pending.delete(key);
      if (e instanceof ViaDeniedError) return text(`Blocked by VIA: ${plainReason(e.reason)}. Nothing was sent to ${tool.service}. Do not retry.`, true);
      if (e instanceof UpstreamToolError) return { content: e.result.content, isError: true };
      return text(`Error: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  };

  const instructions =
    cfg.instructions ??
    `Tools from ${services.join(', ')}, governed by VIA: every call is verified against a mandate a person granted before it reaches the service. ` +
      'A blocked call says why — do not retry it. A call that needs the person\'s approval returns a link: show it to them, and once they have approved call the same tool again with the same arguments.';

  const handleRpc = async (msg: JsonRpcMessage): Promise<JsonRpcMessage | null> => {
    const { id, method, params } = msg;
    const reply = (result: unknown): JsonRpcMessage => ({ jsonrpc: '2.0', id: id ?? null, result });
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: (params?.protocolVersion as string) ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: cfg.serverInfo ?? { name: 'via-proxy', version: '0.1.0' },
          instructions,
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({
          tools: tools.map((t) => ({
            name: t.exposedName,
            ...(t.definition.description ? { description: t.definition.description } : {}),
            inputSchema: t.definition.inputSchema,
            ...(t.definition.annotations ? { annotations: t.definition.annotations } : {}),
          })),
        });
      case 'resources/list':
        return reply({ resources: [] });
      case 'prompts/list':
        return reply({ prompts: [] });
      case 'tools/call':
        return reply(await callTool(String(params?.name ?? ''), (params?.arguments as Record<string, unknown>) ?? {}));
      default:
        return id === undefined || id === null ? null : { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } };
    }
  };

  return {
    did: cfg.did,
    tools,
    handleRpc,
    declared,
    refreshMandates,
    close: async () => {
      await Promise.all(cfg.upstreams.map((u) => u.close()));
    },
  };
}
