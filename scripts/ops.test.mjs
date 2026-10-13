// Opt-in: builds must already exist. All data belongs to fresh random projects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

async function command(bin, args, { env = {}, input } = {}) {
  const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.end(input);
  const [code] = await once(child, 'close');
  if (code !== 0) throw Error(`${bin} failed (${code}): ${stderr}`);
  return stdout.trim();
}
async function port() {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return String(value);
}
async function until(check) {
  for (let i = 0; i < 90; i++) { try { if (await check()) return; } catch {} await delay(1000); }
  throw Error('readiness_timeout');
}
test('Compose readiness, restart, coherent backup and isolated restore', { skip: process.env.DOTA_TEST_DOCKER !== '1', timeout: 600000 }, async t => {
  const name = `dota-ops-${randomBytes(4).toString('hex')}`, target = `${name}-restore`;
  const dir = await mkdtemp(join(tmpdir(), 'dota-ops-')), backup = join(dir, 'backup');
  const firstPort = await port(), secondPort = await port();
  const env = { COMPOSE_PROJECT_NAME: name, DOTA_PORT: firstPort };
  const compose = (args, options = {}) => command('docker', ['compose', '-p', name, ...args], { env, ...options });
  const url = `http://127.0.0.1:${firstPort}`, restored = `http://127.0.0.1:${secondPort}`;
  try {
    await compose(['up', '-d', '--no-build', '--wait']);
    assert.equal((await fetch(url + '/api/ready')).status, 200);
    const binding = await compose(['port', 'web', '3000']);
    assert.equal(binding, `127.0.0.1:${firstPort}`);
    const databaseId = await compose(['ps', '-q', 'db']);
    const ports = JSON.parse(await command('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', databaseId]));
    assert.equal(ports['5432/tcp'] ?? null, null);
    const seed = `
      import { Readable } from 'node:stream';
      import { openDatabase, LocalStorage, configuredStorageRoot, transaction, registerArtifact } from '@dota/persistence';
      const pool = openDatabase(), storage = new LocalStorage(configuredStorageRoot());
      try {
        const file = await storage.put(Readable.from(['backup evidence']));
        await transaction(pool, async c => {
          await c.query("INSERT INTO dota.matches(match_id) VALUES ('42')");
          await registerArtifact(c, { id: 'backup-evidence', matchId: '42', file, mediaType: 'application/octet-stream', source: {} });
        });
        console.log(file.sha256);
      } finally { await pool.end(); }
    `;
    await compose(['exec', '-T', 'worker', 'node', '--input-type=module'], { env, input: seed });
    await compose(['restart', 'web', 'worker']);
    await until(async () => (await fetch(url + '/api/ready')).ok);
    await compose(['exec', '-T', 'worker', 'node', 'scripts/storage-audit.mjs']);
    await compose(['stop', 'db']);
    assert.equal((await fetch(url + '/api/ready')).status, 503);
    assert.equal((await fetch(url + '/api/health')).status, 200);
    await until(async () => {
      const id = await compose(['ps', '-q', 'worker']);
      return await command('docker', ['inspect', '--format', '{{.State.Health.Status}}', id]) === 'unhealthy';
    });
    await compose(['start', '--wait', 'db']);
    await until(async () => (await fetch(url + '/api/ready')).ok);
    await until(async () => {
      const id = await compose(['ps', '-q', 'worker']);
      return await command('docker', ['inspect', '--format', '{{.State.Health.Status}}', id]) === 'healthy';
    });
    await command(process.execPath, ['scripts/local.mjs', 'backup', backup], { env });
    assert.equal((await fetch(url + '/api/ready')).status, 200);
    await command(process.execPath, ['scripts/local.mjs', 'restore', backup, target, secondPort], { env });
    assert.equal((await fetch(restored + '/api/ready')).status, 200);
    assert.equal(await command('docker', ['compose', '-p', target, 'exec', '-T', 'db', 'psql', '-U', 'dota', '-d', 'dota', '-Atc', "SELECT count(*) FROM dota.artifacts WHERE id='backup-evidence'"], { env }), '1');
    await assert.rejects(command(process.execPath, ['scripts/local.mjs', 'restore', backup, target, secondPort], { env }), /restore_target_already_exists/);
    await assert.rejects(command(process.execPath, ['scripts/local.mjs', 'backup', backup], { env }), /EEXIST/);
    t.diagnostic('Loopback bindings, readiness 200→503→200, persistent artifact, all backup checksums and isolated restored artifact verified; existing target refused.');
  } finally {
    for (const project of [target, name]) await command('docker', ['compose', '-p', project, 'down', '--volumes'], { env }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
