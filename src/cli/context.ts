/** What every `humanos-agent` command runs in: the project, its environment, where it writes, and how it asks. */
import { createInterface } from 'node:readline/promises';
import type { ViaOptions } from '../via.js';

export interface CliContext {
  /** The agent's project. */
  cwd: string;
  /** Lines for the person running the command. Never a secret's value. */
  out(line: string): void;
  /** Problems, on stderr. */
  err(line: string): void;
  /** Ask the person; absent when nobody can answer (CI, `--yes`). */
  ask?(question: string): Promise<string>;
  /** Overrides for `via()` (tests: the connector, the key). */
  via?: ViaOptions;
}

export function processContext(): CliContext {
  return {
    cwd: process.cwd(),
    out: (line) => void process.stdout.write(`${line}\n`),
    err: (line) => void process.stderr.write(`${line}\n`),
    ...(process.stdin.isTTY
      ? {
          ask: async (question: string) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
              return (await rl.question(`${question} `)).trim();
            } finally {
              rl.close();
            }
          },
        }
      : {}),
  };
}

/** `--name value` and bare `--flag` options, and what is left. */
export function parseFlags(argv: string[]): { flags: Record<string, string | true>; rest: string[] } {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[a.slice(2)] = next;
      i++;
    } else flags[a.slice(2)] = true;
  }
  return { flags, rest };
}

export const flag = (flags: Record<string, string | true>, name: string): string | undefined => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined);
