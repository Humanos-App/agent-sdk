/**
 * Each wave 1 framework against a real platform (dev, or a local stack): an allowed call runs and its outcome is
 * recorded, a denied one never runs, a Delegate one is refused for want of a mandate. The model is a real one with
 * `ANTHROPIC_API_KEY`, else the scripted one. Skipped, saying why, without its variables (`test/live/live.ts`).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PROXY } from '../harness/agent.js';
import { scriptedLlm, type FrameworkDriver, type Llm, type RunContext } from '../frameworks/contract.js';
import { generate } from '../frameworks/drivers/ai-sdk.js';
import { inCode } from '../frameworks/drivers/claude-agent-sdk.js';
import { custom } from '../frameworks/drivers/custom.js';
import { agent as langchainAgent, graph as langgraph } from '../frameworks/drivers/langchain.js';
import { startModelServer } from '../harness/model-server.js';
import { LIVE_SERVICE, liveAgent, liveConfig, liveTools, preflight, type LiveAgent } from './live.js';

const cfg = liveConfig();
if (!cfg) process.stderr.write('live: skipped (set HUMANOS_LIVE_API_KEY and HUMANOS_LIVE_SIGNATURE_SECRET, in the environment or test/live/.env)\n');
else process.stderr.write(`live: ${cfg.mcpUrl}, model ${cfg.model}\n`);

describe.skipIf(!cfg)('live: a real platform', () => {
  let live: LiveAgent;
  beforeAll(async () => {
    live = await liveAgent(cfg!);
    await preflight(live);
  });

  /** One agent turn asking for one call; what ran, and what the platform said. */
  const ask = async (driver: FrameworkDriver, tool: string, input: Record<string, unknown>) => {
    live.reset();
    const { tools, ran } = liveTools();
    // The scripted model asks for exactly this call; a real one is asked to in words.
    const scripted = cfg!.anthropicKey ? undefined : await startModelServer([{ calls: [{ name: tool, input }] }]);
    const llm: Llm = scripted ? scriptedLlm(scripted) : { baseURL: 'https://api.anthropic.com', apiKey: cfg!.anthropicKey!, model: cfg!.model };
    const ctx: RunContext = {
      llm,
      via: live.via,
      service: LIVE_SERVICE,
      tools,
      mcp: {},
      proxy: PROXY,
      env: {},
      dir: mkdtempSync(join(tmpdir(), 'live-agent-')),
      prompt: `Call the ${tool} tool once with exactly these arguments: ${JSON.stringify(input)}. Then answer in one sentence with what it returned.`,
    };
    await driver.run(ctx).catch(() => {}); // a refusal may end a run; what the platform recorded is the check
    await scripted?.close();
    return { ran, verdict: live.verdicts().find((v) => v.tool === tool), recorded: live.recorded() };
  };

  for (const driver of [custom, generate, langchainAgent, langgraph, inCode]) {
    describe(driver.name, () => {
      it('Allow: the call runs, and the platform records its outcome', async () => {
        const { ran, verdict, recorded } = await ask(driver, 'lookup_order', { order_id: 'A-1' });
        expect(verdict).toEqual({ tool: 'lookup_order', decision: 'allow' });
        expect(ran).toContain('lookup_order');
        expect(recorded.length).toBeGreaterThan(0);
      });

      it('Deny: the call never runs', async () => {
        const { ran, verdict } = await ask(driver, 'issue_refund', { order_id: 'A-1', amount_eur: 40 });
        expect(verdict).toMatchObject({ tool: 'issue_refund', decision: 'deny', reason: 'policy_denied' });
        expect(ran).not.toContain('issue_refund');
      });

      it('Delegate: refused while no person has granted a mandate', async () => {
        const { ran, verdict } = await ask(driver, 'approve_discount', { order_id: 'A-1', percent: 10 });
        expect(verdict).toMatchObject({ tool: 'approve_discount', decision: 'deny', reason: 'mandate_required' });
        expect(ran).not.toContain('approve_discount');
      });
    });
  }
});
