// Makes a walkthrough project: a fresh copy of one framework's agent (test/walkthrough/agents/<framework>), with this
// repo's agent-sdk installed as a developer installs it (`npm pack`, so exactly what npm would publish) and
// `@humanos-ai/via-sdk` from npm. Then run its steps with `npm run walkthrough -- <dir> …` (docs/TESTING.md).
//
//   npm run walkthrough:setup -- <framework> [dir]      framework: claude-agent-sdk | ai-sdk | langchain | openrouter | cloudflare
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const frameworks = readdirSync(here('./agents'));
const [framework, target] = process.argv.slice(2);
if (!framework || !frameworks.includes(framework)) {
  process.stderr.write(`usage: npm run walkthrough:setup -- <${frameworks.join(' | ')}> [dir]\n`);
  process.exit(2);
}
const dir = target ? resolve(target) : mkdtempSync(join(tmpdir(), `walkthrough-${framework}-`));
if (existsSync(join(dir, 'package.json'))) {
  process.stderr.write(`walkthrough: ${dir} already holds a project; give an empty directory\n`);
  process.exit(2);
}

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
cpSync(here(`./agents/${framework}`), dir, { recursive: true });
cpSync(here('./cases.mjs'), join(dir, 'cases.mjs'));
writeFileSync(join(dir, '.gitignore'), framework === 'cloudflare' ? 'node_modules/\n.dev.vars\n.wrangler/\n' : 'node_modules/\n');

// What npm would publish: the build of this checkout, packed.
const tarball = run('npm', ['pack', '--pack-destination', dir, '--silent'], here('../..')).trim().split('\n').at(-1);
// With the template's own framework dependencies, which `npm install` takes from its package.json.
run('npm', ['install', '--silent', `./${tarball}`, '@humanos-ai/via-sdk'], dir);

process.stdout.write(`walkthrough: ${framework} agent ready in ${dir}
Next (from the agent-sdk checkout):
  npm run walkthrough -- ${dir} npx --no-install humanos init
${framework === 'cloudflare' ? `  npm run walkthrough -- --dev-vars ${dir}\n  npm run walkthrough -- ${dir} node run-cases.mjs lookup refund discount5 discount15\n` : framework === 'claude-agent-sdk' ? `  npm run walkthrough -- ${dir} node agent.mjs\n` : `  npm run walkthrough -- ${dir} node agent.mjs <lookup|refund|discount5|discount15>\n`}  npm run walkthrough -- ${dir} npx --no-install humanos restore
`);
