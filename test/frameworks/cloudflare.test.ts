/**
 * Cloudflare Agents, for real: a Worker with an `Agent` (a Durable Object) run by the Workers runtime (workerd, through
 * wrangler), its tools through the AI SDK adapter, against the scripted model and the fake connector on this machine.
 * This is what shows agent-sdk loads and runs inside a Worker (`nodejs_compat`), with the key from a secret.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';
import { agentScene, type AgentScene } from '../harness/agent.js';
import { startModelServer, type Step } from '../harness/model-server.js';
import type { Ask } from './cloudflare/worker.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
let worker: Unstable_DevWorker;

beforeAll(async () => {
  worker = await unstable_dev(here('./cloudflare/worker.ts'), {
    config: here('./cloudflare/wrangler.jsonc'),
    experimental: { disableExperimentalWarning: true },
    ip: '127.0.0.1',
    persist: false,
    logLevel: 'error',
  });
}, 120_000);
afterAll(async () => worker?.stop());

/** One scenario in the Worker: the scene's connector and key as the agent's secrets, the scripted model's choices. */
async function play(policy: Parameters<typeof agentScene>[0], steps: Step[], options: { failing?: string[]; down?: boolean } = {}) {
  const scene: AgentScene = await agentScene(policy);
  const model = await startModelServer(steps);
  try {
    if (options.down) scene.humanos.down = true;
    const ask: Ask = {
      prompt: 'Help the customer with order A-1.',
      ...(options.failing ? { failing: options.failing } : {}),
      humanos: {
        HUMANOS_API_KEY: scene.env.HUMANOS_API_KEY!,
        HUMANOS_SIGNATURE_SECRET: scene.env.HUMANOS_SIGNATURE_SECRET!,
        HUMANOS_MCP_URL: scene.env.HUMANOS_MCP_URL!,
        HUMANOS_AGENT_KEY: readFileSync(join(scene.env.HUMANOS_DIR!, 'agent-key.json'), 'utf8'),
      },
      modelUrl: model.url,
    };
    const res = await worker.fetch('http://agent/', { method: 'POST', body: JSON.stringify(ask), headers: { 'content-type': 'application/json' } });
    const out = (await res.json()) as { ran: string[]; error?: string; runtime: string };
    return { scene, out, results: model.toolResults() };
  } finally {
    await model.close();
    await scene.close();
  }
}

const LOOKUP = { name: 'lookup_order', input: { order_id: 'A-1' } };
const REFUND = { name: 'issue_refund', input: { order_id: 'A-1', amount_eur: 40 } };

describe('Cloudflare Agents (an Agent in workerd, through the AI SDK adapter)', () => {
  it('declares the tools, with their JSON Schema, from inside the Worker', async () => {
    const { scene } = await play({}, [{ text: 'Nothing to do.' }]);
    const d = scene.humanos.declared.find((x) => x.services.includes('Support desk'))!;
    expect(d.tools.map((t) => t.name)).toEqual(['lookup_order', 'issue_refund']);
    expect(d.tools[1]).toMatchObject({ inputSchema: { properties: { amount_eur: { type: 'number' } } } });
  });

  it('allow: the tool runs, its outcome is reported, and the model gets its result', async () => {
    const { scene, out, results } = await play({ lookup_order: 'allow' }, [{ calls: [LOOKUP] }]);
    expect(out.runtime).toBe('Cloudflare-Workers');
    expect(out.ran).toEqual(['lookup_order']);
    expect(scene.decisions).toMatchObject([{ tool: 'lookup_order', decision: 'allow' }]);
    expect(scene.outcomes).toEqual([{ decisionEventId: scene.decisions[0]!.eventId, outcome: 'completed' }]);
    expect(results[0]!.text).toContain('A-1');
  });

  it('deny: the tool never runs, and the model is told why', async () => {
    const { scene, out, results } = await play({ issue_refund: 'deny' }, [{ calls: [REFUND] }]);
    expect(out.ran).toEqual([]);
    expect(scene.decisions).toMatchObject([{ tool: 'issue_refund', decision: 'deny', reason: 'policy_denied' }]);
    expect(results[0]!.text).toContain('policy_denied');
  });

  it('a tool error is reported as failed', async () => {
    const { scene } = await play({ lookup_order: 'allow' }, [{ calls: [LOOKUP] }], { failing: ['lookup_order'] });
    expect(scene.outcomes).toEqual([{ decisionEventId: scene.decisions[0]!.eventId, outcome: 'failed', error: 'order store down' }]);
  });

  it('Delegate: refused mandate_required while no mandate covers it', async () => {
    const { scene, out } = await play({ issue_refund: 'mandate' }, [{ calls: [REFUND] }]);
    expect(out.ran).toEqual([]);
    expect(scene.decisions).toMatchObject([{ tool: 'issue_refund', decision: 'deny', reason: 'mandate_required' }]);
  });

  it('Humanos unreachable: the tool never runs', async () => {
    const { out } = await play({ lookup_order: 'allow' }, [{ calls: [LOOKUP] }], { down: true });
    expect(out.ran).toEqual([]);
  });
});
