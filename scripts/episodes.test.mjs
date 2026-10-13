import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, analysisContext, summaryMetrics } from '@dota/analysis';
import { fixture, death, objective, event } from './fixtures/analysis.mjs';
const versions = { parser: 'fixture', normalization: 'fixture', rules: 'e06-v1', skillSha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), model: null, contextSha256: null };
const run = ctx => analyse(ctx, null, versions);
test('same death merges D01/D02, different overlapping deaths keep their anchors and stable IDs', () => {
  const ctx = fixture([death('first', 100), death('second', 120, 0, true), objective('tower', 150)]);
  const output = run(ctx); assert.equal(output.episodes.length, 2);
  assert.ok(output.episodes.every(e => e.episode.signals.length === 2 && e.episode.review === null));
  assert.deepEqual(output.episodes.map(e => e.anchorId), ['first', 'second']);
  const reversed = analysisContext([...ctx.records].reverse(), ctx.validation, 0);
  assert.deepEqual(run(reversed), output);
  const revised = analyse(ctx, null, { ...versions, skillSha256: 'c'.repeat(64) }); assert.notEqual(revised.episodes[0].episode.id, output.episodes[0].episode.id);
});
test('ordering follows rule category then game time; all candidates remain available and primary has at most three', () => {
  const output = run(fixture([death('earliest', 100), death('object-death', 300), objective('tower', 320), death('third', 500), death('fourth', 700)]));
  assert.deepEqual(output.episodes.map(e => e.anchorId), ['object-death', 'earliest', 'third', 'fourth']);
  assert.equal(output.primaryEpisodeIds.length, 3); assert.equal(output.episodes.length, 4);
  assert.equal(run(fixture([death('one', 100)])).primaryEpisodeIds.length, 1);
});
test('fight and nested death retain bidirectional links without merging', () => {
  const fight = event('fight', 100, { type: 'fight', window: { startSeconds: 100, endSeconds: 130 }, participantSlots: [0, 128], definition: 'Independent fixture battle boundary-v1' });
  const output = run(fixture([fight, death('own', 110), death('enemy', 120, 128), death('again', 125, 128, true), objective('tower', 140)], { complete: ['fights'] }));
  assert.equal(output.episodes.length, 2);
  for (const e of output.episodes) { assert.equal(e.relatedEpisodeIds.length, 1); assert.notEqual(e.relatedEpisodeIds[0], e.episode.id); }
  assert.equal(output.episodes.find(e => e.anchorId === 'fight').results[0].eventIds.includes('own'), true);
});
test('no candidates and insufficient data remain distinct without manufacturing episodes', () => {
  const partial = run(fixture([])); assert.equal(partial.outcome, 'insufficient_data'); assert.deepEqual(partial.primaryEpisodeIds, []);
  const ctx = fixture([], { complete: ['items', 'fights', 'objectives'] });
  const complete = analyse(ctx, { keyItemId: '1', gamePlan: 'Контрольный план' }, versions);
  assert.equal(complete.outcome, 'no_candidates'); assert.equal(complete.completeness, 'complete'); assert.deepEqual(complete.episodes, []);
});
test('summary metrics use allied kills for Dire and fail closed on unknown time', () => {
  const ctx = fixture([death('own', 100, 128)], { playerSlot: 128 });
  for (const p of ctx.participants) p.statistics.kills = p.team === 'dire' ? 2 : 20;
  ctx.player.statistics.assists = 3;
  assert.equal(summaryMetrics(ctx).killParticipation.value, .5);
  assert.equal(summaryMetrics(ctx).deathsPerTenMinutes.value, .5);
  ctx.validation.coverage.find(c => c.field === 'time').status = 'unknown';
  assert.equal(summaryMetrics(ctx).deathsPerTenMinutes.value, null);
});
