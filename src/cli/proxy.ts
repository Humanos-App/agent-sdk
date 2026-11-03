/**
 * `humanos-agent proxy --service <name> -- <command> <args…>` — the governing proxy in front of one stdio MCP
 * server, as an entry `routeStdio` rewrote runs it. The host starts this in place of the server; the proxy starts the
 * server, declares its tools, and checks every call. The agent is the project's own (`via()`: its `.env` and key), so
 * the calls are the same agent's whether they go through a framework hook or this proxy.
 */
import { connectUpstream } from '../mcp/upstream.js';
import { startViaMcpProxy, type ViaMcpProxy } from '../mcp/proxy.js';
import { via, type ViaOptions } from '../via.js';

export interface ProxyArgs {
  service: string;
  command: string;
  args: string[];
}

/** `--service <name> -- <command> <args…>`; anything else is refused with what was expected. */
export function parseProxyArgs(argv: string[]): ProxyArgs {
  const dash = argv.indexOf('--');
  const own = dash === -1 ? argv : argv.slice(0, dash);
  const at = own.indexOf('--service');
  const service = at === -1 ? undefined : own[at + 1];
  const [command, ...args] = dash === -1 ? [] : argv.slice(dash + 1);
  if (!service || !command) throw new Error('usage: humanos-agent proxy --service <name> -- <command> [args…]');
  return { service, command, args };
}

/** The proxy for one server, started and declared, ready to serve (`createStdioTransport().run(proxy)`). */
export async function startProxyCommand(argv: string[], options?: ViaOptions): Promise<ViaMcpProxy> {
  const { service, command, args } = parseProxyArgs(argv);
  const v = await via(options);
  const upstream = await connectUpstream({ service, command, args });
  return startViaMcpProxy({ upstreams: [upstream], humanos: v.client, agentKey: v.key, did: v.did, ...(options?.onWarning ? { onWarning: options.onWarning } : {}) });
}
