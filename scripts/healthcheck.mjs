import { readFile } from 'node:fs/promises';
try {
  if (process.argv[2] === 'web') {
    const response = await fetch('http://127.0.0.1:3000/api/ready', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error();
  } else if (process.argv[2] === 'worker') {
    const heartbeat = JSON.parse(await readFile('/tmp/dota-worker-ready.json', 'utf8'));
    if (Date.now() - heartbeat.at > 20000 || !Number.isInteger(heartbeat.pid)) throw new Error();
    process.kill(heartbeat.pid, 0);
  } else throw new Error();
} catch { console.error('service_not_ready'); process.exitCode = 1; }
