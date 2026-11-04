/**
 * THE LIVE TIER — the framework drivers the contract runs, against a real platform (dev, or a local stack), as one
 * agent of a test organization whose policy a person set once, by hand, in the dashboard.
 *
 * It runs only when its variables are set, in the environment or in `test/.env` (git-ignored; `test/live/.env` is
 * read when there is no `test/.env`):
 * `HUMANOS_LIVE_API_KEY` and `HUMANOS_LIVE_SIGNATURE_SECRET` (the test organization's API key), and optionally
 * `HUMANOS_LIVE_MCP_URL` (default dev; a local stack: `http://localhost:4005/mcp`), `ANTHROPIC_API_KEY` (a real
 * model; without it the scripted model plays it, so the run is free and the same each time), `HUMANOS_LIVE_MODEL`
 * (default Claude Haiku, or `scripted`), `OPENROUTER_API_KEY` (the OpenRouter driver on a real model;
 * `HUMANOS_LIVE_OPENROUTER_MODEL`, default `anthropic/claude-haiku-5.5`), `HUMANOS_LIVE_AGENT_KEY` (the agent's key file content, for CI; else
 * `test/live/.humanos/<connector host>/agent-key.json`, one agent per platform).
 *
 * What the platform answered is read from the connector calls the agent made (`verify`, `report_outcome`,
 * `get_policy`); the dashboard's audit trail is the person's check.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createViaMcpClient, type ViaMcpClient } from '../../src/mcp/client.js';
import { getPolicy } from '../../src/mcp/guard-verifier.js';
import { via, type Via } from '../../src/via.js';
import type { LocalTool } from '../frameworks/contract.js';

export const LIVE_SERVICE = 'Support desk (live test)';
/** The access the test organization's policy must give each tool, as `get_policy` names it. */
/** `approve_discount` is Restrict: a control whose rule keeps `percent` under 10. */
export const LIVE_POLICY = { lookup_order: 'allow', issue_refund: 'deny', approve_discount: 'rules' } as const;
const DASHBOARD_NAME = { allow: 'Allow', deny: 'Deny', rules: 'Restrict (a control: percent under 10)' } as const;

export interface LiveConfig {
  apiKey: string;
  signatureSecret: string;
  mcpUrl: string;
  /** Absent: the scripted model plays the model. */
  anthropicKey?: string;
  /** `scripted`, or the real model's name. */
  model: string;
  /** With a real model: OpenRouter's key and model, for the OpenRouter driver; absent, that driver is skipped. */
  openrouter?: { apiKey: string; model: string };
  agentKey?: string;
  dir: string;
}

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** The tests' credentials file: `test/.env`, else `test/live/.env`, where it was first. */
export function testEnvFile(): string | undefined {
  return [here('../.env'), here('./.env')].find((f) => existsSync(f));
}

export function liveConfig(): LiveConfig | undefined {
  const file = testEnvFile() ?? '';
  const env = { ...(existsSync(file) ? (parseEnv(readFileSync(file, 'utf8')) as Record<string, string>) : {}), ...process.env };
  const { HUMANOS_LIVE_API_KEY: apiKey, HUMANOS_LIVE_SIGNATURE_SECRET: signatureSecret, ANTHROPIC_API_KEY: anthropicKey } = env;
  if (!apiKey || !signatureSecret) return undefined;
  const mcpUrl = env.HUMANOS_LIVE_MCP_URL || 'https://mcpdev.humanos.tech/mcp';
  const scripted = !anthropicKey || env.HUMANOS_LIVE_MODEL === 'scripted';
  return {
    apiKey,
    signatureSecret,
    mcpUrl,
    ...(scripted ? {} : { anthropicKey }),
    model: scripted ? 'scripted' : env.HUMANOS_LIVE_MODEL || 'claude-haiku-5-5',
    ...(!scripted && env.OPENROUTER_API_KEY ? { openrouter: { apiKey: env.OPENROUTER_API_KEY, model: env.HUMANOS_LIVE_OPENROUTER_MODEL || 'anthropic/claude-haiku-5.5' } } : {}),
    ...(env.HUMANOS_LIVE_AGENT_KEY ? { agentKey: env.HUMANOS_LIVE_AGENT_KEY } : {}),
    // One agent per platform: a key registered on one is unknown to another.
    dir: here(`./.humanos/${new URL(mcpUrl).host.replace(/[^A-Za-z0-9.-]/g, '_')}`),
  };
}

export interface ConnectorCall {
  tool: string;
  args: Record<string, unknown>;
  answer: Record<string, unknown> | undefined;
  isError: boolean;
}

export interface LiveAgent {
  via: Via;
  /** The connector the agent talks to. */
  mcpUrl: string;
  /** Every connector call since the last `reset`, with the platform's answer. */
  calls: ConnectorCall[];
  reset(): void;
  /** The platform's verdict on each call the agent asked about. */
  verdicts(): { tool: string; decision: string; reason?: string }[];
  /** The outcomes the platform recorded (`report_outcome` answered `recorded`). */
  recorded(): ConnectorCall[];
}

/** The test organization's agent on dev: one key across runs, so the dashboard shows one agent. */
export async function liveAgent(cfg: LiveConfig): Promise<LiveAgent> {
  const base = createViaMcpClient({ url: cfg.mcpUrl, apiKey: cfg.apiKey, signatureSecret: cfg.signatureSecret });
  await base.initialize();
  const calls: ConnectorCall[] = [];
  const client: ViaMcpClient = {
    initialize: () => base.initialize(),
    listTools: () => base.listTools(),
    callTool: async (tool, args = {}) => {
      const r = await base.callTool(tool, args);
      let answer: Record<string, unknown> | undefined;
      try {
        answer = JSON.parse(r.text) as Record<string, unknown>;
      } catch {
        answer = undefined;
      }
      calls.push({ tool, args, answer, isError: r.isError });
      return r;
    },
  };
  mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });
  const v = await via({ client, env: cfg.agentKey ? { HUMANOS_AGENT_KEY: cfg.agentKey } : {}, dir: cfg.dir, onWarning: (m) => void process.stderr.write(`live: ${m}\n`) });
  return {
    via: v,
    mcpUrl: cfg.mcpUrl,
    calls,
    reset: () => void calls.splice(0),
    verdicts: () =>
      calls
        .filter((c) => c.tool === 'verify' && c.answer)
        .map((c) => ({ tool: String(c.args.tool), decision: String(c.answer!.decision), ...(c.answer!.reason ? { reason: String(c.answer!.reason) } : {}) })),
    recorded: () => calls.filter((c) => c.tool === 'report_outcome' && !c.isError && c.answer && 'recorded' in c.answer),
  };
}

/** The live tools, each call recorded: what reached each tool's own code. */
export function liveTools() {
  const ran: string[] = [];
  const t = (name: string, description: string, properties: Record<string, unknown>, result: (a: Record<string, unknown>) => unknown): LocalTool => ({
    name,
    description,
    inputSchema: { type: 'object', properties, required: Object.keys(properties) },
    execute: async (args) => {
      ran.push(name);
      return result(args);
    },
  });
  return {
    ran,
    tools: [
      t('lookup_order', 'Read an order by id.', { order_id: { type: 'string' } }, (a) => ({ id: a.order_id, total_eur: 40, status: 'delivered' })),
      t('issue_refund', 'Refund an order, in euros.', { order_id: { type: 'string' }, amount_eur: { type: 'number' } }, (a) => ({ refunded: a.amount_eur })),
      t('approve_discount', 'Approve a discount on an order, in percent.', { order_id: { type: 'string' }, percent: { type: 'number' } }, (a) => ({ approved: a.percent })),
    ],
  };
}

/**
 * Declares the live tools and checks the test organization's policy gives each the access the tests expect. Off,
 * it fails with what to set in the dashboard: the policy is the person's to set, never the test's.
 */
export async function preflight(agent: LiveAgent): Promise<void> {
  await agent.via.tools.add(liveTools().tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, service: LIVE_SERVICE })));
  const policy = await getPolicy(agent.via.client, agent.via.did);
  const wrong = Object.entries(LIVE_POLICY).filter(([tool, access]) => policy.tools.find((t) => t.tool === tool)?.access !== access);
  if (!wrong.length) {
    // What the Restrict control holds, as the platform says it: the run's output shows the rule the tests meet.
    for (const c of policy.tools.find((t) => t.tool === 'approve_discount')?.controls ?? []) {
      process.stderr.write(`live: approve_discount control "${c.name}": ${c.rules.join('; ')}${c.limits.length ? ` (${c.limits.map((l) => `${l.name} = ${JSON.stringify(l.value)}`).join(', ')})` : ''}\n`);
    }
    return;
  }
  const now = (tool: string) => policy.tools.find((t) => t.tool === tool)?.access ?? 'not declared';
  throw new Error(
    [
      `The test organization's policy is not set for the live tests (agent ${agent.via.did}).`,
      `In the dashboard of the organization whose key the tests use (${new URL(agent.mcpUrl).host}), Agents, then Policy, under "${LIVE_SERVICE}", set:`,
      ...wrong.map(([tool, access]) => `  ${tool}: ${DASHBOARD_NAME[access]} (now ${now(tool)})`),
      'Then run `npm run test:live` again.',
    ].join('\n'),
  );
}
