/**
 * #654 — what a framework reports about a call: the context each adapter builds, the ledger that ties a model's
 * response to the calls it asked for, and the installed version of a framework, all read without the network.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { callContext, declaredContext, installedVersion, StepLedger } from '../src/context.js';

const STEP = { id: 'resp_1', inputTokens: 1200, outputTokens: 80 };

describe('callContext', () => {
  it('reads the model as the framework reported it, with its step', () => {
    expect(callContext({ name: 'ai-sdk', version: '7.0.0' }, { requested: 'gpt-5', answered: 'gpt-5-2026-08-07', step: STEP })).toEqual({
      v: 1,
      framework: { name: 'ai-sdk', version: '7.0.0' },
      model: { requested: 'gpt-5', answered: 'gpt-5-2026-08-07', source: 'framework' },
      step: STEP,
    });
  });

  it.each([
    ['no report', undefined],
    ['a step with no model', { step: STEP }],
  ])('marks the model not accessed when the framework read none — %s', (_case, report) => {
    expect(callContext({ name: 'langchain' }, report).model).toEqual({ source: 'not_accessed' });
  });

  it('marks a model the developer passes as declared', () => {
    expect(declaredContext({ answered: 'claude-sonnet-5-5' })).toEqual({
      v: 1,
      framework: { name: 'custom' },
      model: { answered: 'claude-sonnet-5-5', source: 'declared' },
    });
  });
});

describe('StepLedger', () => {
  it('gives the step that asked for a call once', () => {
    const ledger = new StepLedger();
    ledger.put('call_1', { answered: 'gpt-5', step: STEP });

    expect(ledger.take('call_1')).toEqual({ answered: 'gpt-5', step: STEP });
    expect(ledger.take('call_1')).toBeUndefined();
  });

  it('drops the oldest step past its bound', () => {
    const ledger = new StepLedger(2);
    for (const id of ['a', 'b', 'c']) ledger.put(id, { answered: id });

    expect([ledger.take('a'), ledger.take('b'), ledger.take('c')]).toEqual([undefined, { answered: 'b' }, { answered: 'c' }]);
  });
});

describe('installedVersion', () => {
  it("reads an installed package's version from its own package.json", async () => {
    const zod = createRequire(import.meta.url)('zod/package.json') as { version: string };

    expect(await installedVersion('zod')).toBe(zod.version);
  });

  it('answers none for a package that is not installed', async () => {
    expect(await installedVersion('not-a-package-humanos')).toBeUndefined();
  });
});
