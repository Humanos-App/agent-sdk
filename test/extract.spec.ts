import { describe, expect, it } from 'vitest';
import { extractFromToolsList, type McpToolsList } from '../src/extract/mcp.js';

const LIST: McpToolsList = {
  serverName: 'carrier-sales',
  tools: [
    {
      name: 'book_load',
      description: 'Commit the broker to a carrier.\nSecond line: with a colon',
      inputSchema: {
        type: 'object',
        properties: {
          load_id: { type: 'string', pattern: '^L-[0-9]+$' },
          rate_usd: { type: 'number', description: 'Agreed rate.', minimum: 0, maximum: 10000 },
          equipment: { type: 'string', enum: ['van', 'reefer', 'flatbed', 'tanker'] },
          stops: { type: 'array', items: { type: 'object' } },
          carrier_mc: { type: 'string' },
        },
        required: ['load_id', 'rate_usd'],
      },
    },
    { name: 'yb_search_loads', notes: ['lane list is runtime-loaded'], inputSchema: { type: 'object', properties: { lane: { type: 'string' }, a_very_long_parameter_name_indeed: { type: 'boolean' } } } },
  ],
};

describe('extractFromToolsList — a guardrail DRAFT, never a policy (R8)', () => {
  const draft = extractFromToolsList(LIST);

  it('derives names, types and requiredness; userParams and rules are ALWAYS empty', () => {
    expect(draft.yaml).toContain('action_name: carrier-sales');
    expect(draft.yaml).toContain('load_id:    { type: string, required: true }');
    expect(draft.yaml).toContain('lane:       { type: string, required: false }');
    expect(draft.yaml).toMatch(/^userParams: \{\}/m);
    expect(draft.yaml).toMatch(/^rules: \[\]/m);
    // No constraint is ever guessed into the shape: no `<=`, no limit value, no enum list as YAML.
    expect(draft.yaml).not.toMatch(/<=|>=|\bmax:|\bmin:/);
  });

  it('keeps what §6.1 cannot carry as comments for the human AND a structured sidecar for tooling', () => {
    const book = draft.candidates.book_load!;
    expect(book.params.load_id).toBe('pattern:^L-[0-9]+$');
    expect(book.params.rate_usd).toBe('limit:0..10000');
    expect(book.params.equipment).toBe('enum:van|reefer|flatbed|tanker');
    expect(book.params.stops).toBe('shape:array-of-objects');
    expect(book.params.carrier_mc).toBeUndefined(); // nothing to say about a plain string
    expect(draft.yaml).toContain('# pattern ^L-[0-9]+$ → candidate rule (no param-level pattern in §6.1)');
    expect(draft.yaml).toContain('# enum van|reefer|flatbed|…(4) → candidate values rule');
    expect(draft.yaml).toContain('# candidate limit (numeric)');
  });

  it('classifies tools by the first verb TOKEN that matches, wherever it sits in a namespaced name', () => {
    expect(draft.candidates.book_load!.tool).toBe('step_up+agent_floor');
    expect(draft.candidates.yb_search_loads!.tool).toBe('advisory');
    expect(draft.yaml).toContain('# candidate: step_up + agent_floor (commit verb "book")');
    expect(draft.yaml).toContain('# candidate: advisory (read-only verb)');
  });

  it('emits YAML that survives real descriptions and long names (safari findings)', () => {
    // Newlines and `: ` in a description would misparse as a plain scalar — double-quoted instead.
    expect(draft.yaml).toContain('description: "Commit the broker to a carrier.\\nSecond line: with a colon"');
    // A name at/over the column width still gets its separating space before `{`.
    expect(draft.yaml).toMatch(/a_very_long_parameter_name_indeed: \{ type: boolean/);
    // Front-end notes ride along as comments.
    expect(draft.yaml).toContain('# note: lane list is runtime-loaded');
  });

  it('names its provenance per front-end, and is byte-stable for the same input', () => {
    expect(extractFromToolsList(LIST, { source: 'typebox' }).yaml).toContain('# from TypeScript static scan (TypeBox tools)');
    expect(extractFromToolsList(LIST).yaml).toBe(draft.yaml);
  });
});
