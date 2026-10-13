/**
 * DECLARING TOOLS — telling Humanos which tools an agent can call, so the organization sees each
 * one and can put a guardrail on it. Provenance only: a declaration never decides a call, the
 * mandate does.
 *
 * Each tool goes as its server describes it: the name, title, description, input and output
 * schemas and annotations verbatim, with the service it belongs to, the name the agent calls it by
 * when that differs, and the server it comes from. Nothing is cut here: the platform caps long
 * text itself, the same way for every agent, and says what it cut. Capping twice, two ways, would
 * store one tool as two.
 *
 * One `declare_tools` call per service, because declaring a service REPLACES its list: a tool the
 * call leaves out is kept on the platform and marked no longer declared. Two calls for one service
 * would mark the first call's tools absent.
 */
import type { ViaMcpClient } from './client.js';
import type { UpstreamServer, UpstreamTool } from './upstream.js';

/** The most tools one `declare_tools` call takes: the platform refuses a larger call outright. */
export const DECLARE_TOOLS_MAX = 500;

/** A tool as `declare_tools` takes it: the MCP tool verbatim, and where it comes from. */
export interface DeclaredTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: UpstreamTool['annotations'];
  /** The service it belongs to, as the organization will see it grouped: "Slack", "Gmail". */
  service: string;
  /** The name the agent calls it by, when that is not `name` (the proxy prefixes a name two servers share). */
  calledAs?: string;
  server?: UpstreamServer;
}

/** What the platform said about one service's declaration. */
export interface ServiceDeclaration {
  service: string;
  /** Tools recorded. */
  recorded: number;
  /** Tools declared before that this declaration left out: kept, marked no longer declared. */
  absent: number;
  /** Tools recorded with text over a size limit, cut to fit. */
  capped: number;
  /** Tools left out, and why: `agent_tool_limit` when the agent already has as many as it may. */
  skipped: { index: number; name: string | null; reason: string }[];
  /** Tools past `DECLARE_TOOLS_MAX`, never sent. */
  overLimit: number;
}

export interface DeclareToolsOptions {
  /** Services to declare with no tools: every tool the platform has for them is marked no longer declared. */
  emptyServices?: string[];
  /** Where warnings go: a service over the limit, tools left out or cut. Default: stderr. */
  onWarning?: (message: string) => void;
}

/**
 * Declare an agent's tools, one call per service (each `emptyServices` entry included), in order.
 * Throws when the platform refuses a call; a tool it leaves out or cuts is a warning, and the rest
 * of the declaration stands.
 */
export async function declareTools(humanos: ViaMcpClient, did: string, tools: DeclaredTool[], options: DeclareToolsOptions = {}): Promise<ServiceDeclaration[]> {
  const warn = options.onWarning ?? ((m: string) => void process.stderr.write(`via: ${m}\n`));
  const byService = new Map<string, DeclaredTool[]>();
  for (const t of tools) byService.set(t.service, [...(byService.get(t.service) ?? []), t]);
  for (const service of options.emptyServices ?? []) if (!byService.has(service)) byService.set(service, []);

  const declarations: ServiceDeclaration[] = [];
  // One service at a time, not in parallel: the agent's tool limit counts across services, and
  // concurrent declarations for one agent would race for it on the platform.
  for (const [service, all] of byService) {
    const sent = all.slice(0, DECLARE_TOOLS_MAX);
    if (all.length > sent.length) warn(`${service} has ${all.length} tools; the first ${DECLARE_TOOLS_MAX} are declared, the rest are not`);
    // Naming the service scopes the replacement to it, and lets a service with no tools left say so.
    const r = await humanos.callTool('declare_tools', { did, tools: sent.map(wireTool), services: [service] });
    if (r.isError) throw new Error(`declare_tools refused for ${service}: ${r.text}`);
    const d = resultOf(service, r.text, all.length - sent.length);
    for (const message of warningsFor(d)) warn(message);
    declarations.push(d);
  }
  return declarations;
}

/** A tool on the wire: its own fields as given, and only the ones it has. */
function wireTool(t: DeclaredTool): Record<string, unknown> {
  const { name, title, description, inputSchema, outputSchema, annotations, service, calledAs, server } = t;
  return Object.fromEntries(Object.entries({ name, title, description, inputSchema, outputSchema, annotations, service, calledAs, server }).filter(([, v]) => v !== undefined));
}

/** The platform's answer, read leniently: a count it does not give is 0. */
function resultOf(service: string, text: string, overLimit: number): ServiceDeclaration {
  let r: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') r = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: the platform recorded the tools and said so in words. Nothing more to read.
  }
  const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const skipped = Array.isArray(r.skipped)
    ? r.skipped.map((x) => {
        const s = (x ?? {}) as Record<string, unknown>;
        return { index: count(s.index), name: typeof s.name === 'string' ? s.name : null, reason: String(s.reason ?? 'unknown') };
      })
    : [];
  return { service, recorded: count(r.recorded), absent: count(r.absent), capped: count(r.capped), skipped, overLimit };
}

function warningsFor(d: ServiceDeclaration): string[] {
  const out: string[] = [];
  const names = (list: ServiceDeclaration['skipped']): string => list.map((s) => s.name ?? `#${s.index}`).join(', ');
  const atLimit = d.skipped.filter((s) => s.reason === 'agent_tool_limit');
  const malformed = d.skipped.filter((s) => s.reason !== 'agent_tool_limit');
  if (atLimit.length) out.push(`the agent is at its tool limit: ${atLimit.length} tool(s) of ${d.service} were not declared (${names(atLimit)})`);
  if (malformed.length) out.push(`${malformed.length} tool(s) of ${d.service} were left out: ${malformed.map((s) => `${s.name ?? `#${s.index}`} (${s.reason})`).join(', ')}`);
  if (d.capped) out.push(`${d.capped} tool(s) of ${d.service} had text over a size limit: recorded, cut to fit`);
  return out;
}
