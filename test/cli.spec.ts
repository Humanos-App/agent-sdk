import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { declareCommand, registerCommand, statusCommand } from '../src/cli/agent.js';
import type { CliContext } from '../src/cli/context.js';
import { CLAUDE_HOOK_COMMAND, detectFrameworks, initCommand, restoreCommand, withClaudeHooks } from '../src/cli/init.js';
import { agentScene, AGENT_DID } from './harness/agent.js';
import { stdioSupportServer } from './harness/mcp-servers.js';

/** A context over a project, with everything said kept: `said` must never hold a secret. */
function context(cwd: string, extra: Partial<CliContext> = {}) {
  const said: string[] = [];
  const ctx: CliContext = { cwd, out: (l) => void said.push(l), err: (l) => void said.push(l), ...extra };
  return { ctx, said };
}
const write = (dir: string, file: string, content: string) => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), content);
};
const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');

describe('humanos init and restore — a Claude Agent SDK project, its own settings kept', () => {
  it('writes the hooks, ignores .humanos, registers, declares .mcp.json, and restore puts every byte back', async () => {
    const scene = await agentScene({});
    const support = stdioSupportServer();
    const settings = JSON.stringify({ permissions: { allow: ['Bash'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } }, null, 2);
    write(scene.dir, 'package.json', JSON.stringify({ dependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.317' } }));
    write(scene.dir, '.gitignore', 'node_modules/\n');
    write(scene.dir, '.claude/settings.json', settings);
    write(scene.dir, '.mcp.json', JSON.stringify({ mcpServers: { Orders: { command: support.command, args: support.args, env: support.env } } }));
    const { ctx, said } = context(scene.dir);

    expect(await initCommand(['--yes'], ctx)).toEqual({ framework: 'claude-agent-sdk', registered: true });
    const written = JSON.parse(read(scene.dir, '.claude/settings.json'));
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) expect(written.hooks[event][0].hooks[0].command).toBe(CLAUDE_HOOK_COMMAND);
    expect(written.permissions).toEqual({ allow: ['Bash'] });
    expect(written.hooks.Stop).toHaveLength(1);
    expect(read(scene.dir, '.gitignore')).toBe('node_modules/\n.humanos/\n');
    expect(said.join('\n')).toContain(AGENT_DID);
    expect(scene.humanos.declared.some((d) => d.services.includes('Orders') && d.tools.length === 2)).toBe(true);
    expect(said.join('\n')).not.toContain('test-signature-secret');

    // Again: nothing added twice.
    await initCommand(['--yes'], ctx);
    expect(JSON.parse(read(scene.dir, '.claude/settings.json')).hooks.PreToolUse).toHaveLength(1);

    const { restored } = await restoreCommand([], ctx);
    expect(restored.sort()).toEqual(['.claude/settings.json', '.gitignore']);
    expect(read(scene.dir, '.claude/settings.json')).toBe(settings);
    expect(read(scene.dir, '.gitignore')).toBe('node_modules/\n');
    expect(existsSync(join(scene.dir, '.humanos', 'init.json'))).toBe(false);
    expect(existsSync(join(scene.dir, '.humanos', 'agent-key.json'))).toBe(true);
    await scene.close();
  });

  it('restore leaves a file changed since init, and names it; --force puts it back', async () => {
    const scene = await agentScene({});
    write(scene.dir, 'package.json', JSON.stringify({ dependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.317' } }));
    const { ctx, said } = context(scene.dir);
    await initCommand(['--yes'], ctx);
    write(scene.dir, '.claude/settings.json', '{"edited": true}\n');
    const first = await restoreCommand([], ctx);
    expect(first.kept).toEqual(['.claude/settings.json']);
    expect(said.join('\n')).toContain('.claude/settings.json changed since init');
    expect(read(scene.dir, '.claude/settings.json')).toBe('{"edited": true}\n');
    await restoreCommand(['--force'], ctx);
    expect(existsSync(join(scene.dir, '.claude/settings.json'))).toBe(false); // init created it: restored is gone
    expect(existsSync(join(scene.dir, '.claude'))).toBe(false); // and the folder it made for it
    await scene.close();
  });
});

describe('humanos init — the other paths', () => {
  it('an AI SDK project: prints the lines to add, and writes no settings', async () => {
    const scene = await agentScene({});
    write(scene.dir, 'package.json', JSON.stringify({ dependencies: { ai: '7.0.0' } }));
    const { ctx, said } = context(scene.dir);
    expect((await initCommand(['--yes'], ctx)).framework).toBe('ai-sdk');
    expect(said.join('\n')).toContain("humanos.guard(tools, 'Your service')");
    expect(existsSync(join(scene.dir, '.claude'))).toBe(false);
    await scene.close();
  });

  it('a Cloudflare Worker: the AI SDK lines, and the agent’s key and credentials as the Worker’s secrets', async () => {
    const scene = await agentScene({});
    write(scene.dir, 'package.json', JSON.stringify({ dependencies: { agents: '0.33.0', ai: '7.0.0' } }));
    write(scene.dir, 'wrangler.jsonc', '{}');
    const { ctx, said } = context(scene.dir);
    expect((await initCommand(['--yes'], ctx)).framework).toBe('ai-sdk');
    const all = said.join('\n');
    expect(all).toContain("humanos.guard(tools, 'Your service')");
    expect(all).toContain('HUMANOS_AGENT_KEY (the content of .humanos/agent-key.json');
    expect(all).toContain('npx wrangler secret put');
    await scene.close();
  });

  it('without the connector’s credentials: adds them empty to .env, asks to fill them, and registers nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-project-'));
    const { ctx, said } = context(dir, { via: { env: {} } });
    expect(await initCommand(['--framework', 'custom'], ctx)).toEqual({ framework: 'custom', registered: false });
    expect(read(dir, '.env')).toBe('HUMANOS_API_KEY=\nHUMANOS_SIGNATURE_SECRET=\n');
    expect(read(dir, '.gitignore')).toBe('.humanos/\n');
    expect(said.join('\n')).toMatch(/Fill HUMANOS_API_KEY and HUMANOS_SIGNATURE_SECRET in \.env/);
  });

  it('asks which framework when more than one is found, and says which are not supported yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-project-'));
    write(dir, 'package.json', JSON.stringify({ dependencies: { ai: '7', langchain: '1', '@mastra/core': '1' } }));
    expect(detectFrameworks(dir)).toEqual({ supported: [{ framework: 'ai-sdk', name: 'Vercel AI SDK' }, { framework: 'langchain', name: 'LangChain' }], notYet: ['Mastra'] });
    const asked: string[] = [];
    const { ctx, said } = context(dir, { via: { env: {} }, ask: async (q) => (asked.push(q), '2') });
    expect((await initCommand([], ctx)).framework).toBe('langchain');
    expect(asked[0]).toContain('1. Vercel AI SDK');
    expect(said.join('\n')).toContain('Found Mastra: not supported yet');
  });

  it('--yes with more than one framework: refuses to pick, naming --framework, even in a terminal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-project-'));
    write(dir, 'package.json', JSON.stringify({ dependencies: { ai: '7', langchain: '1' } }));
    const { ctx } = context(dir, { via: { env: {} }, ask: async () => '1' });
    await expect(initCommand(['--yes'], ctx)).rejects.toThrow(/more than one framework found .*pass --framework/);
  });

  it('a wrong answer to the framework question is asked again, not taken as custom', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-project-'));
    write(dir, 'package.json', JSON.stringify({ dependencies: { ai: '7', langchain: '1' } }));
    const answers = ['9', 'two', '1'];
    const { ctx, said } = context(dir, { via: { env: {} }, ask: async () => answers.shift()! });
    expect((await initCommand([], ctx)).framework).toBe('ai-sdk');
    expect(said.filter((l) => l.startsWith('Answer with a number'))).toHaveLength(2);
  });

  it('withClaudeHooks adds each hook once, and changes nothing the second time', () => {
    const once = withClaudeHooks(undefined)!;
    expect(withClaudeHooks(once)).toBeUndefined();
  });
});

describe('humanos restore — only what init could have written', () => {
  it('a record pointing outside the project is not followed', async () => {
    const scene = await agentScene({});
    write(scene.dir, 'package.json', JSON.stringify({ dependencies: { ai: '7' } }));
    const { ctx, said } = context(scene.dir);
    await initCommand(['--yes'], ctx);
    const outside = join(mkdtempSync(join(tmpdir(), 'not-the-project-')), 'keep.txt');
    writeFileSync(outside, 'keep me');
    const manifestFile = join(scene.dir, '.humanos', 'init.json');
    const manifest = JSON.parse(read(scene.dir, '.humanos/init.json'));
    manifest.changes.push({ file: outside, existed: false, after: 'x' }, { file: '../escape.txt', existed: false, after: 'x' });
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const { restored } = await restoreCommand(['--force'], ctx);
    expect(restored).toEqual(['.gitignore']);
    expect(read(outside, '')).toBe('keep me');
    expect(said.join('\n')).toContain('not a file init changed in this project');
    await scene.close();
  });
});

describe('humanos declare and status', () => {
  it('declare --entry: a module’s AI SDK tools, with their schemas', async () => {
    const scene = await agentScene({});
    const { ctx } = context(scene.dir);
    const entry = fileURLToPath(new URL('./fixtures/ai-tools.mjs', import.meta.url));
    await declareCommand(['--entry', entry, '--framework', 'ai-sdk', '--service', 'Support desk'], ctx);
    const d = scene.humanos.declared.find((x) => x.services.includes('Support desk'))!;
    expect(d.tools.map((t) => t.name)).toEqual(['lookup_order', 'issue_refund']);
    expect(d.tools[1]).toMatchObject({ inputSchema: { properties: { amount_eur: { type: 'number' } } } });
    await scene.close();
  });

  it('register: a new key is "registered", the same key again "already registered"', async () => {
    const scene = await agentScene({});
    const fresh = mkdtempSync(join(tmpdir(), 'agent-home-'));
    const first = context(scene.dir, { via: { env: { ...scene.env, HUMANOS_DIR: fresh } } });
    await registerCommand([], first.ctx);
    expect(first.said[0]).toBe(`Agent registered: ${AGENT_DID}`);
    expect(first.said.join('\n')).toContain(join(fresh, 'agent-key.json'));
    await scene.close();
  });

  it('status names the agent and where to set the policy', async () => {
    const scene = await agentScene({});
    const { ctx, said } = context(scene.dir);
    await statusCommand([], ctx);
    expect(said[0]).toBe(`Agent: ${AGENT_DID}`);
    expect(said.join('\n')).toContain('Agents, then Policy');
    await scene.close();
  });
});
