import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deathsPerTenMinutes, killParticipation, playerAdvantage, snapshotAt, cumulativeGain, fingerprint, result } from '@dota/analysis';
const ids = ['source'];
test('formulas preserve zero and reject zero/unknown denominators, conflicts and nonfinite inputs', () => {
  assert.equal(deathsPerTenMinutes(3, 1800, ids).value, 1);
  assert.equal(deathsPerTenMinutes(0, 1800, ids).value, 0);
  assert.equal(killParticipation(3, 7, 20, ids).value, .5);
  for (const denominator of [null, 0, -1, Infinity, NaN]) {
    assert.equal(deathsPerTenMinutes(2, denominator, ids).status, 'unknown');
    assert.equal(killParticipation(2, 3, denominator, ids).status, 'unknown');
  }
  assert.equal(killParticipation(null, 3, 10, ids).value, null);
  assert.equal(killParticipation(5, 6, 10, ids).value, null);
  assert.equal(deathsPerTenMinutes(2, 100, []).value, null);
});
test('advantages use the selected side, including negative and zero values', () => {
  assert.equal(playerAdvantage(1500, 'dire', ids).value, -1500);
  assert.equal(playerAdvantage(-1500, 'dire', ids).value, 1500);
  assert.equal(playerAdvantage(1500, 'radiant', ids).value, 1500);
  assert.equal(playerAdvantage(null, 'dire', ids).value, null);
});
const point = (gameTimeSeconds, value) => ({ gameTimeSeconds, value, evidenceIds: [`point-${gameTimeSeconds}`] });
const series = () => ({ semantic: 'last_hits', cumulative: true, timelineVerified: true, intervalSeconds: 5, evidenceIds: ['clock'], points: [point(-5, 0), point(295, 30), point(300, 32), point(595, 80), point(605, 90)] });
test('5/10-minute snapshots use exact or bounded previous game time and expose actual timestamps', () => {
  const s = series();
  assert.equal(snapshotAt(s, 300).metric.value, 32);
  assert.equal(snapshotAt(s, 600).metric.value, 80);
  assert.equal(snapshotAt(s, 600).observedAtSeconds, 595);
  assert.equal(snapshotAt(s, 601).metric.value, null);
  assert.equal(snapshotAt(s, -5).metric.value, 0);
  assert.equal(snapshotAt(s, -6).metric.value, null);
  assert.equal(snapshotAt({ ...s, timelineVerified: false }, 300).metric.value, null);
  assert.equal(snapshotAt({ ...s, intervalSeconds: null }, 600).metric.value, null);
  assert.equal(snapshotAt({ ...s, points: [...s.points, point(300, 33)] }, 300).metric.reason, 'conflicting_observations');
  assert.equal(snapshotAt({ ...s, points: [...s.points, point(600, null)] }, 600).metric.value, null);
});
test('increments require confirmed cumulative semantics, both endpoints and monotonic observations', () => {
  const s = series();
  assert.equal(cumulativeGain(s, 300, 600).value, 48);
  assert.equal(cumulativeGain({ ...s, cumulative: false }, 300, 600).value, null);
  assert.equal(cumulativeGain(s, 600, 300).value, null);
  assert.equal(cumulativeGain(s, 290, 600).value, null);
  assert.equal(cumulativeGain({ ...s, points: [point(300, 40), point(600, 30)] }, 300, 600).value, null);
});
test('rule contract starts skipped; configuration hashing is order independent', () => {
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  const r = result('D01', 'death', { startSeconds: -15, endSeconds: 30 }, { before: 15, after: 30 }, []);
  assert.equal(r.status, 'skipped'); assert.equal(r.configSha256.length, 64);
});
