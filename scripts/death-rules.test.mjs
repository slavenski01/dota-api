import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateD01, evaluateD02 } from '@dota/analysis';
import { fixture, death, objective } from './fixtures/analysis.mjs';
const d01 = (events, options) => evaluateD01(fixture(events, options))[0];
const d02 = (events, options) => evaluateD02(fixture(events, options))[0];
test('D01 uses inclusive t-15..t+30 and counts repeated enemy deaths after buyback', () => {
  for (const t of [85, 130]) assert.equal(d01([death('own', 100), death('enemy', t, 128, true)]).status, 'no_signal');
  for (const t of [84.999, 130.001]) assert.equal(d01([death('own', 100), death('enemy', t, 128)]).status, 'signal');
  assert.deepEqual(d01([death('own', 100), death('enemy', 90, 128), death('again', 110, 128, true)]).eventIds, ['enemy', 'again']);
  assert.equal(d01([death('own', 100, 128), death('enemy', 105, 0)], { playerSlot: 128 }).status, 'no_signal');
});
test('D01 never truncates trigger windows or treats partial participant data as absence', () => {
  assert.equal(d01([death('own', 1190)]).status, 'skipped');
  assert.equal(d01([death('own', -50)]).status, 'skipped');
  const ctx = fixture([death('own', 100)]); ctx.validation.coverage.find(c => c.field === 'deaths').participantSlots.pop();
  assert.equal(evaluateD01(ctx)[0].status, 'skipped');
  const conflict = fixture([death('own', 100)]); conflict.validation.issues.push({ field: 'deaths', code: 'conflict', recordIds: ['own'] });
  assert.equal(evaluateD01(conflict)[0].status, 'skipped');
  assert.equal(d01([]).status, 'no_signal');
});
test('D02 positive confirmed losses survive partial journals and an end-of-match window', () => {
  for (const t of [100, 190]) assert.equal(d02([death('own', 100), objective('tower', t)]).status, 'signal');
  for (const t of [99.99, 190.01]) assert.equal(d02([death('own', 100), objective('tower', t)]).status, 'skipped');
  const clipped = d02([death('own', 1190), objective('tower', 1200)]);
  assert.equal(clipped.status, 'signal'); assert.equal(clipped.viewClipped, true); assert.equal(clipped.viewWindow.endSeconds, 1200);
  assert.match(clipped.limitations.join(' '), /Причинная связь не установлена/);
});
test('D02 distinguishes owner and beneficiary, Roshan, unknown sides and Dire', () => {
  assert.equal(d02([death('own', 100), objective('tower', 110, 'dire', 'radiant')]).status, 'skipped');
  assert.equal(d02([death('own', 100, 128), objective('tower', 110, 'dire', 'radiant')], { playerSlot: 128 }).status, 'signal');
  for (const [owner, beneficiary] of [[null, 'dire'], ['radiant', null], ['radiant', 'radiant']]) assert.notEqual(d02([death('own', 100), objective('tower', 110, owner, beneficiary)]).status, 'signal');
  assert.equal(d02([death('own', 100), objective('roshan', 110, null, 'dire', 'roshan')]).status, 'signal');
  assert.equal(d02([death('own', 100), objective('roshan', 110, null, null, 'roshan')]).status, 'skipped');
});
test('D02 absence needs full coverage and unambiguous sides; conflicts veto positive claims', () => {
  assert.equal(d02([death('own', 100)], { complete: ['objectives'] }).status, 'no_signal');
  assert.equal(d02([death('own', 100), objective('tower', 110, null, 'dire')], { complete: ['objectives'] }).status, 'skipped');
  const ctx = fixture([death('own', 100), objective('tower', 110)]); ctx.validation.issues.push({ field: 'objectives', code: 'conflict', recordIds: ['tower'] });
  assert.equal(evaluateD02(ctx)[0].status, 'skipped');
  const both = fixture([death('a', 100), death('b', 120, 0, true), objective('tower', 130)]);
  assert.deepEqual(evaluateD02(both).map(r => r.anchorId), ['a', 'b']);
});
