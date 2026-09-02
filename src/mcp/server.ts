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
    stepup_declined: 'a manager did not approve it',
    // v0.3 actor gates
    actor_suspended: 'the connector is SUSPENDED — ask the operator to resume it on the dashboard',
    actor_retired: 'the connector has been retired',
    agent_key_revoked: 'the connector’s key has been revoked',
    actor_snapshot_stale: 'the connector’s identity record is stale and was refused',
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
  /** Transport-provided: send a server→client JSON-RPC request (used for elicitation). */
  sendRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Override the step-up decision (tests); default is elicitation → dashboard. */
  onStepUp?: (info: { tool: string; params: Record<string, unknown> }) => Promise<boolean>;
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
  // Set at initialize — whether the connected client can render an approval prompt.
  let clientCaps: Record<string, unknown> = {};

  // ---- onboard: the connector is the bound principal (actor genesis → mandate) ----
  const agentKey = await (cfg.key ?? attestedKey)();
  const joined = await client.join(name, agentKey);
  await client.extract(cfg.surface);
  const { compiled, actionId } = await client.publishAction(cfg.manifestYaml, cfg.exposure);
  const { mandate } = await client.requestMandate({ actionId, agentName: name, userParamValues: cfg.userParamValues });

  // The manager step-up (§17.4). Two channels, in order of preference:
  //  1. MCP `elicitation/create` — renders IN THE APP, when the client declared it.
  //  2. Otherwise, surface it on the DASHBOARD and wait — works with any client.
  const requestApproval = async (info: { tool: string; params: Record<string, unknown> }): Promise<boolean> => {
    const amount = info.params.amount_usd == null ? null : Number(info.params.amount_usd);
    const canElicit = Boolean((clientCaps as { elicitation?: unknown }).elicitation) && Boolean(cfg.sendRequest);
    if (canElicit) {
      try {
        const res = (await cfg.sendRequest!('elicitation/create', {
          message: `Manager approval needed: ${info.tool.replace(/_/g, ' ')}${amount ? ` for $${amount}` : ''}. Approve?`,
          requestedSchema: { type: 'object', title: 'Manager approval', properties: { approve: { type: 'boolean', title: 'Approve this action?' } }, required: ['approve'] },
        })) as { action?: string; content?: { approve?: boolean } };
        return res?.action === 'accept' && res.content?.approve === true;
      } catch {
        return false;
      }
    }
    // Dashboard fallback: register a pending approval and poll until a human decides.
    try {
      const { id } = await client.requestStepUp(mandate.id, info.tool, amount);
      const deadline = Date.now() + 180_000;
      for (;;) {
        const { decided } = await client.stepUpStatus(id);
        if (decided !== null) return decided;
        if (Date.now() > deadline) return false; // timeout → declined (fail closed)
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch {
      return false;
    }
  };

  const guard = new ViaGuard({
    mandate,
    agentKey,
    compiled,
    verifier: client.verifierFor(mandate.id),
    onRechallenge: cfg.onStepUp ?? requestApproval,
  });
  guard.interceptTools(cfg.impls);

  const tools: McpTool[] = [...cfg.surface.tools, ...(cfg.extraTools ?? [])];

  const handleRpc = async (msg: JsonRpcMessage): Promise<JsonRpcMessage | null> => {
    const { id, method, params } = msg;
    const reply = (result: unknown): JsonRpcMessage => ({ jsonrpc: '2.0', id: id ?? null, result });
    const fail = (code: number, message: string): JsonRpcMessage => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

    switch (method) {
      case 'initialize':
        clientCaps = (params?.capabilities as Record<string, unknown>) ?? {};
        return reply({
          protocolVersion: (params?.protocolVersion as string) ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: cfg.serverInfo ?? { name: 'via-connector', version: '0.1.0' },
          instructions:
            cfg.instructions ??
            'Tools governed by VIA. Calls are verified against a company mandate; over-limit or ungranted actions are blocked with a reason. Some actions may pause for manager approval.',
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
