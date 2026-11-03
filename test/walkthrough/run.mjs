// The walkthroughs' runner: runs one command in an agent's project as that agent would run, with the test
// credentials (`test/.env`, else `test/live/.env`) handed to it under the names the product reads (HUMANOS_API_KEY,
// HUMANOS_SIGNATURE_SECRET, HUMANOS_MCP_URL, ANTHROPIC_API_KEY, OPENROUTER_API_KEY). The values never reach the output.
//
//   npm run walkthrough -- <agent project> <command> [args…]
//   npm run walkthrough -- --dev-vars <worker project>   writes the Worker's local secrets (.dev.vars, mode 600): the
//                                                         same variables, and HUMANOS_AGENT_KEY from .humanos/agent-key.json
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const devVars = process.argv[2] === '--dev-vars';
const [project, ...command] = process.argv.slice(devVars ? 3 : 2);
if (!project || (!devVars && !command.length)) {
  process.stderr.write('usage: npm run walkthrough -- <agent project> <command> [args…]\n');
  process.exit(2);
}
const file = ['../.env', '../live/.env'].map((p) => fileURLToPath(new URL(p, import.meta.url))).find((f) => existsSync(f));
if (!file) {
  process.stderr.write('walkthrough: no test/.env (or test/live/.env) with the HUMANOS_LIVE_* variables\n');
  process.exit(2);
}
const t = parseEnv(readFileSync(file, 'utf8'));
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('HUMANOS_')) delete env[k]; // only the test organization's, never a stray one
Object.assign(env, {
  HUMANOS_API_KEY: t.HUMANOS_LIVE_API_KEY ?? '',
  HUMANOS_SIGNATURE_SECRET: t.HUMANOS_LIVE_SIGNATURE_SECRET ?? '',
  HUMANOS_MCP_URL: t.HUMANOS_LIVE_MCP_URL ?? '',
  ...(t.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: t.ANTHROPIC_API_KEY } : {}),
  ...(t.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: t.OPENROUTER_API_KEY } : {}),
});
if (devVars) {
  // A Worker reads its secrets from bindings; locally wrangler takes them from .dev.vars. The agent's key goes as a
  // secret too, since a Worker has no disk: the key file's content, DID included.
  const key = readFileSync(`${project}/.humanos/agent-key.json`, 'utf8');
  // Single quotes: dotenv takes them literally, so the key's JSON arrives as it is.
  const vars = ['HUMANOS_API_KEY', 'HUMANOS_SIGNATURE_SECRET', 'HUMANOS_MCP_URL', 'ANTHROPIC_API_KEY'].filter((k) => env[k]).map((k) => `${k}='${env[k]}'`);
  writeFileSync(`${project}/.dev.vars`, [...vars, `HUMANOS_AGENT_KEY='${JSON.stringify(JSON.parse(key))}'`].join('\n') + '\n', { mode: 0o600 });
  process.stderr.write(`walkthrough: wrote ${project}/.dev.vars (${vars.length + 1} secrets; values not shown)\n`);
  process.exit(0);
}
process.stderr.write(`walkthrough: ${command.join(' ')} (in ${project}, against ${env.HUMANOS_MCP_URL || 'production'})\n`);
const r = spawnSync(command[0], command.slice(1), { cwd: project, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
