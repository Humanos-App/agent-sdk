// Starts the Worker locally (wrangler, workerd), asks it each case, prints what ran and what the agent said, stops it.
import { unstable_dev } from 'wrangler';

const worker = await unstable_dev('src/index.js', { config: 'wrangler.jsonc', experimental: { disableExperimentalWarning: true }, ip: '127.0.0.1', persist: false, logLevel: 'warn' });
try {
  for (const c of process.argv.slice(2).length ? process.argv.slice(2) : ['lookup']) {
    const out = await (await worker.fetch(`http://agent/?case=${c}`)).json();
    console.log(`=== ${c} (${out.runtime})`);
    for (const r of out.ran) console.log(`TOOL RAN: ${r}`);
    console.log(out.error ? `ERROR: ${out.error}` : `AGENT: ${out.text}`);
  }
} finally {
  await worker.stop();
}
