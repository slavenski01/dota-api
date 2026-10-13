// Explicit live acceptance, using the private E01 sample manifest by default.
// Leaves the normal local installation and private evidence available for review.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

process.loadEnvFile();
const base = `http://127.0.0.1:${process.env.DOTA_PORT || 3000}`;
const evidence = resolve('data/acceptance/e10');
await mkdir(evidence, { recursive: true, mode: 0o700 });
const manifestPath = resolve(process.env.DOTA_ACCEPTANCE_MANIFEST || 'data/replay-validation/2026-10-12-e01-t02/manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const sample = manifest.records[0], accountId = String(manifest.accountId), matchId = String(sample.matchId);
const summary = { startedAt: new Date().toISOString(), accountId, matchId, checks: [] };
const save = () => writeFile(join(evidence, 'result.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
async function command(bin, args) {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const [code] = await once(child, 'close');
  if (code !== 0) throw Error(`${bin}_failed: ${errors}`);
  return output.trim();
}
const compose = args => command('docker', ['compose', ...args]);
async function json(path, body, server = base) {
  const response = await fetch(server + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server }, body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.ok(response.ok, `${path.split('?')[0]}: HTTP ${response.status}, ${result.error || 'unexpected response'}`);
  return result;
}
async function until(check, timeout = 360000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(250); }
  throw Error('acceptance_timeout');
}
async function record(check, details = {}) {
  summary.checks.push({ check, ...details }); await save(); console.log(JSON.stringify({ check, ...details }));
}
try {
  assert.equal((await fetch(base + '/api/ready')).status, 200);
  assert.equal((await json('/api/profile', { id: accountId, kind: 'account' })).profile.accountId, accountId);
  await json('/api/history', { accountId, mode: 'refresh' });
  const history = await until(async () => {
    const state = await json(`/api/history?accountId=${accountId}`);
    if (state.latest?.status === 'failed') throw Error(`history_${state.latest.error}`);
    return state.latest?.status === 'ready' && state;
  });
  const matches = await json(`/api/matches?accountId=${accountId}&limit=100`);
  assert.ok(matches.items.some(match => match.matchId === matchId), 'reference match must be present in live history');
  await record('live_profile_history', { storedMatches: matches.items.length });
  const started = performance.now();
  const [first, second] = await Promise.all([1, 2].map(() => json('/api/jobs', { matchId, accountId })));
  assert.equal(first.id, second.id); summary.jobId = first.id; await record('double_click_deduplicated');
  const state = () => json(`/api/jobs/${first.id}`);
  let interrupted = false;
  const done = await until(async () => {
    const result = await state();
    if (['failed', 'unavailable', 'cancelled'].includes(result.job.status)) throw Error(`workflow_${result.job.error?.code || result.job.status}`);
    if (result.job.status === 'parsing' && !interrupted) {
      interrupted = true;
      await compose(['stop', '--timeout', '45', 'worker']);
      assert.equal((await fetch(base + '/api/ready')).status, 200);
      await compose(['start', '--wait', 'worker']);
    }
    return result.job.status === 'ready' && result;
  });
  assert.ok(interrupted, 'must interrupt an active parsing attempt');
  assert.ok(done.attempt >= 1, 'the same job must resume after worker shutdown');
  summary.datasetId = done.datasetId; summary.artifactId = done.artifactId;
  await record('live_replay_and_worker_resume', { durationMs: Math.round(performance.now() - started), retries: done.attempt });
  const explorerPath = `/api/datasets/${done.datasetId}/explore?accountId=${accountId}`;
  const explorationStarted = performance.now(), explorer = await json(explorerPath);
  assert.equal(explorer.players.length, 10);
  const source = JSON.parse(await readFile(join(dirname(manifestPath), `match-${matchId}.json`), 'utf8'));
  for (const player of explorer.players) {
    const expected = source.players.find(row => row.player_slot === player.playerSlot);
    for (const stat of ['kills', 'deaths', 'assists']) assert.equal(player.statistics[stat], expected[stat]);
  }
  const events = []; let cursor = null;
  do {
    const page = await json(explorerPath + '&resource=events&limit=200' + (cursor ? `&cursor=${cursor}` : ''));
    events.push(...page.events); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(events.map(event => event.id)).size, events.length);
  const frame = await json(explorerPath + '&resource=frame&time=60');
  assert.equal(frame.states.length, 10); assert.equal(frame.states.filter(row => row.mapPosition).length, 10);
  for (const time of [explorer.window.startSeconds, 0, explorer.window.endSeconds]) {
    assert.equal((await json(explorerPath + `&resource=frame&time=${time}`)).states.length, 10);
  }
  const own = await json(`/api/datasets/${done.datasetId}/context?time=60&playerSlot=${explorer.player.playerSlot}`);
  assert.equal(own.mode, 'decision'); assert.ok(own.states.every(state => state.hp.status === 'unknown' && state.position.status === 'unknown'));
  const notePath = `/api/datasets/${done.datasetId}/notes?accountId=${accountId}`;
  const note = { id: randomUUID(), time: 60, playerSlot: explorer.player.playerSlot, mode: 'retrospective', content: 'Приёмка MVP: изучить позиции на первой минуте.' };
  await json(notePath, note);
  assert.ok((await json(notePath)).notes.some(row => row.id === note.id));
  await record('full_match_and_note', { participants: 10, verifiedKda: 30, events: events.length, mapPositions: 10, httpMs: Math.round(performance.now() - explorationStarted) });
  const reused = await json('/api/jobs', { matchId, accountId, artifactId: done.artifactId });
  assert.equal(reused.id, first.id); assert.equal(reused.reused, true);
  const download = await fetch(`${base}/api/replays/${matchId}/file?accountId=${accountId}`);
  assert.equal(download.status, 200);
  const digest = createHash('sha256'); let replayBytes = 0;
  for await (const chunk of download.body) { replayBytes += chunk.byteLength; digest.update(chunk); }
  assert.equal(digest.digest('hex'), sample.sha256Replay);
  const memoryPeak = Number(await compose(['exec', '-T', 'worker', 'cat', '/sys/fs/cgroup/memory.peak']));
  await record('replay_hash_and_result_reuse', { replayBytes, containerMemoryPeakBytes: memoryPeak });
  summary.explorerUrl = `${base}/matches/${matchId}/explore?accountId=${accountId}&datasetId=${done.datasetId}&time=60&mode=retrospective`;
  summary.noteId = note.id;
  await compose(['stop']); await compose(['up', '-d', '--no-build', '--wait']);
  assert.deepEqual(await json(explorerPath + '&resource=frame&time=60'), frame);
  assert.ok((await json(notePath)).notes.some(row => row.id === note.id));
  assert.equal((await state()).datasetId, done.datasetId);
  await record('all_services_restart');
  const backup = join(evidence, `backup-${Date.now()}`);
  await command(process.execPath, ['scripts/local.mjs', 'backup', backup]);
  const restoredProject = `dota-acceptance-${Date.now()}`, restoredPort = '3001';
  summary.backup = backup; summary.restoredProject = restoredProject;
  await command(process.execPath, ['scripts/local.mjs', 'restore', backup, restoredProject, restoredPort]);
  const restored = `http://127.0.0.1:${restoredPort}`;
  assert.deepEqual(await json(explorerPath + '&resource=frame&time=60', undefined, restored), frame);
  assert.ok((await json(notePath, undefined, restored)).notes.some(row => row.id === note.id));
  await command('docker', ['compose', '-p', restoredProject, 'stop']);
  await record('real_backup_restore');
  summary.completedAt = new Date().toISOString(); summary.status = 'passed'; await save();
  console.log('Live acceptance passed; private results: data/acceptance/e10/result.json');
} catch (error) {
  summary.status = 'failed'; summary.error = error.message; await save();
  console.error(error.message); process.exitCode = 1;
}
