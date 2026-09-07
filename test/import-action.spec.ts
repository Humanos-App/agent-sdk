import { describe, it, expect } from 'vitest';
import { importActionDraft, toWireTools } from '../src/platform/import-action.js';
import { signRequest } from '../src/mcp/client.js';
import type { McpToolsList } from '../src/extract/mcp.js';

const LIST: McpToolsList = {
  serverName: 'carrier-sales',
  tools: [
    {
      name: 'book_load',
      description: 'Commit the broker to a carrier.',
      inputSchema: {
        type: 'object',
        properties: {
          load_id: { type: 'string' },
          rate_usd: { type: 'number', description: 'Agreed rate.' },
        },
        required: ['load_id', 'rate_usd'],
      },
    },
    {
      name: 'search_loads',
      inputSchema: { type: 'object', properties: { lane: { type: 'string' } } },
    },
  ],
};

function stub(status = 200, payload: unknown = { actionId: 'a1', versionId: 'urn:v1', created: true }) {
  const seen: { url: string; body: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string, opts: { body: string; headers: Record<string, string> }) => {
    seen.push({ url, body: opts.body, headers: opts.headers });
    return {
      ok: status < 400,
      status,
      json: async () => payload,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    };
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe('importActionDraft', () => {
  it('flattens JSON Schema into the flat param shape, marking required', () => {
    // The platform stores {type, description, required} per param and does not parse JSON Schema,
    // so the flattening has to happen here.
    const [book, search] = toWireTools(LIST);
    expect(book!.params.load_id).toEqual({ type: 'string', required: true });
    expect(book!.params.rate_usd).toEqual({ type: 'number', description: 'Agreed rate.', required: true });
    // Absent from `required` means absent from the object, not `required: false`.
    expect(search!.params.lane).toEqual({ type: 'string' });
  });

  it('signs the EXACT bytes it posts, with the org key', async () => {
    const { impl, seen } = stub();
    await importActionDraft(LIST, {
      baseUrl: 'https://api.example.test/',
      apiKey: 'key-123',
      signatureSecret: 'secret',
      did: 'did:key:zAgent',
      name: 'carrier-sales',
      fetchImpl: impl,
      now: () => 1757160000000,
    });

    const { url, body, headers } = seen[0]!;
    // Trailing slash on baseUrl must not produce a double slash in the path.
    expect(url).toBe('https://api.example.test/agents/did%3Akey%3AzAgent/actions');
    expect(headers.Authorization).toBe('Bearer key-123');
    expect(headers['x-signature']).toBe(signRequest(body, 'secret', 1757160000000));
    // Same signing function as the MCP client, so the two cannot drift apart.
  });

  it('sends NO rules and NO userParams — policy is the org\'s to author', async () => {
    const { impl, seen } = stub();
    await importActionDraft(LIST, {
      baseUrl: 'https://api.example.test',
      apiKey: 'k', signatureSecret: 's', did: 'did:key:zA', name: 'x', fetchImpl: impl,
    });
    const sent = JSON.parse(seen[0]!.body);
    expect(sent).not.toHaveProperty('rules');
    expect(sent).not.toHaveProperty('userParams');
    expect(sent.tools).toHaveLength(2);
  });

  it('carries the platform\'s refusal text, not just a status', async () => {
    // "that DID is not your agent" and "no tools to import" are worth reading; a bare 400 is not.
    const { impl } = stub(400, 'Resource references an unpublished action version');
    await expect(
      importActionDraft(LIST, {
        baseUrl: 'https://api.example.test',
        apiKey: 'k', signatureSecret: 's', did: 'did:key:zA', name: 'x', fetchImpl: impl,
      }),
    ).rejects.toThrow(/HTTP 400 — .*unpublished/);
  });

  it('declares the grantor\'s side: grantorRoles mark tool params role grantor; grantorParams ride the body', async () => {
    // v0.3 §16.14 — shape, not policy. The builder says WHERE a limit will live (userParams), never
    // what it is; the platform lands `channels` as a userParam declaration and echoes `suggested`.
    const { impl, seen } = stub(200, { actionId: 'a1', versionId: 'urn:v1', created: true, userParams: ['channels', 'rate_cap'], executionParams: ['tool', 'load_id', 'lane'], suggested: { channels: ['C0'] } });
    const r = await importActionDraft(LIST, {
      baseUrl: 'https://api.example.test', apiKey: 'k', signatureSecret: 's', did: 'did:key:zA', name: 'x', fetchImpl: impl,
      grantorRoles: ['rate_usd'],
      grantorParams: { channels: { type: 'array', items: 'string', description: 'Allowed channels', suggested: ['C0'] } },
    });
    const sent = JSON.parse(seen[0]!.body);
    expect(sent.tools[0].params.rate_usd).toEqual({ type: 'number', description: 'Agreed rate.', required: true, role: 'grantor' });
    expect(sent.tools[0].params.load_id).not.toHaveProperty('role');
    expect(sent.grantorParams).toEqual({ channels: { type: 'array', items: 'string', description: 'Allowed channels', suggested: ['C0'] } });
    // Still no rules: roles say where, never what.
    expect(sent).not.toHaveProperty('rules');
    expect(r.userParams).toEqual(['channels', 'rate_cap']);
    expect(r.suggested).toEqual({ channels: ['C0'] });
  });

  it('without grantorRoles no param carries a role — the wire stays exactly what it was', () => {
    for (const tool of toWireTools(LIST)) for (const p of Object.values(tool.params)) expect(p).not.toHaveProperty('role');
  });
});
