/**
 * The live tier's own wiring, against the fake connector on HTTP: its preflight refuses to run until the test
 * organization's policy is set, and says what to set; set, it lets the tests run. The model is not involved.
 */
import { describe, expect, it } from 'vitest';
import { agentScene } from '../harness/agent.js';
import { liveAgent, preflight, type LiveConfig } from '../live/live.js';

const configFor = (env: Record<string, string>): LiveConfig => ({
  apiKey: env.HUMANOS_API_KEY!,
  signatureSecret: env.HUMANOS_SIGNATURE_SECRET!,
  mcpUrl: env.HUMANOS_MCP_URL!,
  anthropicKey: 'unused',
  model: 'unused',
  dir: env.HUMANOS_DIR!, // the scene's agent: one key, as the live tier keeps one across runs
});

describe('the live tier’s preflight', () => {
  it('with the policy not set: fails, naming each tool and its dashboard access', async () => {
    const scene = await agentScene({ lookup_order: 'allow' });
    const live = await liveAgent(configFor(scene.env));
    const failed = await preflight(live).then(() => '', (e: Error) => e.message);
    expect(failed).toContain('Agents, then Policy, under "Support desk (live test)"');
    expect(failed).toContain('issue_refund: Deny (now not declared)');
    expect(failed).toContain('approve_discount: Restrict (a control: percent under 10) (now not declared)');
    expect(failed).not.toContain('lookup_order:');
    expect(scene.humanos.declared.at(-1)?.tools.map((t) => t.name)).toEqual(['lookup_order', 'issue_refund', 'approve_discount']);
    await scene.close();
  });

  it('with the policy set: passes, and the agent’s calls are read back from the connector', async () => {
    const scene = await agentScene({ lookup_order: 'allow', issue_refund: 'deny' }, { reported: { approve_discount: 'rules' } });
    const live = await liveAgent(configFor(scene.env));
    await preflight(live);
    live.reset();
    await live.via.guard.check('issue_refund', { order_id: 'A-1', amount_eur: 40 });
    expect(live.verdicts()).toEqual([{ tool: 'issue_refund', decision: 'deny', reason: 'policy_denied' }]);
    await scene.close();
  });
});
