/**
 * `humanos-agent init` and `restore`.
 *
 * `init`: the framework (found in `package.json`, confirmed or chosen), the connector's credentials in `.env`, the
 * agent registered, the MCP servers in `.mcp.json` declared, and the interception: for Claude Agent SDK the hook
 * commands in `.claude/settings.json`, so the agent's code does not change; for the others the lines to add, printed.
 *
 * Every file `init` changes is recorded in `.humanos/init.json`, with a copy of what it held before, so `restore`
 * puts each back byte for byte. A file changed since `init` is left as it is and named, unless `--force`.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { agentDir, environment } from '../via.js';
import { declareCommand, registerCommand } from './agent.js';
import { flag, parseFlags, type CliContext } from './context.js';

export type Framework = 'ai-sdk' | 'claude-agent-sdk' | 'langchain' | 'custom';

/** The package that says which framework an agent is built on, and what wave 1 supports for it. */
const DETECTED: { pkg: string; framework: Framework; name: string }[] = [
  { pkg: '@anthropic-ai/claude-agent-sdk', framework: 'claude-agent-sdk', name: 'Claude Agent SDK' },
  { pkg: 'ai', framework: 'ai-sdk', name: 'Vercel AI SDK' },
  { pkg: 'agents', framework: 'ai-sdk', name: 'Cloudflare Agents (AI SDK)' },
  { pkg: '@openrouter/ai-sdk-provider', framework: 'ai-sdk', name: 'OpenRouter (AI SDK)' },
  { pkg: 'langchain', framework: 'langchain', name: 'LangChain' },
  { pkg: '@langchain/langgraph', framework: 'langchain', name: 'LangGraph' },
  { pkg: '@langchain/core', framework: 'langchain', name: 'LangChain' },
];
/** Frameworks found but not supported yet: the agent takes the custom path. */
const NOT_YET: Record<string, string> = {
  '@mastra/core': 'Mastra',
  '@openai/agents': 'OpenAI Agents SDK',
  '@google/adk': 'Google ADK',
  '@strands-agents/sdk': 'Strands Agents',
  genkit: 'Genkit',
  '@openrouter/sdk': 'OpenRouter SDK',
};

/** The `PreToolUse` / `PostToolUse` / `PostToolUseFailure` command `init` writes for Claude Agent SDK. */
export const CLAUDE_HOOK_COMMAND = 'npx --no-install humanos-agent hook claude';
const CLAUDE_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'] as const;

interface Change {
  /** The file, from the project. */
  file: string;
  /** It existed before `init`: `backup` holds what it held. */
  existed: boolean;
  backup?: string;
  /** What `init` left in it (sha256), to tell whether it changed since. */
  after: string;
}
interface Manifest {
  version: 1;
  framework: Framework;
  changes: Change[];
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The frameworks the project's dependencies name, supported ones first. */
export function detectFrameworks(cwd: string): { supported: { framework: Framework; name: string }[]; notYet: string[] } {
  const file = join(cwd, 'package.json');
  if (!existsSync(file)) return { supported: [], notYet: [] };
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...pkg.devDependencies, ...pkg.dependencies };
  const supported: { framework: Framework; name: string }[] = [];
  for (const d of DETECTED) if (deps[d.pkg] && !supported.some((s) => s.framework === d.framework)) supported.push({ framework: d.framework, name: d.name });
  return { supported, notYet: Object.entries(NOT_YET).filter(([p]) => deps[p]).map(([, n]) => n) };
}

export async function initCommand(argv: string[], ctx: CliContext): Promise<{ framework: Framework; registered: boolean }> {
  const { flags } = parseFlags(argv);
  const yes = flags.yes === true;
  const framework = await chooseFramework(ctx, flag(flags, 'framework') as Framework | undefined, yes);
  const home = agentDir(ctx.via?.env ?? environment(ctx.cwd), ctx.cwd, ctx.via?.dir);
  const manifest = readManifest(home) ?? { version: 1, framework, changes: [] };
  manifest.framework = framework;
  const change = (file: string, write: (current: string | undefined) => string | undefined) => record(ctx.cwd, home, manifest, file, write);

  // The connector's credentials: present in .env, or added empty for the person to fill.
  const env = ctx.via?.env ?? environment(ctx.cwd);
  const missing = ['HUMANOS_API_KEY', 'HUMANOS_SIGNATURE_SECRET'].filter((k) => !env[k]);
  if (missing.length) {
    change('.env', (current = '') => {
      const absent = missing.filter((k) => !new RegExp(`^${k}=`, 'm').test(current));
      return absent.length ? `${current}${current && !current.endsWith('\n') ? '\n' : ''}${absent.map((k) => `${k}=`).join('\n')}\n` : undefined;
    });
  }
  change('.gitignore', (current = '') => (/^\.humanos\/?$/m.test(current) ? undefined : `${current}${current && !current.endsWith('\n') ? '\n' : ''}.humanos/\n`));
  if (missing.length) {
    saveManifest(home, manifest);
    ctx.out(`Fill ${missing.join(' and ')} in .env (the dashboard's API Keys page: https://app.humanos.tech), then run \`humanos-agent init\` again.`);
    return { framework, registered: false };
  }

  const v = await registerCommand([], ctx);
  if (existsSync(join(ctx.cwd, '.mcp.json'))) await declareCommand(['--mcp', '.mcp.json'], ctx, v);

  if (framework === 'claude-agent-sdk') {
    change(join('.claude', 'settings.json'), (current) => withClaudeHooks(current));
    ctx.out('Hooks written to .claude/settings.json: every tool call is checked, built-in tools too, with no change to the agent’s code.');
    ctx.out('If the agent passes `settingSources: []`, add the hooks in code: `hooks: (await claudeAgentSdk()).gate()` from @humanos/agent-sdk/claude-agent-sdk.');
  } else {
    ctx.out('Add to the agent’s code:');
    for (const line of SNIPPETS[framework]) ctx.out(`  ${line}`);
  }
  if (isWorker(ctx.cwd)) for (const line of WORKER_SECRETS) ctx.out(line);
  saveManifest(home, manifest);
  ctx.out('Until this agent’s policy is set, every call is allowed and recorded. Set it in the dashboard: Agents, then Policy.');
  ctx.out('Undo every file change: `humanos-agent restore`.');
  return { framework, registered: true };
}

const SNIPPETS: Record<Exclude<Framework, 'claude-agent-sdk'>, string[]> = {
  'ai-sdk': [
    "import { aiSdk } from '@humanos/agent-sdk/ai-sdk';",
    'const humanos = await aiSdk();',
    "generateText({ model, tools: humanos.guard(tools, 'Your service'), prompt });  // or streamText, ToolLoopAgent",
  ],
  langchain: [
    "import { langchain } from '@humanos/agent-sdk/langchain';",
    'const humanos = await langchain();',
    "createAgent({ model, tools, middleware: [humanos.gate({ service: 'Your service' })] });",
  ],
  custom: [
    "import { via } from '@humanos/agent-sdk';",
    'const humanos = await via();',
    "humanos.tools.add([{ name, description, inputSchema, service: 'Your service' }]);  // once, for each tool",
    'await humanos.guard.call(name, args, (a) => runTheTool(a));  // around every call',
  ],
};

/**
 * A Worker (Cloudflare Agents) reads its variables from its bindings and has no disk: the agent's key cannot be the
 * file `init` wrote, so it goes as a secret, with the connector's credentials. `nodejs_compat` puts them in
 * `process.env`, where the adapter's `via()` reads them.
 */
const WORKER_SECRETS = [
  'This is a Worker: it has no disk, so give it its Humanos values as secrets: HUMANOS_API_KEY, HUMANOS_SIGNATURE_SECRET,',
  'and HUMANOS_AGENT_KEY (the content of .humanos/agent-key.json: the agent itself, so the same key on every deploy).',
  '  Locally: in .dev.vars. Deployed: npx wrangler secret put <NAME>, for each. Keep the nodejs_compat flag on.',
];

/** A Cloudflare Worker project: a wrangler config, or Cloudflare Agents in its dependencies. */
function isWorker(cwd: string): boolean {
  if (['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].some((f) => existsSync(join(cwd, f)))) return true;
  const file = join(cwd, 'package.json');
  if (!existsSync(file)) return false;
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  return !!{ ...pkg.devDependencies, ...pkg.dependencies }.agents;
}

async function chooseFramework(ctx: CliContext, given: Framework | undefined, yes: boolean): Promise<Framework> {
  if (given) {
    if (!['ai-sdk', 'claude-agent-sdk', 'langchain', 'custom'].includes(given)) throw new Error(`--framework is one of ai-sdk, claude-agent-sdk, langchain, custom (got ${given})`);
    return given;
  }
  const { supported, notYet } = detectFrameworks(ctx.cwd);
  for (const n of notYet) ctx.out(`Found ${n}: not supported yet, so it takes the custom path.`);
  if (supported.length === 1 && (yes || !ctx.ask)) return supported[0]!.framework;
  if (!supported.length && (yes || !ctx.ask)) return 'custom';
  if (!ctx.ask) throw new Error(`more than one framework found (${supported.map((s) => s.name).join(', ')}): pass --framework`);
  const options: { framework: Framework; name: string }[] = [...supported, { framework: 'custom', name: 'Custom (my own code)' }];
  if (supported.length === 1) {
    const answer = await ctx.ask(`This agent is built on ${supported[0]!.name}? [Y/n]`);
    if (!/^n/i.test(answer)) return supported[0]!.framework;
  }
  const answer = await ctx.ask(`Which framework is the agent built on?\n${options.map((o, i) => `  ${i + 1}. ${o.name}`).join('\n')}\n>`);
  return options[Number(answer) - 1]?.framework ?? 'custom';
}

/** The settings with Humanos's hook commands added for each event, once; every other setting and hook kept. */
export function withClaudeHooks(current: string | undefined): string | undefined {
  const settings = (current ? JSON.parse(current) : {}) as { hooks?: Record<string, { matcher?: string; hooks: { type: string; command?: string }[] }[]> };
  const hooks = (settings.hooks ??= {});
  let added = false;
  for (const event of CLAUDE_HOOK_EVENTS) {
    const matchers = (hooks[event] ??= []);
    if (matchers.some((m) => m.hooks.some((h) => h.command === CLAUDE_HOOK_COMMAND))) continue;
    matchers.unshift({ matcher: '*', hooks: [{ type: 'command', command: CLAUDE_HOOK_COMMAND }] });
    added = true;
  }
  return added ? `${JSON.stringify(settings, null, 2)}\n` : undefined;
}

/** Change one file through `write` (undefined: no change), keeping what it held before the first `init`. */
function record(cwd: string, home: string, manifest: Manifest, file: string, write: (current: string | undefined) => string | undefined): void {
  const path = resolve(cwd, file);
  const existed = existsSync(path);
  const next = write(existed ? readFileSync(path, 'utf8') : undefined);
  if (next === undefined) return;
  let entry = manifest.changes.find((c) => c.file === file);
  if (!entry) {
    entry = { file, existed, after: '' };
    if (existed) {
      mkdirSync(join(home, 'backup'), { recursive: true, mode: 0o700 });
      entry.backup = relative(home, join(home, 'backup', `${manifest.changes.length}-${basename(file)}`));
      copyFileSync(path, join(home, entry.backup));
    }
    manifest.changes.push(entry);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  entry.after = sha(path);
}

function readManifest(home: string): Manifest | undefined {
  const file = join(home, 'init.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Manifest) : undefined;
}

function saveManifest(home: string, manifest: Manifest): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'init.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Removes `dir` and its parents up to `stop` while they are empty: only folders that held nothing but what was removed. */
function removeEmptyParents(dir: string, stop: string): void {
  for (let d = dir; d !== stop && d.startsWith(stop) && existsSync(d) && readdirSync(d).length === 0; d = dirname(d)) rmdirSync(d);
}

/** Every file `init` changed, put back as it was; one changed since `init` is left and named, unless `--force`. */
export async function restoreCommand(argv: string[], ctx: CliContext): Promise<{ restored: string[]; kept: string[] }> {
  const force = parseFlags(argv).flags.force === true;
  const home = agentDir(ctx.via?.env ?? environment(ctx.cwd), ctx.cwd, ctx.via?.dir);
  const manifest = readManifest(home);
  if (!manifest) {
    ctx.out('Nothing to restore: `humanos-agent init` has not changed any file here.');
    return { restored: [], kept: [] };
  }
  const restored: string[] = [];
  const kept: Change[] = [];
  for (const c of manifest.changes) {
    const path = resolve(ctx.cwd, c.file);
    if (existsSync(path) && sha(path) !== c.after && !force) {
      kept.push(c);
      ctx.err(`${c.file} changed since init: left as it is (restore it with --force)`);
      continue;
    }
    if (c.existed && c.backup) copyFileSync(join(home, c.backup), path);
    else {
      rmSync(path, { force: true });
      removeEmptyParents(dirname(path), resolve(ctx.cwd)); // the folder `init` made for it (`.claude/`), when nothing else is there
    }
    restored.push(c.file);
  }
  if (kept.length) saveManifest(home, { ...manifest, changes: kept });
  else {
    rmSync(join(home, 'init.json'), { force: true });
    rmSync(join(home, 'backup'), { recursive: true, force: true });
  }
  for (const f of restored) ctx.out(`Restored ${f}`);
  ctx.out('The agent’s key stays in .humanos: it is the agent. Delete it only to retire the agent.');
  return { restored, kept: kept.map((c) => c.file) };
}
