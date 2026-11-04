import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Builds dist/ once before the framework tests: a routed stdio entry runs the built CLI (`dist/bin/humanos.js`). */
export default function setup(): void {
  execSync('npm run build', { cwd: fileURLToPath(new URL('../..', import.meta.url)), stdio: 'ignore' });
}
