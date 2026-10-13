// Local research harness. Inputs and outputs must stay in ignored data/; no account is hardcoded.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readMessages } from '@dota/contracts';

const root = fileURLToPath(new URL('../', import.meta.url));
const [manifestArg, outputArg] = process.argv.slice(2);
assert(manifestArg && outputArg, 'Usage: node scripts/validate-replays.mjs <local manifest.json> <local output-directory>');
const manifestPath = realpathSync(resolve(manifestArg));
const output = resolve(outputArg);
mkdirSync(output, { recursive: true });
for (const path of [manifestPath, realpathSync(output)]) {
  const local = relative(resolve(root, 'data'), path);
  assert(local && local !== '..' && !local.startsWith('..' + sep) && !local.startsWith(sep), 'Evidence must stay under ignored data/');
}
const manifest = JSON.parse(readFileSync(manifestPath));
const base = dirname(manifestPath);
const parser = resolve(root, 'services/replay-parser/build/install/replay-parser/bin/replay-parser');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const benchmark = process.platform === 'darwin';
const summary = { parser: 'normalized-v1/clarity-5.0.1/protobuf-7.1', samples: [], failures: [] };
const statNames = { kills: 'kills', deaths: 'deaths', assists: 'assists', lastHits: 'last_hits', denies: 'denies', gpm: 'gold_per_min', xpm: 'xp_per_min', heroDamage: 'hero_damage', towerDamage: 'tower_damage' };
async function run(file, matchId, label) {
  const request = { protocolVersion: '1.0.0', schemaVersion: '0.1.0', type: 'parse', requestId: 'validation', replayPath: file, expectedMatchId: String(matchId) };
  const timingPath = resolve(output, label + '.time.txt');
  const before = performance.now();
  const result = spawnSync(benchmark ? '/usr/bin/time' : parser,
    benchmark ? ['-l', '-o', timingPath, parser, '--protocol'] : ['--protocol'],
    { input: JSON.stringify(request) + '\n', encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, JAVA_OPTS: '-Xmx1g' } });
  const seconds = (performance.now() - before) / 1000;
  assert(!result.error, 'Parser execution failed');
  writeFileSync(resolve(output, label + '.ndjson'), result.stdout);
  writeFileSync(resolve(output, label + '.stderr.txt'), result.stderr);
  const messages = [];
  for await (const message of readMessages((async function* () { yield Buffer.from(result.stdout); })())) messages.push(message);
  assert(messages.every(m => m.requestId === request.requestId));
  const timing = benchmark ? readFileSync(timingPath, 'utf8') : '';
  const peakRssBytes = Number(timing.match(/(\d+)\s+maximum resident set size/)?.[1]) || null;
  return { status: result.status, messages, seconds, peakRssBytes, diagnostics: result.stderr.trim() };
}
function canonical(messages) {
  return JSON.stringify(messages, (key, value) => key === 'acquiredAt' ? '<run-time>' : value);
}
for (const [index, sample] of manifest.records.entries()) {
  const label = `R${index + 1}`;
  const replay = resolve(base, sample.replayFile);
  assert.equal(sha(readFileSync(replay)), sample.sha256Replay, `${label}: input hash`);
  const api = JSON.parse(readFileSync(resolve(base, sample.metadataFile)));
  const first = await run(replay, sample.matchId, label + '-first');
  assert.equal(first.status, 0, `${label}: parser exit`);
  assert.equal(first.messages.at(-1).type, 'complete');
  const records = first.messages.flatMap(m => m.type === 'record' ? [m.record] : []);
  assert(records.every(r => r.matchId === String(sample.matchId)));
  const match = records.find(r => r.kind === 'match');
  assert(Math.abs(match.durationSeconds - api.duration) < 1, `${label}: match duration`);
  assert.equal(match.mode, String(api.game_mode));
  assert.equal(match.radiantWin, api.radiant_win);
  const participants = records.filter(r => r.kind === 'participant');
  assert.equal(participants.length, 10);
  const selected = participants.filter(p => p.steamId64 === String(manifest.steamId64));
  assert.equal(selected.length, 1, `${label}: selected identity`);
  assert.equal(selected[0].accountId, String(manifest.accountId));
  const comparisons = [];
  for (const player of participants) {
    const source = api.players.find(p => p.player_slot === player.playerSlot);
    assert(source, `${label}: player slot`);
    assert.equal(player.heroId, String(source.hero_id));
    if (source.account_id != null) assert.equal(player.accountId, String(source.account_id));
    for (const [field, key] of Object.entries(statNames)) {
      comparisons.push({ slot: player.playerSlot, field, actual: player.statistics[field], expected: source[key], matches: player.statistics[field] === source[key] });
    }
    const deaths = records.filter(r => r.kind === 'event' && r.data.type === 'death' && r.data.victimSlot === player.playerSlot);
    assert.equal(deaths.length, source.deaths, `${label}: death count`);
    assert(deaths.every(r => r.gameTimeSeconds <= match.durationSeconds && r.tick === null));
    const coverage = records.find(r => r.kind === 'coverage' && r.field === 'deaths' && r.participantSlots.includes(player.playerSlot));
    assert.equal(coverage.status, deaths.length ? 'present' : 'empty', `${label}: death coverage`);
  }
  writeFileSync(resolve(output, label + '-comparisons.json'), JSON.stringify(comparisons, null, 2) + '\n');
  assert(comparisons.every(c => c.matches), `${label}: final statistics differ; inspect local comparisons`);
  const again = await run(replay, sample.matchId, label + '-repeat');
  assert.equal(again.status, 0);
  assert.equal(canonical(first.messages), canonical(again.messages), `${label}: deterministic content`);
  const normalizedSha256 = sha(canonical(first.messages));
  summary.samples.push({ sample: label, inputSha256: sample.sha256Replay, normalizedSha256, records: records.length,
    comparedStatistics: comparisons.length, allStatisticsMatch: true, repeatable: true,
    first: { seconds: first.seconds, peakRssBytes: first.peakRssBytes },
    repeat: { seconds: again.seconds, peakRssBytes: again.peakRssBytes }, diagnostics: first.diagnostics });
  writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`${label}: identities, 90 statistics, death coverage and repeatability passed`);
}
const firstSample = manifest.records[0];
const originalPath = resolve(base, firstSample.replayFile);
const bytes = readFileSync(originalPath);
const malformed = resolve(output, 'malformed.dem');
writeFileSync(malformed, Buffer.from('This is not a replay.'));
const truncated = resolve(output, 'truncated.dem');
writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
// Keep a readable header/epilogue, but remove the actual packet stream and stop marker.
let offset = 16;
function varint() { let value = 0, shift = 0, byte; do { byte = bytes[offset++]; value |= (byte & 127) << shift; shift += 7; } while (byte & 128); return value; }
varint(); varint(); const headerSize = varint();
const headerEnd = offset + headerSize;
const epilogueOnly = Buffer.concat([bytes.subarray(0, headerEnd), bytes.subarray(bytes.readInt32LE(8))]);
epilogueOnly.writeInt32LE(headerEnd, 8);
const incomplete = resolve(output, 'incomplete.dem');
writeFileSync(incomplete, epilogueOnly);
for (const [label, file, id, code] of [
  ['missing', resolve(output, 'does-not-exist.dem'), firstSample.matchId, 'invalid_replay'],
  ['malformed', malformed, firstSample.matchId, 'invalid_replay'],
  ['truncated', truncated, firstSample.matchId, 'invalid_replay'],
  ['mismatched-id', originalPath, String(BigInt(firstSample.matchId) + 1n), 'invalid_replay'],
  ['incomplete-stream', incomplete, firstSample.matchId, 'parse_failed'],
]) {
  const result = await run(file, id, label);
  assert.equal(result.status, 3, label);
  assert.equal(result.messages.length, 1, label);
  assert.equal(result.messages[0].type, 'error', label);
  assert.equal(result.messages[0].code, code, label);
  assert(!JSON.stringify(result.messages).includes(file));
  summary.failures.push({ case: label, code, passed: true });
}
writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log('Five failure cases passed; private evidence saved under data/.');
