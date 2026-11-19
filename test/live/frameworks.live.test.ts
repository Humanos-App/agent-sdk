/**
 * Each wave 1 framework against a real platform (dev, or a local stack): an allowed call runs and its outcome is
 * recorded, a denied one never runs, a Restrict one runs within its control's limit and is refused over it. The model is a real one with
 * `ANTHROPIC_API_KEY`, else the scripted one. Skipped, saying why, without its variables (`test/live/live.ts`).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROXY } from '../harness/agent.js';
import { scriptedLlm, scriptedOpenRouter, type FrameworkDriver, type Llm, type RunContext } from '../frameworks/contract.js';
import { generate } from '../frameworks/drivers/ai-sdk.js';
import { inCode } from '../frameworks/drivers/claude-agent-sdk.js';
import { custom } from '../frameworks/drivers/custom.js';
import { agent as langchainAgent, graph as langgraph } from '../frameworks/drivers/langchain.js';
import { openrouterGenerate } from '../frameworks/drivers/openrouter.js';
import { startModelServer } from '../harness/model-server.js';
import { LIVE_SERVICE, liveAgent, liveConfig, liveTools, preflight, type LiveAgent, type SentContext } from './live.js';

const cfg = liveConfig();
if (!cfg) process.stderr.write('live: skipped (set HUMANOS_LIVE_API_KEY and HUMANOS_LIVE_SIGNATURE_SECRET, in the environment or test/live/.env)\n');
else process.stderr.write(`live: ${cfg.mcpUrl}, model ${cfg.model}\n`);

/**
 * #654 — what each framework reports about a call: its name, and whether it reads the model (a LangGraph `ToolNode`
 * sees no model call; a custom agent declares the reply's model).
 */
const REPORTS = new Map<FrameworkDriver, { name: string; source: 'framework' | 'declared' | 'not_accessed' }>([
  [custom, { name: 'custom', source: 'declared' }],
  [generate, { name: 'ai-sdk', source: 'framework' }],
  [langchainAgent, { name: 'langchain', source: 'framework' }],
  [langgraph, { name: 'langchain', source: 'not_accessed' }],
  [inCode, { name: 'claude-agent-sdk', source: 'framework' }],
  [openrouterGenerate, { name: 'openrouter', source: 'framework' }],
]);

describe.skipIf(!cfg)('live: a real platform', () => {
  let live: LiveAgent;
  /** Every decided call's context, written for `scripts/devtools/call-context.ts` in agent-mandate-protocol to check. */
  const sent: SentContext[] = [];
  beforeAll(async () => {
    live = await liveAgent(cfg!);
    await preflight(live);
  });
  afterAll(() => {
    const file = join(cfg!.dir, 'call-contexts.json');
    writeFileSync(file, `${JSON.stringify(sent, null, 2)}\n`);
    process.stderr.write(`live: ${sent.length} call contexts written to ${file}\n`);
  });

  /** One agent turn asking for one call; what ran, and what the platform said. */
  const ask = async (driver: FrameworkDriver, tool: string, input: Record<string, unknown>) => {
    live.reset();
    const { tools, ran } = liveTools();
    // The scripted model asks for exactly this call; a real one is asked to in words.
    const scripted = cfg!.anthropicKey ? undefined : await startModelServer([{ calls: [{ name: tool, input }] }]);
    const llm: Llm = scripted ? scriptedLlm(scripted) : { baseURL: 'https://api.anthropic.com', apiKey: cfg!.anthropicKey!, model: cfg!.model };
    const openrouter: Llm | undefined = scripted
      ? scriptedOpenRouter(scripted)
      : cfg!.openrouter && { baseURL: 'https://openrouter.ai/api/v1', apiKey: cfg!.openrouter.apiKey, model: cfg!.openrouter.model };
    const ctx: RunContext = {
      llm,
      ...(openrouter ? { openrouter } : {}),
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
    sent.push(...live.sent());
    return { ran, verdict: live.verdicts().find((v) => v.tool === tool), recorded: live.recorded(), sent: live.sent().find((s) => s.tool === tool) };
  };

  // OpenRouter on a real model needs its own key; on the scripted model it runs like the rest.
  const openrouterReady = !!cfg && (!cfg.anthropicKey || !!cfg.openrouter);
  for (const driver of [custom, generate, langchainAgent, langgraph, inCode, openrouterGenerate]) {
    const skipped = driver === openrouterGenerate && !openrouterReady;
    describe.skipIf(skipped)(skipped ? `${driver.name} (skipped: set OPENROUTER_API_KEY)` : driver.name, () => {
      it('Allow: the call runs, and the platform records its outcome', async () => {
        const { ran, verdict, recorded } = await ask(driver, 'lookup_order', { order_id: 'A-1' });
        expect(verdict).toEqual({ tool: 'lookup_order', decision: 'allow' });
        expect(ran).toContain('lookup_order');
        expect(recorded.length).toBeGreaterThan(0);
      });

      // #654: on a real model, what the framework itself returns: the model that answered and the step's tokens.
      it('reports the model that asked for the call, its tokens, and the run time', async () => {
        const { sent: call } = await ask(driver, 'lookup_order', { order_id: 'A-1' });
        const { name, source } = REPORTS.get(driver)!;
        expect(call?.reported).toMatchObject({ v: 1, framework: { name }, model: { source } });
        if (source !== 'not_accessed') {
          expect(call!.reported.model.answered).toMatch(/\S/);
          expect(call!.reported.step).toMatchObject({ id: expect.stringMatching(/\S/), inputTokens: expect.any(Number), outputTokens: expect.any(Number) });
          expect(call!.reported.step!.inputTokens).toBeGreaterThan(0);
        }
        expect(call?.durationMs).toEqual(expect.any(Number));
        process.stderr.write(`live: ${driver.name}: ${JSON.stringify(call?.reported)}\n`);
      });

      it('Deny: the call never runs', async () => {
        const { ran, verdict } = await ask(driver, 'issue_refund', { order_id: 'A-1', amount_eur: 40 });
        expect(verdict).toMatchObject({ tool: 'issue_refund', decision: 'deny', reason: 'policy_denied' });
        expect(ran).not.toContain('issue_refund');
      });

      it('Restrict, within the limit (5%): the call runs, and its outcome is recorded', async () => {
        const { ran, verdict, recorded } = await ask(driver, 'approve_discount', { order_id: 'A-1', percent: 5 });
        expect(verdict).toEqual({ tool: 'approve_discount', decision: 'allow' });
        expect(ran).toContain('approve_discount');
        expect(recorded.length).toBeGreaterThan(0);
      });

      it('Restrict, over the limit (15%): the call never runs', async () => {
        const { ran, verdict } = await ask(driver, 'approve_discount', { order_id: 'A-1', percent: 15 });
        // A Restrict control's broken rule is the policy refusing the call (`rule_failed` is a mandate's rule).
        expect(verdict).toMatchObject({ tool: 'approve_discount', decision: 'deny', reason: 'policy_denied' });
        expect(ran).not.toContain('approve_discount');
      });
    });
  }
});
