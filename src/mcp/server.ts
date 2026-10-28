/**
 * THE VIA-GOVERNED MCP CONNECTOR — `@humanos/agent-sdk`'s go-to-market wedge.
 *
 * Apps that speak MCP (Claude Desktop, Claude.ai connectors, Cursor, …) point at
 * THIS server and every tool call they make is verified against a mandate before
 * it runs — no change to the app. The app is the brain; the connector holds the
 * key and the mandate; the guard never trusts the model.
 *
 * This module is protocol-agnostic and DEMO-AGNOSTIC: the governed tool surface,
 * manifest, implementations and mandate parameters are all injected — the host
 * application supplies its own (agent2's purchasing demo is one such host). A
 * transport driver (`stdio.ts`) pumps JSON-RPC in and out.
 */
import { MiniPlatformClient } from '../client.js';
import { ViaGuard, ViaDeniedError } from '../guard.js';
import { attestedKey, type ViaAgentKey } from '../key-provider.js';
import type { ExposurePolicy, McpTool, McpToolsList } from '../types.js';

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** Plain-language "why blocked" for the model to relay to the user. */
export function defaultPlainReason(r?: string): string {
  if (!r) return 'blocked by policy';
  if (r.startsWith('execution_params_invalid:unmanifested_tool')) return 'this action is not one the connector is allowed to take';
  if (r.startsWith('execution_params_invalid')) return 'the request was not valid';
  return ({
    rule_failed: 'it breaks a company rule (e.g. over the spending limit)',
    exposure_cap_exceeded: 'it would exceed the daily budget',
    credential_revoked: 'the connector’s permission has been switched off',
    agent_assurance_insufficient: 'this device is not trusted enough for that action',
    // v0.3 actor gates
    actor_suspended: 'the connector is SUSPENDED — ask the operator to resume it on the dashboard',
    actor_retired: 'the connector has been retired',
    agent_key_revoked: 'the connector’s key has been revoked',
    actor_snapshot_stale: 'the connector’s identity record is stale and was refused',
    // v0.3 §0.6.1 — the tools an action covers
    tool_not_covered: 'this tool is not one the permission covers',
    required_param_missing: 'a value a rule needs to check was left out',
    // v0.3 §21 — the organization's policy
    policy_denied: 'the organization’s policy does not allow it',
    mandate_required: 'it needs a person’s permission, and none covers it',
    stepup_required: 'it needs an approval nobody is named to give',
    // v0.3 delegation
    tool_not_delegated: 'this action was not delegated to this sub-agent',
    parent_not_active: 'the delegating parent’s permission is no longer active',
  })[r] ?? `blocked (${r})`;
}

export interface ViaMcpServer {
  name: string;
  /** The connector's ACTOR DID (v0.3 — registration is actor genesis). */
  did: string;
  keyId: string;
  mandateId: string;
  /** The platform URL the connector governs against (the dashboard). */
  platformUrl: string;
  /** True when this process is self-hosting the platform. */
  embeddedPlatform: boolean;
  /** Handle one JSON-RPC message; returns the response, or null for notifications. */
  handleRpc(msg: JsonRpcMessage): Promise<JsonRpcMessage | null>;
  tools: McpTool[];
}

export interface ViaMcpConfig {
  platformUrl?: string;
  name?: string;
  /** The governed tool surface — advertised over MCP and extracted by the platform. */
  surface: McpToolsList;
  /** The developer-completed manifest published to the platform. */
  manifestYaml: string;
  /** The tool implementations the guard intercepts. */
  impls: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>;
  /** Advertised-but-ungoverned tools (drift demo: VIA refuses them with a reason). */
  extraTools?: McpTool[];
  exposure?: ExposurePolicy;
  userParamValues: Record<string, unknown>;
  serverInfo?: { name: string; version: string };
  instructions?: string;
  plainReason?: (r?: string) => string;
  /** The connector's key provider; defaults to a (mock) attested key. */
  key?: () => Promise<ViaAgentKey>;
  /** Self-host a platform when none answers at platformUrl (injected by the host app). */
  selfHost?: (port: number) => Promise<{ url: string }>;
}

/** Use an already-running platform if one answers; otherwise self-host (when the host app allows). */
async function resolvePlatform(cfg: ViaMcpConfig): Promise<{ url: string; embedded: boolean }> {
  const url = cfg.platformUrl ?? process.env.PLATFORM_URL ?? 'http://localhost:4666';
  try {
    const res = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return { url, embedded: false };
  } catch {
    /* nothing there — self-host below if allowed */
  }
  if (!cfg.selfHost) throw new Error(`no platform at ${url} and no selfHost configured`);
  const port = Number(new URL(url).port || 4666);
  try {
    const hosted = await cfg.selfHost(port);
    return { url: hosted.url, embedded: true };
  } catch {
    return { url, embedded: false }; // port raced — fall back to the URL as-is
  }
}

export async function startViaMcpServer(cfg: ViaMcpConfig): Promise<ViaMcpServer> {
  const { url: platformUrl, embedded } = await resolvePlatform(cfg);
  const name = cfg.name ?? 'via-connector';
  const plainReason = cfg.plainReason ?? defaultPlainReason;
  const client = new MiniPlatformClient(platformUrl);

  // ---- onboard: the connector is the bound principal (actor genesis → mandate) ----
  const agentKey = await (cfg.key ?? attestedKey)();
  const joined = await client.join(name, agentKey);
  await client.extract(cfg.surface);
  const { compiled, actionId } = await client.publishAction(cfg.manifestYaml, cfg.exposure);
  const { mandate } = await client.requestMandate({ actionId, agentName: name, userParamValues: cfg.userParamValues });

  const guard = new ViaGuard({ mandate, agentKey, agentDid: joined.did, compiled, verifier: client.verifierFor(mandate.id) });
  guard.interceptTools(cfg.impls);

  const tools: McpTool[] = [...cfg.surface.tools, ...(cfg.extraTools ?? [])];

  const handleRpc = async (msg: JsonRpcMessage): Promise<JsonRpcMessage | null> => {
    const { id, method, params } = msg;
    const reply = (result: unknown): JsonRpcMessage => ({ jsonrpc: '2.0', id: id ?? null, result });
    const fail = (code: number, message: string): JsonRpcMessage => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: (params?.protocolVersion as string) ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: cfg.serverInfo ?? { name: 'via-connector', version: '0.1.0' },
          instructions:
            cfg.instructions ??
            'Tools governed by VIA. Calls are verified against a company mandate; over-limit or ungranted actions are blocked with a reason.',
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null; // notifications get no response
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools });
      case 'resources/list':
        return reply({ resources: [] });
      case 'prompts/list':
        return reply({ prompts: [] });
      case 'tools/call': {
        const toolName = String(params?.name ?? '');
        const args = (params?.arguments as Record<string, unknown>) ?? {};
        try {
          const result = toolName in cfg.impls
            ? await cfg.impls[toolName]!(args)
            : (await guard.call(toolName, args, () => 'ungranted tool')).result;
          return reply({ content: [{ type: 'text', text: String(result) }] });
        } catch (e) {
          if (e instanceof ViaDeniedError) {
            return reply({ content: [{ type: 'text', text: `Blocked by VIA: ${plainReason(e.reason)}. Do not retry.` }], isError: true });
          }
          return reply({ content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
        }
      }
      default:
        return id === undefined || id === null ? null : fail(-32601, `method not found: ${String(method)}`);
    }
  };

  return {
    name,
    did: joined.did,
    keyId: joined.keyId,
    mandateId: mandate.id,
    platformUrl,
    embeddedPlatform: embedded,
    handleRpc,
    tools,
  };
}
