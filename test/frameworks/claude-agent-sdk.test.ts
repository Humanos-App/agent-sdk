import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { agentScene } from '../harness/agent.js';
import { startModelServer } from '../harness/model-server.js';
import { runContract, scriptedLlm } from './contract.js';
import { drain, engineEnv, inCode, noCode, writeSettingsHooks } from './drivers/claude-agent-sdk.js';

runContract(inCode);
runContract(noCode);

describe('Claude Agent SDK built-in tools, with no code: the settings hook governs Bash', () => {
  const runBash = async (access: 'allow' | 'deny') => {
    const scene = await agentScene({ Bash: access });
    const model = await startModelServer([{ calls: [{ name: 'Bash', input: { command: 'echo ran > ran.txt', description: 'write a file' } }] }]);
    try {
      writeSettingsHooks(scene.dir);
      await drain(query({ prompt: 'Write the file.', options: { cwd: scene.dir, settingSources: ['project'], allowedTools: ['Bash'], maxTurns: 3, env: engineEnv({ llm: scriptedLlm(model), env: scene.env }) } }));
      return { scene, ran: existsSync(join(scene.dir, 'ran.txt')), results: model.toolResults() };
    } finally {
      await model.close();
      await scene.close();
    }
  };

  it('a denied Bash call never runs, and the model is told why', async () => {
    const { scene, ran, results } = await runBash('deny');
    expect(ran).toBe(false);
    expect(scene.decisions).toMatchObject([{ tool: 'Bash', decision: 'deny', reason: 'policy_denied' }]);
    expect(results[0]!.text).toContain('policy_denied');
  });

  it('an allowed Bash call runs, and its outcome is reported from the other hook process', async () => {
    const { scene, ran } = await runBash('allow');
    expect(ran).toBe(true);
    expect(scene.outcomes).toEqual([{ decisionEventId: scene.decisions[0]!.eventId, outcome: 'completed' }]);
  });
});
