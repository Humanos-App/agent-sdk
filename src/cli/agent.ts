/**
 * `humanos register`, `declare` and `status`: the agent's identity, the tools it can reach, and what the
 * organization's policy lets it do with each.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { declareTools, type DeclaredTool, type ServiceDeclaration } from '../mcp/declare.js';
import { getPolicy } from '../mcp/guard-verifier.js';
import { registerAgent } from '../mcp/register.js';
import { connectUpstream, type McpServerSpec } from '../mcp/upstream.js';
import { agentDir, environment, via, type Via } from '../via.js';
import { flag, parseFlags, type CliContext } from './context.js';

const agentOf = (ctx: CliContext): Promise<Via> => via({ cwd: ctx.cwd, ...ctx.via });

/** Registers the agent's key (minting it on the first run) and says who the agent is. The same key always answers the same DID. */
export async function registerCommand(_argv: string[], ctx: CliContext): Promise<Via> {
  const v = await agentOf(ctx);
  // A key with no DID yet was registered by `via()` itself, just now; one with a DID is asked again for its grade.
  const r = v.registration ?? (await registerAgent(v.client, v.key));
  const env = ctx.via?.env ?? environment(ctx.cwd);
  ctx.out(`Agent ${!v.registration && r.existing ? 'already registered' : 'registered'}: ${r.did}`);
  ctx.out(`  key: ${env.HUMANOS_AGENT_KEY ? 'HUMANOS_AGENT_KEY' : join(agentDir(env, ctx.cwd, ctx.via?.dir), 'agent-key.json')} (keep it: a new key is a new agent)`);
  // The grade only when it is not what the key claimed: a software key the agent holds is the usual case, and says nothing new.
  if (r.degradedFrom) ctx.out(`  Humanos could not confirm the key's claimed ${r.degradedFrom} assurance, and registered it as ${r.granted.assurance} (${r.granted.binding}).`);
  return v;
}

/** An MCP config file's servers (`mcpServers`, VS Code's `servers`, or the map itself), as specs; in-process ones left out. */
export function serversIn(file: string): McpServerSpec[] {
  const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const map = (json.mcpServers ?? json.servers ?? json) as Record<string, Record<string, unknown>>;
  return Object.entries(map)
    .filter(([, e]) => e && typeof e === 'object' && (typeof e.command === 'string' || typeof e.url === 'string'))
    .map(([service, e]) => ({
      service,
      ...(typeof e.command === 'string' ? { command: e.command, args: (e.args as string[]) ?? [], ...(e.env ? { env: e.env as Record<string, string> } : {}) } : {}),
      ...(typeof e.url === 'string' ? { url: e.url, ...(e.headers ? { headers: e.headers as Record<string, string> } : {}) } : {}),
    }));
}

/** Each server's tools, listed by starting (or reaching) it, as Humanos is told of them. A server that cannot be reached is a warning. */
async function listServers(specs: McpServerSpec[], ctx: CliContext): Promise<DeclaredTool[]> {
  const tools: DeclaredTool[] = [];
  for (const spec of specs) {
    try {
      const upstream = await connectUpstream(spec);
      try {
        for (const t of await upstream.listTools()) tools.push({ ...t, service: spec.service, ...(upstream.server ? { server: upstream.server } : {}) });
      } finally {
        await upstream.close();
      }
    } catch (e) {
      ctx.err(`  ${spec.service}: not listed (${e instanceof Error ? e.message : String(e)}); a server that needs a sign-in is declared when the agent first uses it`);
    }
  }
  return tools;
}

/**
 * `declare [--mcp <file>] [--entry <module> --framework ai-sdk|langchain --service <name> [--export <name>]]`: the
 * tools of the MCP servers in a config file (default `.mcp.json`), and of a module that exports a framework's tools.
 */
export async function declareCommand(argv: string[], ctx: CliContext, given?: Via): Promise<ServiceDeclaration[]> {
  const { flags } = parseFlags(argv);
  const mcp = flag(flags, 'mcp') ?? (existsSync(join(ctx.cwd, '.mcp.json')) ? '.mcp.json' : undefined);
  const entry = flag(flags, 'entry');
  if (!mcp && !entry) {
    ctx.out('Nothing to declare: no .mcp.json here, and no --mcp <file> or --entry <module>. The adapters declare the agent’s tools when it starts.');
    return [];
  }
  const v = given ?? (await agentOf(ctx));
  const tools: DeclaredTool[] = mcp ? await listServers(serversIn(resolve(ctx.cwd, mcp)), ctx) : [];
  if (entry) tools.push(...(await toolsOfModule(v, resolve(ctx.cwd, entry), flags)));
  if (!tools.length) {
    ctx.out('No tools found to declare.');
    return [];
  }
  const declared = await declareTools(v.client, v.did, tools, { onWarning: (m) => ctx.err(`  ${m}`) });
  for (const d of declared) ctx.out(`Declared ${d.recorded} tool(s) of ${d.service}${d.absent ? `; ${d.absent} no longer declared` : ''}`);
  return declared;
}

async function toolsOfModule(v: Via, file: string, flags: Record<string, string | true>): Promise<DeclaredTool[]> {
  const framework = flag(flags, 'framework');
  const service = flag(flags, 'service');
  if (!service || (framework !== 'ai-sdk' && framework !== 'langchain')) throw new Error('--entry needs --framework ai-sdk|langchain and --service <name>');
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const value = mod[flag(flags, 'export') ?? 'tools'] ?? mod.default;
  if (!value) throw new Error(`${file} exports no \`${flag(flags, 'export') ?? 'tools'}\` (or default)`);
  if (framework === 'ai-sdk') return (await (await import('../adapters/ai-sdk.js')).aiSdk(v)).describe(value as never, service);
  const tools = Array.isArray(value) ? value : Object.values(value as object);
  return (await (await import('../adapters/langchain.js')).langchain(v)).describe(tools as never, service);
}

/** Who the agent is, and each declared tool's access under the organization's policy. */
export async function statusCommand(_argv: string[], ctx: CliContext): Promise<void> {
  const v = await agentOf(ctx);
  ctx.out(`Agent: ${v.did}`);
  const policy = await getPolicy(v.client, v.did);
  if (!policy.tools.length) ctx.out('No tools declared yet: they appear once the agent declares them or first calls them.');
  for (const t of policy.tools) ctx.out(`  ${t.tool.padEnd(28)} ${(t.service ?? '').padEnd(20)} ${t.access}`);
  ctx.out('Set each tool’s access in the dashboard: https://app.humanos.tech, Agents, then Policy.');
}
