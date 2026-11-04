/**
 * `humanos init` and `restore`.
 *
 * `init`: the framework (found in `package.json`, confirmed or chosen once, then kept), the connector's credentials in
 * `.env`, the agent registered, the MCP servers in `.mcp.json` declared, and the interception: for Claude Agent SDK
 * the hook commands in `.claude/settings.json`, so the agent's code does not change; for the others the lines to add,
 * printed.
 *
 * Every file `init` changes is recorded in `.humanos/init.json`, with a copy of what it held before, so `restore`
 * puts each back byte for byte. A file changed since `init` is left as it is and named, unless `--force`.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { agentDir, environment } from '../via.js';
import { declareCommand, registerCommand } from './agent.js';
import { flag, parseFlags, type CliContext } from './context.js';

export type Framework = 'ai-sdk' | 'claude-agent-sdk' | 'langchain' | 'custom';

const FRAMEWORKS: readonly Framework[] = ['ai-sdk', 'claude-agent-sdk', 'langchain', 'custom'];
const NAMES: Record<Framework, string> = { 'ai-sdk': 'Vercel AI SDK', 'claude-agent-sdk': 'Claude Agent SDK', langchain: 'LangChain', custom: 'Custom (my own code)' };

/**
 * The package that says which framework an agent is built on, and what wave 1 supports for it. The first match names
 * the framework, so a package built on AI SDK (Cloudflare Agents, OpenRouter's provider) comes before `ai` itself.
 */
const DETECTED: { pkg: string; framework: Framework; name: string }[] = [
  { pkg: '@anthropic-ai/claude-agent-sdk', framework: 'claude-agent-sdk', name: 'Claude Agent SDK' },
  { pkg: 'agents', framework: 'ai-sdk', name: 'Cloudflare Agents (AI SDK)' },
  { pkg: '@openrouter/ai-sdk-provider', framework: 'ai-sdk', name: 'OpenRouter (AI SDK)' },
  { pkg: 'ai', framework: 'ai-sdk', name: NAMES['ai-sdk'] },
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
export const CLAUDE_HOOK_COMMAND = 'npx --no-install humanos hook claude';
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

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
const packageOf = (cwd: string): PackageJson | undefined => {
  const file = join(cwd, 'package.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as PackageJson) : undefined;
};
const dependenciesOf = (pkg: PackageJson | undefined): Record<string, string> => ({ ...pkg?.devDependencies, ...pkg?.dependencies });

/** The frameworks the project's dependencies name, supported ones first. */
export function detectFrameworks(cwd: string): { supported: { framework: Framework; name: string }[]; notYet: string[] } {
  const pkg = packageOf(cwd);
  if (!pkg) return { supported: [], notYet: [] };
  const deps = dependenciesOf(pkg);
  const supported: { framework: Framework; name: string }[] = [];
  for (const d of DETECTED) if (deps[d.pkg] && !supported.some((s) => s.framework === d.framework)) supported.push({ framework: d.framework, name: d.name });
  return { supported, notYet: Object.entries(NOT_YET).filter(([p]) => deps[p]).map(([, n]) => n) };
}

export async function initCommand(argv: string[], ctx: CliContext): Promise<{ framework: Framework; registered: boolean }> {
  const { flags } = parseFlags(argv);
  const yes = flags.yes === true;
  const home = agentDir(ctx.via?.env ?? environment(ctx.cwd), ctx.cwd, ctx.via?.dir);
  const saved = readManifest(home);
  const framework = await chooseFramework(ctx, flag(flags, 'framework') as Framework | undefined, yes, saved?.framework);
  const manifest = saved ?? { version: 1, framework, changes: [] };
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
    ctx.out(`Fill ${missing.join(' and ')} in .env (the dashboard's API Keys page: https://app.humanos.tech), then run \`npx humanos init\` again.`);
    return { framework, registered: false };
  }

  const v = await registerCommand([], ctx);
  if (existsSync(join(ctx.cwd, '.mcp.json'))) await declareCommand(['--mcp', '.mcp.json'], ctx, v);

  if (framework === 'claude-agent-sdk') {
    change(join('.claude', 'settings.json'), (current) => withClaudeHooks(current));
    ctx.out('Hooks written to .claude/settings.json: every tool call is checked, built-in tools too, with no change to the agent’s code.');
    ctx.out('Claude Code reads the same file: a `claude` session in this folder is checked too, as this agent.');
    ctx.out('If the agent passes `settingSources: []`, add the hooks in code: `hooks: (await claudeAgentSdk()).gate()` from @humanos-ai/agent-sdk/claude-agent-sdk.');
  } else {
    for (const line of codeToAdd(framework, defaultService(ctx.cwd))) ctx.out(line);
  }
  if (isWorker(ctx.cwd)) for (const line of WORKER_SECRETS) ctx.out(line);
  saveManifest(home, manifest);
  ctx.out('Until this agent’s policy is set, every call is allowed and recorded. Set it in the dashboard: Agents, then Policy.');
  ctx.out('Undo every file change: `npx humanos restore`.');
  return { framework, registered: true };
}

/** The service the printed lines name, for the person to keep or change: the package's name (its scope dropped), else the folder's. */
function defaultService(cwd: string): string {
  return (packageOf(cwd)?.name?.replace(/^@[^/]+\//, '') || basename(resolve(cwd))).replace(/['\\]/g, '');
}

/**
 * What to add to the agent's code: the lines that make its Humanos, then the one change to the code it already has
 * (the call that hands the model its tools), then what the service it names is.
 */
function codeToAdd(framework: Exclude<Framework, 'claude-agent-sdk'>, service: string): string[] {
  const s = `'${service}'`;
  const lines = {
    'ai-sdk': [
      'Add to the agent’s code:',
      "  import { aiSdk } from '@humanos-ai/agent-sdk/ai-sdk';",
      '  const humanos = await aiSdk();',
      'Then, in your generateText or streamText call (or your ToolLoopAgent), pass your tools through Humanos:',
      `  tools: humanos.guard(tools, ${s}),`,
    ],
    langchain: [
      'Add to the agent’s code:',
      "  import { langchain } from '@humanos-ai/agent-sdk/langchain';",
      '  const humanos = await langchain();',
      'Then, in your createAgent call, add Humanos as middleware:',
      `  middleware: [humanos.gate({ service: ${s} })],`,
      `In a LangGraph graph of your own, guard your ToolNode's tools instead: new ToolNode(humanos.guard(tools, ${s})).`,
    ],
    custom: [
      'Add to the agent’s code:',
      "  import { via } from '@humanos-ai/agent-sdk';",
      '  const humanos = await via();',
      'Declare your tools once, when the agent starts:',
      `  await humanos.tools.add([{ name, description, inputSchema, service: ${s} }]);`,
      'Then run every tool call through the guard (it throws ViaDeniedError when Humanos refuses the call):',
      '  const { result } = await humanos.guard.call(name, args, (a) => runTheTool(a));',
    ],
  }[framework];
  return [...lines, `${s} is the service: the dashboard lists these tools under it (the system they belong to, like 'Support desk'). Any name works; set it before the agent's first run, when its tools are declared.`];
}

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
  return !!dependenciesOf(packageOf(cwd)).agents;
}

/**
 * The framework: `--framework`; else the answer an earlier `init` here kept in `.humanos/init.json` (one that stopped
 * for `.env`, or ran before), so it is not asked again; else found in `package.json`, confirmed or chosen.
 */
async function chooseFramework(ctx: CliContext, given: Framework | undefined, yes: boolean, answered: Framework | undefined): Promise<Framework> {
  if (given) {
    if (!FRAMEWORKS.includes(given)) throw new Error(`--framework is one of ${FRAMEWORKS.join(', ')} (got ${given})`);
    return given;
  }
  if (answered && FRAMEWORKS.includes(answered)) {
    const name = detectFrameworks(ctx.cwd).supported.find((s) => s.framework === answered)?.name ?? NAMES[answered];
    ctx.out(`Framework: ${name}, as answered before (\`--framework\` changes it).`);
    return answered;
  }
  const { supported, notYet } = detectFrameworks(ctx.cwd);
  for (const n of notYet) ctx.out(`Found ${n}: not supported yet, so it takes the custom path.`);
  if (supported.length === 1 && (yes || !ctx.ask)) return supported[0]!.framework;
  if (!supported.length && (yes || !ctx.ask)) return 'custom';
  // More than one: `--yes` cannot pick for you, and nobody can answer without a terminal.
  if (yes || !ctx.ask) throw new Error(`more than one framework found (${supported.map((s) => s.name).join(', ')}): pass --framework`);
  const options: { framework: Framework; name: string }[] = [...supported, { framework: 'custom', name: NAMES.custom }];
  if (supported.length === 1) {
    const answer = await ctx.ask(`This agent is built on ${supported[0]!.name}? [Y/n]`);
    if (!/^n/i.test(answer)) return supported[0]!.framework;
  }
  const question = `Which framework is the agent built on?\n${options.map((o, i) => `  ${i + 1}. ${o.name}`).join('\n')}\n>`;
  for (let tries = 0; tries < 3; tries++) {
    const choice = options[Number(await ctx.ask(question)) - 1];
    if (choice) return choice.framework;
    ctx.out(`Answer with a number from 1 to ${options.length}.`);
  }
  throw new Error('no framework chosen: pass --framework');
}

/** True when `path` is inside `dir` (never `dir` itself, never outside it). */
function inside(dir: string, path: string): boolean {
  const r = relative(resolve(dir), resolve(path));
  return !!r && !r.startsWith('..') && !isAbsolute(r);
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
    ctx.out('Nothing to restore: `humanos init` has not changed any file here.');
    return { restored: [], kept: [] };
  }
  const restored: string[] = [];
  const kept: Change[] = [];
  for (const c of manifest.changes) {
    const path = resolve(ctx.cwd, c.file);
    // Only what `init` could have written: a file in the project, its copy in the agent's directory. A record that
    // points anywhere else is not followed.
    if (!inside(ctx.cwd, path) || (c.backup !== undefined && !inside(home, join(home, c.backup)))) {
      ctx.err(`${c.file}: not a file init changed in this project; left as it is`);
      continue;
    }
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
