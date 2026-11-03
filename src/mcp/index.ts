/**
 * `@humanos-ai/agent-sdk/mcp` — MCP connections through Humanos, for the framework adapters and for agents that build
 * their own: the connection wrapper (the governing proxy in the agent's process), stdio routing to the proxy, and the
 * one type every part of the SDK names an MCP server with. `via().mcp` is the same, bound to the agent.
 */
export { createViaMcp, routeStdio, runChecked, PROXY_COMMAND } from './transport.js';
export type { McpConnectionOptions, McpTransportLike, ViaMcp, ViaMcpDeps } from './transport.js';
export { refusalText } from './refusal.js';
export type { McpServerSpec, UpstreamServer } from './upstream.js';
