// The no-code walkthrough's runner: runs one command in an agent's project as that agent would run, with the test
// credentials (`test/.env`, else `test/live/.env`) handed to it under the names the product reads (HUMANOS_API_KEY,
// HUMANOS_SIGNATURE_SECRET, HUMANOS_MCP_URL, ANTHROPIC_API_KEY). The values never reach the output.
//
//   npm run walkthrough -- <agent project> <command> [args…]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const [project, ...command] = process.argv.slice(2);
if (!project || !command.length) {
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
});
process.stderr.write(`walkthrough: ${command.join(' ')} (in ${project}, against ${env.HUMANOS_MCP_URL || 'production'})\n`);
const r = spawnSync(command[0], command.slice(1), { cwd: project, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
