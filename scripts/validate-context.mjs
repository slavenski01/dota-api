// Research evidence contains private replay data. Keep every input and output under ignored data/.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const [manifestArg, outputArg] = process.argv.slice(2);
assert(manifestArg && outputArg, 'Usage: node scripts/validate-context.mjs <local manifest.json> <local output-directory>');
function privatePath(path) {
  const actual = realpathSync(path);
  const local = relative(resolve(root, 'data'), actual);
  assert(local && local !== '..' && !local.startsWith('..' + sep) && !local.startsWith(sep), 'Evidence must stay under ignored data/');
  return actual;
}
const manifestPath = privatePath(resolve(manifestArg));
mkdirSync(resolve(outputArg), { recursive: true });
const output = privatePath(resolve(outputArg));
const manifest = JSON.parse(readFileSync(manifestPath));
const base = dirname(manifestPath);
const parser = resolve(root, 'services/replay-parser/build/install/replay-parser/bin/replay-parser');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = doc => JSON.stringify(doc, (key, value) => key === 'acquiredAt' ? '<run-time>' : value);
const fields = ['position', 'hp', 'mana', 'alive', 'inventory', 'resources'];
const slots = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];
const summary = { researchVersion: 'context-research-v1', clientVerified: false, samples: [], episodes: [], failures: [] };
const documents = [];
function saveSummary() { writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'); }
function request(sample, id = sample.matchId) {
  return { protocolVersion: '1.0.0', schemaVersion: '0.1.0', type: 'parse', requestId: 'context-validation',
    replayPath: privatePath(resolve(base, sample.replayFile)), expectedMatchId: String(id) };
}
function run(input, label, from = 300, to = 330) {
  const args = ['--research-context', String(from), String(to)];
  const timingPath = resolve(output, label + '.time.txt');
  const benchmark = process.platform === 'darwin';
  const start = performance.now();
  const result = spawnSync(benchmark ? '/usr/bin/time' : parser,
    benchmark ? ['-l', '-o', timingPath, parser, ...args] : args,
    { input: JSON.stringify(input) + '\n', encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, JAVA_OPTS: '-Xmx1g' } });
  assert(!result.error, 'Context parser execution failed');
  const seconds = (performance.now() - start) / 1000;
  writeFileSync(resolve(output, label + '.request.ndjson'), JSON.stringify(input) + '\n');
  writeFileSync(resolve(output, label + '.json'), result.stdout);
  writeFileSync(resolve(output, label + '.stderr.txt'), result.stderr);
  const timing = benchmark ? readFileSync(timingPath, 'utf8') : '';
  return { status: result.status, document: result.stdout.trim() ? JSON.parse(result.stdout) : null,
    seconds, bytes: Buffer.byteLength(result.stdout), peakRssBytes: Number(timing.match(/(\d+)\s+maximum resident set size/)?.[1]) || null,
    stderr: result.stderr.trim() };
}
function verify(doc, sample) {
  assert.equal(doc.status, 'research_only');
  assert.equal(doc.researchVersion, summary.researchVersion);
  assert.equal(doc.clientVerified, false);
  assert.equal(doc.matchId, String(sample.matchId));
  assert.equal(doc.provenance.artifactId, 'replay-sha256-' + sample.sha256Replay);
  assert(doc.provenance.sourceVersion.startsWith(summary.researchVersion + '/'));
  assert.equal(doc.participants.length, 10);
  assert(doc.samples.length > 0 && doc.samples.length <= 1210);
  assert.equal(doc.window.firstSampleSeconds, doc.samples[0].gameTimeSeconds);
  assert.equal(doc.window.lastSampleSeconds, doc.samples.at(-1).gameTimeSeconds);
  assert.equal(doc.candidatesTruncated, false, 'Review candidate coverage is truncated');
  const times = new Map();
  const groups = new Map();
  const previousResources = new Map();
  let positiveCooldowns = 0, countdownPairs = 0, partialResources = 0, unknownStateValues = 0;
  for (const s of doc.samples) {
    assert(slots.includes(s.playerSlot));
    assert(s.gameTimeSeconds >= doc.window.fromSeconds && s.gameTimeSeconds <= doc.window.toSeconds);
    assert(s.gameTimeSeconds <= doc.matchDurationSeconds);
    const bucket = Math.floor(s.gameTimeSeconds);
    assert((times.get(s.playerSlot) ?? -1) < bucket, 'Duplicate or backward clock');
    times.set(s.playerSlot, bucket);
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(s.playerSlot);
    assert(Number.isInteger(s.tick) && Number.isInteger(s.serverTick));
    assert.equal(s.position.status, 'candidate');
    for (const axis of ['x', 'y', 'z']) {
      if (s.position[axis] === null) unknownStateValues++;
      else assert(Number.isFinite(s.position[axis]));
    }
    for (const field of ['hp', 'mana']) {
      if (s[field] === null) unknownStateValues++;
      else assert(Number.isFinite(s[field]) && s[field] >= 0);
    }
    assert(s.alive === null || typeof s.alive === 'boolean');
    const ownTeam = s.playerSlot < 128 ? 'radiant' : 'dire';
    assert.equal(s.visibilityEvidence[ownTeam + 'Candidate'], true);
    for (const side of ['radiant', 'dire']) {
      const view = s.teamViews[side];
      assert.deepEqual(Object.keys(view).sort(), [...fields, 'playerSlot', 'gameTimeSeconds', 'perspective', 'visibility', 'lastKnownPosition'].sort());
      assert.equal(view.visibility.status, 'unknown');
      assert.equal(view.visibility.value, null);
      assert.equal(view.lastKnownPosition, null);
      for (const field of fields) {
        assert.equal(view[field].status, 'unknown');
        assert.equal(view[field].value, null);
      }
    }
    for (const field of ['inventory', 'resources']) {
      const collection = s[field];
      assert(['observed', 'partial'].includes(collection.status));
      assert.equal(collection.truncated, false);
      if (collection.status === 'partial') partialResources++;
      assert.equal(new Set(collection.entries.map(r => r.slot)).size, collection.entries.length);
      for (const resource of collection.entries) {
        assert.equal(resource.canUse.status, 'unknown');
        assert.equal(resource.canUse.value, null);
        assert(!('abilityId' in resource) && !('itemId' in resource));
        if (resource.cooldownRaw > 0) positiveCooldowns++;
        const key = s.playerSlot + ':' + field + ':' + resource.entityHandle;
        const previous = previousResources.get(key);
        if (previous && resource.cooldownRaw > 0 && previous.raw > resource.cooldownRaw &&
            Math.abs(previous.raw - resource.cooldownRaw - (s.gameTimeSeconds - previous.time)) < 0.1) countdownPairs++;
        previousResources.set(key, { time: s.gameTimeSeconds, raw: resource.cooldownRaw });
      }
    }
  }
  for (const seen of groups.values()) assert.deepEqual(seen.sort((a, b) => a - b), slots, 'Missing or duplicate hero in sample');
  assert.equal(doc.visibilityScan.ownTeamFalse, 0);
  assert.equal(doc.visibilityScan.ownTeamUnknown, 0);
  assert.equal(doc.visibilityScan.ownTeamTrue, doc.visibilityScan.sampledHeroObservations);
  assert(doc.visibilityScan.transitions > 0);
  assert(doc.reviewCandidates.every(c => c.time >= 0 && c.time <= doc.matchDurationSeconds));
  return { snapshots: doc.samples.length, buckets: groups.size, positiveCooldowns, countdownPairs, partialResources, unknownStateValues };
}

for (const [index, sample] of manifest.records.entries()) {
  const label = `R${index + 1}`;
  const input = request(sample);
  assert.equal(sha(readFileSync(input.replayPath)), sample.sha256Replay, `${label}: replay hash`);
  const first = run(input, label + '-first');
  assert.equal(first.status, 0, `${label}: parser exit`);
  const checks = verify(first.document, sample);
  assert(checks.countdownPairs > 0, `${label}: no observed decrementing timer in window`);
  const repeat = run(input, label + '-repeat');
  assert.equal(repeat.status, 0);
  assert.equal(canonical(first.document), canonical(repeat.document), `${label}: repeatability`);
  documents.push({ label, sample, document: first.document });
  summary.samples.push({ sample: label, ...checks, repeatable: true, normalizedSha256: sha(canonical(first.document)),
    first: { seconds: first.seconds, peakRssBytes: first.peakRssBytes, bytes: first.bytes },
    repeat: { seconds: repeat.seconds, peakRssBytes: repeat.peakRssBytes, bytes: repeat.bytes },
    visibilityScan: first.document.visibilityScan, candidates: first.document.reviewCandidates.length });
  saveSummary();
  console.log(`${label}: context extraction, masking, clocks and repeatability passed`);
}

// Select five concrete moments for later client comparison; automated coherence is not client verification.
const cases = [
  ['visibility-loss', c => c.kind === 'visibility_transition' && c.to === false],
  ['visibility-gain', c => c.kind === 'visibility_transition' && c.to === true],
  ['smoke', c => c.kind === 'modifier' && c.modifier === 'modifier_smoke_of_deceit'],
  ['invisibility', c => c.kind === 'modifier' && c.modifier.includes('invis')],
  ['detection', c => c.kind === 'modifier' && c.modifier.includes('dust')],
];
for (const [index, [name, predicate]] of cases.entries()) {
  const ordered = [...documents.slice(index), ...documents.slice(0, index)];
  let selected;
  for (const entry of ordered) {
    const candidate = entry.document.reviewCandidates.find(c => c.time > 10 && predicate(c) &&
      (c.kind !== 'modifier' || (c.targetHeroName?.startsWith('npc_dota_hero_') && c.targetIllusion === false)));
    if (candidate) { selected = { ...entry, candidate }; break; }
  }
  assert(selected, `${name}: no review candidate in this control set`);
  const { label, sample, candidate } = selected;
  const from = Math.max(0, Math.floor(candidate.time) - 5);
  const to = Math.min(selected.document.matchDurationSeconds, Math.ceil(candidate.time) + 5);
  const evidenceLabel = `${label}-${name}`;
  const evidence = run(request(sample), evidenceLabel, from, to);
  assert.equal(evidence.status, 0);
  verify(evidence.document, sample);
  summary.episodes.push({ case: name, sample: label, candidate, from, to, evidence: evidenceLabel + '.json', clientVerified: false });
  saveSummary();
  console.log(`${name}: local context saved; client verification pending`);
}

const first = manifest.records[0];
for (const [label, input, from, to, exitCode, errorCode] of [
  ['reversed-window', request(first), 330, 300, 2, 'invalid_context_window'],
  ['oversized-window', request(first), 0, 121, 2, 'invalid_context_window'],
  ['nonfinite-window', request(first), 'NaN', 30, 2, 'invalid_context_window'],
  ['mismatched-id', request(first, String(BigInt(first.matchId) + 1n)), 300, 330, 3, 'invalid_replay'],
  ['empty-window', request(first), 1_000_000, 1_000_010, 3, 'parse_failed'],
]) {
  const result = run(input, label, from, to);
  assert.equal(result.status, exitCode, label);
  if (exitCode === 2) { assert.equal(result.document, null); assert(result.stderr.includes(errorCode)); }
  else { assert.equal(result.document.status, 'error'); assert.equal(result.document.code, errorCode); assert(!('samples' in result.document)); }
  assert(!result.stderr.includes(input.replayPath));
  summary.failures.push({ case: label, exitCode, errorCode, passed: true });
}
saveSummary();
const review = ['# Локальная сверка E01-T04', '',
  'Статус всех эпизодов: не подтверждено в клиенте; отложено пользователем. Это только список кандидатов.', '',
  'Открыть соответствующий .dem в Dota 2. Проверить часы, выбранного героя, позицию, HP/ману, предметы и cooldown. Затем переключить перспективу на указанную команду; сопоставить потерю/появление видимости, smoke, невидимость и обнаружение. Не подменять командный обзор всеведущим режимом.', '',
  ...summary.episodes.flatMap(e => [`## ${e.case} — ${e.sample}`, '',
    `Окно: ${e.from}–${e.to} секунд после начала матча. Данные: ${e.evidence}.`,
    `Кандидат: ${JSON.stringify(e.candidate)}`, 'Результат клиента: НЕ ПРОВЕРЕНО.', ''])];
writeFileSync(resolve(output, 'manual-review.md'), review.join('\n'));
console.log('Five failure cases passed. Client verification remains explicitly unconfirmed.');
