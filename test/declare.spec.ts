import { describe, expect, it } from 'vitest';
import type { ViaMcpClient } from '../src/mcp/client.js';
import { DECLARE_TOOLS_MAX, declareTools, type DeclaredTool } from '../src/mcp/declare.js';

const DID = 'did:web:humanos.tech:agent:a';

/** A stand-in Humanos: records each `declare_tools` call and answers it, or refuses it with a sentence. */
function platform(answer: (args: Record<string, unknown>) => Record<string, unknown> | string = (args) => ({ recorded: (args.tools as unknown[]).length })) {
  const calls: Record<string, unknown>[] = [];
  const client: ViaMcpClient = {
    initialize: async () => ({ serverInfo: { name: 'humanos', version: '0' }, protocolVersion: '2025-06-18' }),
    listTools: async () => [],
    callTool: async (_name, args = {}) => {
      calls.push(args);
      const a = answer(args);
      return typeof a === 'string' ? { text: a, isError: true } : { text: JSON.stringify(a), isError: false };
    },
  };
  return { client, calls };
}

const tool = (name: string, service = 'Slack', extra: Partial<DeclaredTool> = {}): DeclaredTool => ({ name, service, inputSchema: { type: 'object', properties: {} }, ...extra });

describe('declareTools', () => {
  it('declares each service in one call that names it, every tool as its server describes it', async () => {
    const p = platform();
    const full: DeclaredTool = {
      name: 'search',
      title: 'Search messages',
      description: 'x'.repeat(5_000),
      inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'y'.repeat(3_000) } }, required: ['q'] },
      outputSchema: { type: 'object', properties: { hits: { type: 'array' } } },
      annotations: { title: 'Search', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      service: 'Slack',
      calledAs: 'slack__search',
      server: { name: 'slack-mcp', version: '1.2.0', transport: 'http', host: 'mcp.slack.com' },
    };

    await declareTools(p.client, DID, [full, tool('send_message', 'Gmail'), tool('post')]);

    expect(p.calls.map((c) => c.services)).toEqual([['Slack'], ['Gmail']]);
    // nothing cut and nothing flattened: the platform caps, the same way for every agent
    expect(p.calls[0]).toEqual({ did: DID, tools: [full, tool('post')], services: ['Slack'] });
  });

  // @invariant
  it('never sends what the platform keeps nothing of', async () => {
    const p = platform();
    const withExtras = { ...tool('post'), icons: [{ src: 'data:image/png;base64,AAAA' }], _meta: { 'x/y': 1 } } as DeclaredTool;

    await declareTools(p.client, DID, [withExtras]);

    expect((p.calls[0]!.tools as Record<string, unknown>[])[0]).toEqual(tool('post'));
  });

  it('sends a service\'s first 500 tools and warns about the rest', async () => {
    const p = platform();
    const warnings: string[] = [];

    const [d] = await declareTools(p.client, DID, Array.from({ length: DECLARE_TOOLS_MAX + 1 }, (_, i) => tool(`t${i}`)), { onWarning: (m) => warnings.push(m) });

    expect((p.calls[0]!.tools as unknown[]).length).toBe(DECLARE_TOOLS_MAX);
    expect(d!.overLimit).toBe(1);
    expect(warnings).toEqual([`Slack has ${DECLARE_TOOLS_MAX + 1} tools; the first ${DECLARE_TOOLS_MAX} are declared, the rest are not`]);
  });

  it.each([
    ['the agent at its tool limit', { recorded: 1, skipped: [{ index: 1, name: 'b', reason: 'agent_tool_limit' }] }, /the agent is at its tool limit: 1 tool\(s\) of Slack were not declared \(b\)/],
    ['a malformed tool', { recorded: 1, skipped: [{ index: 1, name: 'b', reason: 'invalid_schema' }] }, /1 tool\(s\) of Slack were left out: b \(invalid_schema\)/],
    ['text cut to fit', { recorded: 2, capped: 1, skipped: [] }, /1 tool\(s\) of Slack had text over a size limit: recorded, cut to fit/],
  ])('warns about what the platform left out or cut, and the rest stands — %s', async (_case, answer, warning) => {
    const warnings: string[] = [];

    const [d] = await declareTools(platform(() => answer).client, DID, [tool('a'), tool('b')], { onWarning: (m) => warnings.push(m) });

    expect(warnings).toEqual([expect.stringMatching(warning)]);
    expect(d).toMatchObject({ service: 'Slack', recorded: answer.recorded });
  });

  it('declares a service with no tools, so the platform marks its tools no longer declared', async () => {
    const p = platform();

    await declareTools(p.client, DID, [], { emptyServices: ['Gmail'] });

    expect(p.calls).toEqual([{ did: DID, tools: [], services: ['Gmail'] }]);
  });

  it('throws when the platform refuses a service, after declaring the ones before it', async () => {
    const p = platform((args) => ((args.services as string[])[0] === 'Gmail' ? 'agent not found' : { recorded: 1 }));

    await expect(declareTools(p.client, DID, [tool('post'), tool('send', 'Gmail')])).rejects.toThrow('declare_tools refused for Gmail: agent not found');
    expect(p.calls.map((c) => c.services)).toEqual([['Slack'], ['Gmail']]);
  });
});
