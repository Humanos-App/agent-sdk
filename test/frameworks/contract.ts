/**
 * THE CONTRACT — what every framework adapter must do, as scenarios each framework's driver runs in its real agent
 * loop: its own provider against the scripted model, the fake connector deciding, real MCP servers where a scenario
 * has them. A driver turns the scenario's tools and servers into its framework's own, through its adapter, and runs
 * one agent turn; the scenario then reads what Humanos recorded, what reached each tool, and what the model was told.
 */
import { describe, expect, it } from 'vitest';
import type { McpServerSpec } from '../../src/mcp/upstream.js';
import { defaultPlainReason } from '../../src/mcp/server.js';
import type { TestAccess } from '../../src/testing.js';
import type { Via } from '../../src/via.js';
import { CALL_PROOF_META_KEY } from '@humanos/via-sdk-v03';
import { agentScene, PROXY, type AgentScene } from '../harness/agent.js';
import { httpSupportServer, stdioSupportServer } from '../harness/mcp-servers.js';
import { startModelServer, type ModelServer, type Step } from '../harness/model-server.js';

/** A tool in the agent's own code, as the scenario gives it; the driver makes it its framework's tool. */
export interface LocalTool {
  name: string;
  description: string;
  /** JSON Schema: every framework takes it, or converts from it. */
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export interface RunContext {
  /** The scripted model: its base URL for the framework's Anthropic provider. */
  model: ModelServer;
  via: Via;
  /** The service the local tools are declared under. */
  service: string;
  tools: LocalTool[];
  mcp: {
    /** A stdio server, to be routed behind the proxy (`via.mcp.route`, run with `proxy`). */
    stdio?: McpServerSpec;
    /** A Streamable HTTP server, and the `https` origin its calls' proof is for. */
    http?: { service: string; url: string; origin: string };
  };
  /** How a routed stdio entry runs the proxy here: the built CLI, as `npx --no-install humanos-agent proxy` would. */
  proxy: { command: string; args: readonly string[] };
  /** Variables a process the run starts needs (the proxy): the connector, its credentials, the key's directory. */
  env: Record<string, string>;
  /** The agent's project directory. */
  dir: string;
  prompt: string;
}

export interface FrameworkDriver {
  name: string;
  /** One agent turn: the model, the tools and the servers, until the model answers in text. */
  run(ctx: RunContext): Promise<void>;
  /** Its HTTP MCP calls go through `via.mcp.transport`, so an allowed one carries the call proof. */
  callProofOverHttp?: boolean;
  /**
   * The framework rethrows a tool's error out of the agent run rather than handing it to the model (LangChain's
   * `createAgent`): the failure must still be reported, and the run end with that error.
   */
  toolErrorsThrow?: boolean;
  /** Scenarios this way of running cannot meet, by id, each with why (shown in the test's name). */
  skip?: Partial<Record<ScenarioId, string>>;
}

export type ScenarioId = 'declare' | 'allow' | 'deny' | 'tool-error' | 'delegate' | 'parallel' | 'down' | 'mcp-stdio' | 'mcp-http';

const SERVICE = 'Support desk';
const ORDERS = 'Orders';
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required });

/** The support desk's tools, in the agent's own code, each call recorded; `failing` throws as a broken tool does. */
function supportTools(failing: string[] = []) {
  const ran: { tool: string; args: Record<string, unknown> }[] = [];
  const tool = (name: string, description: string, inputSchema: Record<string, unknown>, result: (a: Record<string, unknown>) => unknown): LocalTool => ({
    name,
    description,
    inputSchema,
    execute: async (args) => {
      ran.push({ tool: name, args });
      if (failing.includes(name)) throw new Error('order store down');
      return result(args);
    },
  });
  const tools = [
    tool('lookup_order', 'Read an order by id.', schema({ order_id: { type: 'string' } }, ['order_id']), (a) => ({ id: a.order_id, total_eur: 40 })),
    tool('issue_refund', 'Refund an order, in euros.', schema({ order_id: { type: 'string' }, amount_eur: { type: 'number' } }, ['order_id', 'amount_eur']), (a) => ({ refunded: a.amount_eur })),
  ];
  return { tools, ran };
}

/** True when the model was told the reason: its code, or the plain words an MCP refusal gives. */
const told = (text: string, reason: string) => text.includes(reason) || text.includes(defaultPlainReason(reason));

interface Played {
  scene: AgentScene;
  model: ModelServer;
  ran: { tool: string; args: Record<string, unknown> }[];
  /** What the model was told for each call, in the order it made them. */
  results: { text: string; isError: boolean }[];
  /** The error the run ended with, when `allowRunError` let it. */
  error?: unknown;
}

async function play(driver: FrameworkDriver, scenario: {
  policy: Record<string, TestAccess>;
  steps: Step[];
  local?: { failing?: string[] } | false;
  stdio?: ReturnType<typeof stdioSupportServer>;
  http?: Awaited<ReturnType<typeof httpSupportServer>>;
  before?: (scene: AgentScene) => void;
  callProof?: boolean;
  /** The run may end with an error (a framework that rethrows a tool's): returned, not thrown. */
  allowRunError?: boolean;
}): Promise<Played> {
  const scene = await agentScene(scenario.policy, { callProof: scenario.callProof ?? false });
  const model = await startModelServer(scenario.steps);
  const local = scenario.local === false ? { tools: [], ran: [] } : supportTools(scenario.local?.failing);
  try {
    scenario.before?.(scene);
    let error: unknown;
    await driver.run({
      model,
      via: scene.via,
      service: SERVICE,
      tools: local.tools,
      mcp: {
        ...(scenario.stdio ? { stdio: { service: ORDERS, command: scenario.stdio.command, args: scenario.stdio.args, env: scenario.stdio.env } } : {}),
        ...(scenario.http ? { http: { service: ORDERS, url: scenario.http.url, origin: 'https://orders.example' } } : {}),
      },
      proxy: PROXY,
      env: scene.env,
      dir: scene.dir,
      prompt: 'Help the customer with order A-1.',
    }).catch((e: unknown) => {
      if (!scenario.allowRunError) throw e;
      error = e;
    });
    await scene.via.tools.flush().catch(() => []);
    return { scene, model, ran: local.ran, results: model.toolResults(), error };
  } finally {
    await model.close();
    await scene.close();
    await scenario.http?.close();
  }
}

const call = (name: string, input: Record<string, unknown>) => ({ name, input });
const LOOKUP = call('lookup_order', { order_id: 'A-1' });
const REFUND = call('issue_refund', { order_id: 'A-1', amount_eur: 40 });

export function runContract(driver: FrameworkDriver): void {
  const scenario = (id: ScenarioId, title: string, fn: () => Promise<void>) => {
    const why = driver.skip?.[id];
    return why ? it.skip(`${title} (skipped: ${why})`, fn) : it(title, fn);
  };
  describe(`${driver.name}: the contract`, () => {
    scenario('declare', 'declares every tool once per service, with its JSON Schema', async () => {
      const { scene } = await play(driver, { policy: {}, steps: [{ calls: [LOOKUP] }] });
      const declared = scene.humanos.declared.filter((d) => d.services.includes(SERVICE));
      expect(declared.length).toBeGreaterThan(0);
      const last = declared[declared.length - 1]!.tools;
      expect(last.map((t) => t.name).sort()).toEqual(['issue_refund', 'lookup_order']);
      expect(last.find((t) => t.name === 'issue_refund')).toMatchObject({ service: SERVICE, inputSchema: { properties: { amount_eur: { type: 'number' } } } });
    });

    scenario('allow', 'allow: the tool runs, its outcome is reported, and the model gets its result', async () => {
      const { scene, ran, results } = await play(driver, { policy: { lookup_order: 'allow' }, steps: [{ calls: [LOOKUP] }] });
      expect(ran).toEqual([{ tool: 'lookup_order', args: { order_id: 'A-1' } }]);
      expect(scene.decisions).toMatchObject([{ tool: 'lookup_order', decision: 'allow' }]);
      expect(scene.outcomes).toEqual([{ decisionEventId: scene.decisions[0]!.eventId, outcome: 'completed' }]);
      expect(results[0]!.text).toContain('A-1');
    });

    scenario('deny', 'deny: the tool never runs, nothing is reported, and the model is told why', async () => {
      const { scene, ran, results } = await play(driver, { policy: { issue_refund: 'deny' }, steps: [{ calls: [REFUND] }] });
      expect(ran).toEqual([]);
      expect(scene.decisions).toMatchObject([{ tool: 'issue_refund', decision: 'deny', reason: 'policy_denied' }]);
      expect(scene.outcomes).toEqual([]);
      expect(told(results[0]!.text, 'policy_denied')).toBe(true);
    });

    scenario('tool-error', 'a tool error is reported as failed, and the model sees the error', async () => {
      const { scene, results, error } = await play(driver, { policy: { lookup_order: 'allow' }, steps: [{ calls: [LOOKUP] }], local: { failing: ['lookup_order'] }, allowRunError: driver.toolErrorsThrow ?? false });
      expect(scene.outcomes).toEqual([{ decisionEventId: scene.decisions[0]!.eventId, outcome: 'failed', error: 'order store down' }]);
      if (driver.toolErrorsThrow) expect(String(error)).toContain('order store down');
      else expect(results[0]!.text).toContain('order store down');
    });

    scenario('delegate', 'Delegate: refused mandate_required while no mandate covers it', async () => {
      const { scene, ran, results } = await play(driver, { policy: { issue_refund: 'mandate' }, steps: [{ calls: [REFUND] }] });
      expect(ran).toEqual([]);
      expect(scene.decisions).toMatchObject([{ tool: 'issue_refund', decision: 'deny', reason: 'mandate_required' }]);
      expect(told(results[0]!.text, 'mandate_required')).toBe(true);
    });

    scenario('parallel', 'calls in one step each get their own decision, settled against it', async () => {
      const { scene, ran } = await play(driver, {
        policy: { lookup_order: 'allow' },
        steps: [{ calls: [call('lookup_order', { order_id: 'A-1' }), call('lookup_order', { order_id: 'A-2' })] }],
      });
      expect(ran.map((r) => r.args.order_id).sort()).toEqual(['A-1', 'A-2']);
      expect(scene.decisions).toHaveLength(2);
      expect(new Set(scene.outcomes.map((o) => o.decisionEventId))).toEqual(new Set(scene.decisions.map((d) => d.eventId)));
    });

    scenario('down', 'Humanos unreachable: the tool never runs', async () => {
      const { ran, scene } = await play(driver, { policy: { lookup_order: 'allow' }, steps: [{ calls: [LOOKUP] }], before: (s) => (s.humanos.down = true) });
      expect(ran).toEqual([]);
      expect(scene.outcomes).toEqual([]);
    });

    scenario('mcp-stdio', 'MCP over stdio, routed through the proxy: each call checked once, the refused one never reaches the server', async () => {
      const stdio = stdioSupportServer();
      const { scene, results } = await play(driver, { policy: { lookup_order: 'allow', issue_refund: 'deny' }, steps: [{ calls: [LOOKUP, REFUND] }], local: false, stdio });
      expect(scene.decisions.map((d) => [d.tool, d.decision]).sort()).toEqual([['issue_refund', 'deny'], ['lookup_order', 'allow']]);
      expect(stdio.received().map((c) => c.tool)).toEqual(['lookup_order']);
      expect(scene.humanos.declared.some((d) => d.services.includes(ORDERS) && d.tools.length === 2)).toBe(true);
      expect(results.map((r) => r.text).join('\n')).toContain('A-1');
      expect(results.some((r) => told(r.text, 'policy_denied'))).toBe(true);
    });

    scenario('mcp-http', 'MCP over HTTP: each call checked once, the refused one never reaches the server', async () => {
      const http = await httpSupportServer();
      const { scene } = await play(driver, {
        policy: { lookup_order: 'allow', issue_refund: 'deny' },
        steps: [{ calls: [LOOKUP, REFUND] }],
        local: false,
        http,
        callProof: true,
      });
      expect(scene.decisions.map((d) => [d.tool, d.decision]).sort()).toEqual([['issue_refund', 'deny'], ['lookup_order', 'allow']]);
      expect(http.received.map((c) => c.tool)).toEqual(['lookup_order']);
      if (driver.callProofOverHttp) expect(http.received[0]!.meta?.[CALL_PROOF_META_KEY]).toBe('decision-token');
    });
  });
}
