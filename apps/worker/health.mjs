import { readFile } from 'node:fs/promises';
try {
  const last = Number(await readFile('/tmp/lightning-worker-heartbeat', 'utf8'));
  process.exit(Number.isFinite(last) && Date.now() - last < 90000 ? 0 : 1);
} catch { process.exit(1); }
