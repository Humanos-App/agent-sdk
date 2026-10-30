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
 * the organization's policy and the mandates this actor holds are read. Declaring new tools is the
 * agent's to do: when its servers' tools change, it calls `refresh`, which lists them again and
 * declares only the services whose declaration changed. Per call, one guard for the agent: the
 * organization's policy decides first (v0.3 §21.3), and a held mandate is presented only for a
 * tool the policy leaves to a person's mandate (the person's `allowed_tools` or a pinned action's
 * `tools` naming the tool, else a pinned action declaring every parameter the tool takes, else a
 * plain authorization; one on the control the policy names first). The outcome is reported.
 */
import { ViaDeniedError, ViaGuard } from '../guard.js';
import type { ViaAgentKey } from '../key-provider.js';
import type { MandateRequestHint, VerifyOutcome } from '../types.js';
import type { ViaMcpClient } from './client.js';
import { declareTools, type DeclaredTool, type ServiceDeclaration } from './declare.js';
import { McpGuardVerifier, coveringMandate, policyMandates, type AgentPolicy, type GuardMandate } from './guard-verifier.js';
import { defaultPlainReason, type JsonRpcMessage } from './server.js';
import type { Upstream, UpstreamCallExtra, UpstreamResult, UpstreamTool } from './upstream.js';

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
  /** Declare the merged surface to Humanos at start, and on each `refresh` that changes it (default true). */
  declare?: boolean;
  /** Where a declaration's warnings go: a service over the limit, tools left out or cut. Default: stderr. */
  onWarning?: (message: string) => void;
  /** `observe` records denials and runs the tool anyway (the adoption ramp); default `enforce`. */
  mode?: 'observe' | 'enforce';
  /**
   * Override which held mandate a call presents, for a tool the organization's policy leaves to a person's mandate.
   * `preferred`: the action versions the policy names for it.
   */
  mandateFor?: (tool: ProxiedTool, held: GuardMandate[], preferred: string[]) => GuardMandate | undefined;
  /**
   * What to add to the upstream call now that a decision exists — `_meta`, and headers over HTTP.
   * The seam for carrying the verifier's decision to the server that executes the call; what goes
   * there is the caller's, the proxy defines none of it. Runs only for a call about to reach the
   * upstream, so `outcome.decision` is `allow`, or `deny` under `observe`.
   */
  decorateCall?: (ctx: {
    tool: ProxiedTool;
    args: Record<string, unknown>;
    /** The mandate the call presented; absent for one the organization's policy decided alone (v0.3 §21.3). */
    mandateId?: string;
    outcome: VerifyOutcome;
  }) => UpstreamCallExtra | undefined | Promise<UpstreamCallExtra | undefined>;
  plainReason?: (reason?: string) => string;
  serverInfo?: { name: string; version: string };
  instructions?: string;
}

export interface ViaMcpProxy {
  did: string;
  /** The merged surface, as it is now. */
  readonly tools: ProxiedTool[];
  handleRpc: (msg: JsonRpcMessage) => Promise<JsonRpcMessage | null>;
  /** What is declared to Humanos now; null with `declare: false`. */
  readonly declared: { services: string[]; tools: number } | null;
  /**
   * List the servers' tools again (one service's, or all of them), serve the new list, and declare
   * each service whose declaration changed. The agent calls it when it knows its tools changed.
   */
  refresh(service?: string): Promise<ServiceDeclaration[]>;
  /** Read the organization's policy and the held mandates again, for the calls after. */
  refreshMandates(): Promise<{ policy: AgentPolicy; held: GuardMandate[] }>;
  close(): Promise<void>;
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

/** The parameters a tool takes, from its schema. */
const paramsOf = (tool: ProxiedTool): string[] => Object.keys(((tool.definition.inputSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {});

/**
 * Which held mandate a call presents (`coveringMandate`): exact first — the person's `allowed_tools`, or the pinned
 * action's `tools` (v0.3 §0.6.1), names the tool — then a pinned action that lists no tools and declares every
 * parameter the tool takes, then a plain authorization; at each rank, one pinning a `preferred` action version first.
 */
export function pickMandate(tool: ProxiedTool, held: GuardMandate[], preferred: string[] = []): GuardMandate | undefined {
  return coveringMandate(tool.upstreamName, paramsOf(tool), held, preferred);
}

export async function startViaMcpProxy(cfg: ViaMcpProxyConfig): Promise<ViaMcpProxy> {
  const plainReason = cfg.plainReason ?? defaultPlainReason;
  const verifier = new McpGuardVerifier(cfg.humanos);
  const pick = cfg.mandateFor ?? pickMandate;
  const warn = cfg.onWarning ?? ((m: string) => void process.stderr.write(`via-proxy: ${m}\n`));

  // ── the merged surface: every server's tools, as last listed ──
  const upstreams = cfg.upstreams;
  const listed = new Map<Upstream, UpstreamTool[]>();
  let tools: ProxiedTool[] = [];
  let byName = new Map<string, ProxiedTool>();
  const list = async (targets: Upstream[]): Promise<void> => {
    const lists = await Promise.all(targets.map((u) => u.listTools()));
    targets.forEach((u, i) => listed.set(u, lists[i]!));
    const seen = new Map<string, number>();
    for (const ts of listed.values()) for (const t of ts) seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
    tools = upstreams.flatMap((u) =>
      (listed.get(u) ?? []).map((t) => ({ exposedName: (seen.get(t.name) ?? 0) > 1 ? `${slug(u.service)}__${t.name}` : t.name, upstreamName: t.name, service: u.service, upstream: u, definition: t })),
    );
    byName = new Map(tools.map((t) => [t.exposedName, t]));
  };

  // ── declared: per service, what Humanos was last told, so a refresh re-declares only what changed ──
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
    // it stand and the rest are declared on the next refresh.
    for (const service of services) {
      const declaration = declarationOf(service);
      if (declaredAs.get(service) === stable(declaration)) continue;
      out.push(...(await declareTools(cfg.humanos, cfg.did, declaration, { onWarning: warn })));
      declaredAs.set(service, stable(declaration));
    }
    // A service whose server lists no tools any more says so: Humanos marks them absent.
    for (const service of [...declaredAs.keys()].filter((s) => !services.includes(s))) {
      out.push(...(await declareTools(cfg.humanos, cfg.did, [], { emptyServices: [service], onWarning: warn })));
      declaredAs.delete(service);
    }
    return out;
  };

  // Refreshes run one at a time, in order, so two never interleave their declarations. The new list
  // is served before it is declared: the new tools are callable (and guarded) even if declaring fails.
  let queue: Promise<unknown> = Promise.resolve();
  const refresh = (service?: string): Promise<ServiceDeclaration[]> => {
    const run = queue.then(async () => {
      await list(upstreams.filter((u) => service === undefined || u.service === service));
      return declareChanged();
    });
    queue = run.catch(() => undefined);
    return run;
  };

  // ── at start: list, merge and declare (a refusal here stops the start) ──
  await list(upstreams);
  const services = [...new Set(tools.map((t) => t.service))];
  await declareChanged();

  // ── the policy and the mandates this actor holds, read once and again on a `mandate_required` ──
  const mandates = policyMandates(cfg.humanos, cfg.did, {
    // Rules and policies speak of the upstream's name: a name two services share picks by the first one's schema.
    pick: (call, held, preferred) => {
      const tool = tools.find((t) => t.upstreamName === call.tool);
      return tool ? pick(tool, held, preferred) : coveringMandate(call.tool, [], held, preferred);
    },
  });
  await mandates.read();
  const guard = new ViaGuard({ agentKey: cfg.agentKey, agentDid: cfg.did, verifier, mandates, mode: cfg.mode ?? 'enforce' });

  const noMandate = (tool: ProxiedTool, request?: MandateRequestHint, held?: boolean): string =>
    `${held ? 'The mandate this agent holds does not cover' : 'No mandate covers'} ${tool.upstreamName} (${tool.service}). ` +
    `Nothing was sent to ${tool.service}. ` +
    (request?.kind === 'guardrail'
      ? `The organization's policy needs a person's mandate under ${request.actionIds.join(' or ')} for it: ask the person for one (its limits: get_action).`
      : request?.kind === 'authorization'
        ? `The organization's policy needs a person's authorization for it, and names no control: ask the person to authorize this one call.`
        : `The organization's policy leaves it to a person's mandate: the person accepts one on a control made for ${tool.service}.`);

  const callTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = byName.get(name);
    if (!tool) return text(`Unknown tool ${name}.`, true);
    try {
      const out = await guard.call<UpstreamResult>(tool.upstreamName, args, async (a, ctx) => {
        const extra = cfg.decorateCall
          ? await cfg.decorateCall({ tool, args: a, ...(ctx.mandateId ? { mandateId: ctx.mandateId } : {}), outcome: ctx.outcome })
          : undefined;
        const r = await tool.upstream.callTool(tool.upstreamName, a, extra);
        if (r.isError) throw new UpstreamToolError(r); // reported as ACTION_FAILED, then surfaced as the server said it
        return r;
      });
      const r = out.result;
      if (!r) return text('', false);
      return { content: r.content, ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}) };
    } catch (e) {
      // The policy leaves the tool to a person's mandate, and none this agent holds fits: say which one it needs.
      if (e instanceof ViaDeniedError && e.reason === 'mandate_required') return text(noMandate(tool, e.request, !!e.mandateId), true);
      if (e instanceof ViaDeniedError) return text(`Blocked by VIA: ${plainReason(e.reason)}. Nothing was sent to ${tool.service}. Do not retry.`, true);
      if (e instanceof UpstreamToolError) return { content: e.result.content, isError: true };
      return text(`Error: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  };

  const instructions =
    cfg.instructions ??
    `Tools from ${services.join(', ')}, governed by VIA: every call is verified against the organization's policy, and a mandate a person granted where the policy asks for one, before it reaches the service. ` +
      'A blocked call says why — do not retry it.';

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
            ...(t.definition.title ? { title: t.definition.title } : {}),
            ...(t.definition.description ? { description: t.definition.description } : {}),
            inputSchema: t.definition.inputSchema,
            ...(t.definition.outputSchema ? { outputSchema: t.definition.outputSchema } : {}),
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
    get tools() {
      return tools;
    },
    handleRpc,
    get declared() {
      if (cfg.declare === false) return null;
      return { services: [...declaredAs.keys()], tools: tools.filter((t) => declaredAs.has(t.service)).length };
    },
    refresh,
    refreshMandates: () => mandates.read(),
    close: async () => {
      await Promise.all(upstreams.map((u) => u.close()));
    },
  };
}
