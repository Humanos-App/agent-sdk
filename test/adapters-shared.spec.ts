import { describe, expect, it } from 'vitest';
import { checkCall, refusalError, routeStdioEntries, runAndSettle } from '../src/adapters/shared.js';
import { ViaDeniedError } from '../src/guard.js';
import { agentScene } from './harness/agent.js';

// What every adapter shares: one check (failing closed, one set of words), one run that reports its outcome once, one
// routing of stdio MCP entries. Each adapter only maps these onto its framework.

describe('checkCall — the check every adapter makes', () => {
  it('allowed: goes on with the check', async () => {
    const scene = await agentScene({ lookup_order: 'allow' });
    const call = await checkCall(scene.via, 'lookup_order', { order_id: 'A-1' });
    expect(call).toMatchObject({ ok: true, checked: { decision: 'allow', proceed: true } });
    await scene.close();
  });

  it('refused: the reason in the shared words, with the check', async () => {
    const scene = await agentScene({ issue_refund: 'deny' });
    const call = await checkCall(scene.via, 'issue_refund', {});
    expect(call).toMatchObject({ ok: false, message: 'Blocked by Humanos (policy_denied): the organization’s policy does not allow it. Nothing was run. Do not retry.' });
    expect(call.ok ? undefined : call.checked?.reason).toBe('policy_denied');
    await scene.close();
  });

  it('Humanos unreachable: refused, never let through, with no check', async () => {
    const scene = await agentScene({ lookup_order: 'allow' });
    scene.humanos.down = true;
    const call = await checkCall(scene.via, 'lookup_order', {});
    expect(call).toMatchObject({ ok: false, message: expect.stringMatching(/^Blocked: Humanos could not be reached/) });
    expect(call.ok ? 'checked' : call.checked).toBeUndefined();
    await scene.close();
  });

  it('refusalError: a ViaDeniedError carrying the words when Humanos refused; an Error when it could not be asked', async () => {
    const scene = await agentScene({ issue_refund: 'deny' });
    const refused = await checkCall(scene.via, 'issue_refund', {});
    if (refused.ok) throw new Error('expected a refusal');
    const e = refusalError(refused);
    expect(e).toBeInstanceOf(ViaDeniedError);
    expect(e.message).toBe(refused.message);
    expect((e as ViaDeniedError).reason).toBe('policy_denied');
    expect(refusalError({ ok: false, message: 'unreachable' })).not.toBeInstanceOf(ViaDeniedError);
    await scene.close();
  });
});

describe('runAndSettle — the run, and its outcome reported once', () => {
  const checked = async (scene: Awaited<ReturnType<typeof agentScene>>) => {
    const call = await checkCall(scene.via, 'lookup_order', {});
    if (!call.ok) throw new Error('expected an allow');
    return call.checked;
  };

  it('completed: the result back, one outcome', async () => {
    const scene = await agentScene({ lookup_order: 'allow' });
    expect(await runAndSettle(scene.via, await checked(scene), () => 'the order')).toBe('the order');
    expect(scene.outcomes).toMatchObject([{ outcome: 'completed' }]);
    await scene.close();
  });

  it('the run throws: one outcome, failed, and the error rethrown as the framework would see it', async () => {
    const scene = await agentScene({ lookup_order: 'allow' });
    await expect(runAndSettle(scene.via, await checked(scene), () => Promise.reject(new Error('order store down')))).rejects.toThrow('order store down');
    expect(scene.outcomes).toEqual([expect.objectContaining({ outcome: 'failed', error: 'order store down' })]);
    await scene.close();
  });

  it('a failure in what it returned (an error ToolMessage): failed, and the result still returned', async () => {
    const scene = await agentScene({ lookup_order: 'allow' });
    const out = await runAndSettle(scene.via, await checked(scene), () => ({ status: 'error' }), (o) => (o.status === 'error' ? 'the tool said no' : undefined));
    expect(out).toEqual({ status: 'error' });
    expect(scene.outcomes).toEqual([expect.objectContaining({ outcome: 'failed', error: 'the tool said no' })]);
    await scene.close();
  });

  it('reporting a completed run fails: the run is not reported a second time as failed', async () => {
    const scene = await agentScene({ lookup_order: 'allow' });
    const c = await checked(scene);
    let ran = 0;
    const run = runAndSettle(scene.via, c, () => {
      ran++;
      scene.humanos.down = true; // Humanos goes away after the call and before its outcome
      return 'done';
    });
    await expect(run).rejects.toThrow(/connect ECONNREFUSED/);
    expect(ran).toBe(1);
    expect(scene.outcomes).toEqual([]);
    await scene.close();
  });
});

describe('routeStdioEntries — a framework’s stdio MCP entries behind the proxy', () => {
  it('routes Claude’s (`type`) and LangChain’s (`transport`) stdio entries, leaves remote ones, and marks the routed services', async () => {
    const scene = await agentScene({});
    const routed = routeStdioEntries(scene.via, {
      claude: { type: 'stdio', command: 'node', args: ['a.mjs'] },
      langchain: { transport: 'stdio', command: 'node', args: ['b.mjs'], env: { TOKEN: 't' } },
      plain: { command: 'node', args: ['c.mjs'] },
      remote: { type: 'http', url: 'https://mcp.example' },
      sse: { transport: 'sse', url: 'https://mcp.example/sse' },
    });
    for (const name of ['claude', 'langchain', 'plain']) {
      expect(routed[name as 'claude']).toMatchObject({ command: 'npx', args: ['--no-install', 'humanos-agent', 'proxy', '--service', name, '--', 'node', expect.any(String)] });
      expect(scene.via.mcp.checks(name, 'any_tool')).toBe(true);
    }
    expect(routed.langchain).toMatchObject({ env: { TOKEN: 't' }, transport: 'stdio' });
    expect(routed.remote).toEqual({ type: 'http', url: 'https://mcp.example' });
    expect(routed.sse).toEqual({ transport: 'sse', url: 'https://mcp.example/sse' });
    expect(scene.via.mcp.checks('remote', 'any_tool')).toBe(false);
    await scene.close();
  });
});
