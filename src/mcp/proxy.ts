/**
 * THE GOVERNING PROXY — `ViaGuard` in front of MCP servers you did not write.
 *
 * `startViaMcpServer` governs tools that live in the same process. This is its sibling for the
 * other case: an agent that uses someone else's MCP servers (Slack's, Gmail's, a payments API).
 * The agent connects to the proxy; the proxy connects to the servers; every `tools/call` passes
 * the same guard an embedded agent runs — challenge, a proof over THIS call signed with the
 * proxy's own key, `verify` on Humanos — and only an allow reaches the server. The servers'
 * credentials live here, not in the agent, so there is no path around the gate: this is where a
 * call is BLOCKED, not advised (plan §9 item 5, for agents we build).
 *
 * At start: the servers' tools are merged into one surface (a name two servers share is prefixed
 * with the service), declared to Humanos as the servers describe them, verbatim (`declareTools`) —
 * so the Tools tab fills itself with facts, not with what a model chose to say — and the mandates
 * this actor holds are fetched. The surface can change while the proxy runs: `refresh`,
 * `addUpstream` and `removeUpstream`, and a local server that says its tools changed. Each change
 * declares again only the services whose declaration changed, and tells the agent (`notify`) when
 * the tools it sees changed. Per call: the mandate is picked (the person's `allowed_tools`
 * naming the tool, else a pinned action declaring every parameter the tool takes, else a plain
 * authorization), a guard per mandate verifies, the outcome is reported. A call that needs the
 * person's co-sign returns the approve link at once — an MCP tool call must not hang for minutes —
 * and the retry with the same arguments presents that approval by its id.
 */
import { ViaDeniedError, ViaGuard } from '../guard.js';
import type { ViaAgentKey } from '../key-provider.js';
import { unwrapUserParamValues } from '../sdk.js';
import type { StepUpRef, VerifyOutcome } from '../types.js';
import type { ViaMcpClient } from './client.js';
import { declareTools, type DeclaredTool, type ServiceDeclaration } from './declare.js';
import { McpGuardVerifier, getMandates } from './guard-verifier.js';
import { defaultPlainReason, type JsonRpcMessage } from './server.js';
import { connectUpstream, TOOLS_CHANGED, type Upstream, type UpstreamCallExtra, type UpstreamResult, type UpstreamSpec, type UpstreamTool } from './upstream.js';

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
  /** Declare the merged surface to Humanos at start, and again whenever it changes (default true). */
  declare?: boolean;
  /**
   * How the proxy tells its agent that the tools it sees changed (`notifications/tools/list_changed`):
   * the stdio transport's `notify`. Without it the proxy tells the agent its list never changes.
   */
  notify?: (msg: JsonRpcMessage) => void;
  /** Where a declaration's warnings go: a service over the limit, tools left out or cut. Default: stderr. */
  onWarning?: (message: string) => void;
  /** `observe` records denials and runs the tool anyway (the adoption ramp); default `enforce`. */
  mode?: 'observe' | 'enforce';
  /** Override which held mandate a call runs under. */
  mandateFor?: (tool: ProxiedTool, held: Held[]) => Held | undefined;
  /**
   * Wait for the person's co-sign in place (a test, or a host that renders MCP elicitation).
   * Without it a step-up returns the approve link to the agent and the retry carries the approval.
   */
  onStepUp?: (info: { tool: string; params: Record<string, unknown>; stepUp?: StepUpRef }) => Promise<boolean>;
  /**
   * What to add to the upstream call now that a decision exists — `_meta`, and headers over HTTP.
   * The seam for carrying the verifier's decision to the server that executes the call; what goes
   * there is the caller's, the proxy defines none of it. Runs only for a call about to reach the
   * upstream, so `outcome.decision` is `allow`, or `deny` under `observe`.
   */
  decorateCall?: (ctx: {
    tool: ProxiedTool;
    args: Record<string, unknown>;
    mandateId: string;
    outcome: VerifyOutcome;
  }) => UpstreamCallExtra | undefined | Promise<UpstreamCallExtra | undefined>;
  plainReason?: (reason?: string) => string;
  serverInfo?: { name: string; version: string };
  instructions?: string;
  /** How stale the mandate list may be before a call with no match re-fetches it (default 5 s). */
  mandateRefreshMs?: number;
}

export interface ViaMcpProxy {
  did: string;
  /** The merged surface, as it is now. */
  readonly tools: ProxiedTool[];
  handleRpc: (msg: JsonRpcMessage) => Promise<JsonRpcMessage | null>;
  /** What is declared to Humanos now; null with `declare: false`. */
  readonly declared: { services: string[]; tools: number } | null;
  /**
   * List the servers' tools again (one service's, or all of them) and declare each service whose
   * declaration changed. A local server that says its tools changed does this by itself; a remote
   * one's changes arrive only through this.
   */
  refresh(service?: string): Promise<ServiceDeclaration[]>;
  /** Put another server behind the proxy (connected, or by command or URL), and declare its tools. */
  addUpstream(upstream: Upstream | UpstreamSpec): Promise<ServiceDeclaration[]>;
  /** Take a service's servers away: closed, and the service declared with no tools, so Humanos marks them absent. */
  removeUpstream(service: string): Promise<ServiceDeclaration[]>;
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

/**
 * JSON Schema → the flat parameter shape agent-sdk 0.1 declared: type, description, required, and a
 * list's element type.
 *
 * @deprecated The proxy declares each tool's schema verbatim now (`declareTools`); Humanos still
 * accepts this shape.
 */
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
  const warn = cfg.onWarning ?? ((m: string) => void process.stderr.write(`via-proxy: ${m}\n`));

  // ── the merged surface: every server's tools, as last listed ──
  const upstreams: Upstream[] = [...cfg.upstreams];
  const listed = new Map<Upstream, UpstreamTool[]>();
  let tools: ProxiedTool[] = [];
  let byName = new Map<string, ProxiedTool>();
  const merge = (): void => {
    const seen = new Map<string, number>();
    for (const ts of listed.values()) for (const t of ts) seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
    tools = upstreams.flatMap((u) =>
      (listed.get(u) ?? []).map((t) => ({ exposedName: (seen.get(t.name) ?? 0) > 1 ? `${slug(u.service)}__${t.name}` : t.name, upstreamName: t.name, service: u.service, upstream: u, definition: t })),
    );
    byName = new Map(tools.map((t) => [t.exposedName, t]));
  };

  // ── declared: per service, what Humanos was last told, so a change re-declares only what changed ──
  const declaredAs = new Map<string, string>();
  const declarationOf = (service: string): DeclaredTool[] =>
    tools
      .filter((t) => t.service === service)
      .map((t) => ({
        name: t.upstreamName,
        title: t.definition.title,
        description: t.definition.description,
        inputSchema: t.definition.inputSchema,
        outputSchema: t.definition.outputSchema,
        annotations: t.definition.annotations,
        service,
        ...(t.exposedName !== t.upstreamName ? { calledAs: t.exposedName } : {}),
        ...(t.upstream.server ? { server: t.upstream.server } : {}),
      }));
  const declareChanged = async (): Promise<ServiceDeclaration[]> => {
    if (cfg.declare === false) return [];
    const services = [...new Set(tools.map((t) => t.service))];
    const out: ServiceDeclaration[] = [];
    // Service by service, each remembered once it is declared: if one is refused, the ones before
    // it stand and the rest are declared on the next change.
    for (const service of services) {
      const declaration = declarationOf(service);
      if (declaredAs.get(service) === stable(declaration)) continue;
      out.push(...(await declareTools(cfg.humanos, cfg.did, declaration, { onWarning: warn })));
      declaredAs.set(service, stable(declaration));
    }
    // A service with no tools left (its servers removed, or listing none) says so: Humanos marks them absent.
    for (const service of [...declaredAs.keys()].filter((s) => !services.includes(s))) {
      out.push(...(await declareTools(cfg.humanos, cfg.did, [], { emptyServices: [service], onWarning: warn })));
      declaredAs.delete(service);
    }
    return out;
  };

  const listEntry = (t: ProxiedTool): Record<string, unknown> => ({
    name: t.exposedName,
    ...(t.definition.title ? { title: t.definition.title } : {}),
    ...(t.definition.description ? { description: t.definition.description } : {}),
    inputSchema: t.definition.inputSchema,
    ...(t.definition.outputSchema ? { outputSchema: t.definition.outputSchema } : {}),
    ...(t.definition.annotations ? { annotations: t.definition.annotations } : {}),
  });

  // ── changes to the surface: one at a time, in order, so two never interleave their declarations ──
  let queue: Promise<unknown> = Promise.resolve();
  const change = (work: () => Promise<void>): Promise<ServiceDeclaration[]> => {
    const run = queue.then(async () => {
      const before = stable(tools.map(listEntry));
      await work();
      merge();
      // The agent hears first: the new tools are callable (and guarded) even if declaring them fails.
      if (cfg.notify && stable(tools.map(listEntry)) !== before) cfg.notify({ jsonrpc: '2.0', method: TOOLS_CHANGED });
      return declareChanged();
    });
    queue = run.catch(() => undefined);
    return run;
  };

  const refreshing = new Set<string>();
  const unwatch = new Map<Upstream, () => void>();
  const refresh = (service?: string): Promise<ServiceDeclaration[]> =>
    change(async () => {
      if (service === undefined) refreshing.clear();
      else refreshing.delete(service);
      const targets = upstreams.filter((u) => service === undefined || u.service === service);
      const lists = await Promise.all(targets.map((u) => u.listTools()));
      targets.forEach((u, i) => listed.set(u, lists[i]!));
    });
  const watch = (u: Upstream): void => {
    const off = u.onToolsChanged?.(() => {
      // A burst of notifications is one refresh: a service already waiting for one is not queued again.
      if (refreshing.has(u.service)) return;
      refreshing.add(u.service);
      refresh(u.service).catch((e) => warn(`${u.service} changed its tools, and declaring them failed: ${e instanceof Error ? e.message : String(e)}`));
    });
    if (off) unwatch.set(u, off);
  };

  const addUpstream = (given: Upstream | UpstreamSpec): Promise<ServiceDeclaration[]> =>
    change(async () => {
      const connected = typeof (given as Upstream).listTools !== 'function';
      const u = connected ? await connectUpstream(given as UpstreamSpec) : (given as Upstream);
      try {
        listed.set(u, await u.listTools());
      } catch (e) {
        if (connected) await u.close();
        throw e;
      }
      upstreams.push(u);
      watch(u);
    });

  const removeUpstream = (service: string): Promise<ServiceDeclaration[]> =>
    change(async () => {
      const leaving = upstreams.filter((u) => u.service === service);
      for (const u of leaving) {
        unwatch.get(u)?.();
        unwatch.delete(u);
        listed.delete(u);
        upstreams.splice(upstreams.indexOf(u), 1);
      }
      await Promise.all(leaving.map((u) => u.close()));
    });

  // ── at start: list, merge, declare (a refusal here stops the start), then listen for changes ──
  const initial = await Promise.all(upstreams.map((u) => u.listTools()));
  upstreams.forEach((u, i) => listed.set(u, initial[i]!));
  merge();
  const services = [...new Set(tools.map((t) => t.service))];
  await declareChanged();
  upstreams.forEach(watch);

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
        async (a, ctx) => {
          const extra = cfg.decorateCall ? await cfg.decorateCall({ tool, args: a, mandateId: h.mandate.id, outcome: ctx.outcome }) : undefined;
          const r = await tool.upstream.callTool(tool.upstreamName, a, extra);
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
          capabilities: { tools: { listChanged: cfg.notify !== undefined } },
          serverInfo: cfg.serverInfo ?? { name: 'via-proxy', version: '0.1.0' },
          instructions,
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: tools.map(listEntry) });
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
    get tools() {
      return tools;
    },
    handleRpc,
    get declared() {
      if (cfg.declare === false) return null;
      return { services: [...declaredAs.keys()], tools: tools.filter((t) => declaredAs.has(t.service)).length };
    },
    refresh,
    addUpstream,
    removeUpstream,
    refreshMandates,
    close: async () => {
      for (const off of unwatch.values()) off();
      unwatch.clear();
      await Promise.all(upstreams.map((u) => u.close()));
    },
  };
}
