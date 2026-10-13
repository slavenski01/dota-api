import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateI01, evaluateF01, purchaseJournal, analysisOptions } from '@dota/analysis';
import { fixture, event, death, objective } from './fixtures/analysis.mjs';
const options = { keyItemId: '1', gamePlan: 'Защищать союзника и начинать бой после его готовности' };
const item = (id, time, action = 'purchased', itemId = '1', playerSlot = 0) => event(id, time, { type: 'item', playerSlot, itemId, action });
const fight = (id = 'fight', start = 100, end = 120) => event(id, start, { type: 'fight', window: { startSeconds: start, endSeconds: end }, participantSlots: [0, 128], definition: 'Контрольный бой: независимая разметка границ источником fixture-v1' });
test('I01 requires explicit item and game plan; purchase journal remains available', () => {
  const ctx = fixture([item('purchase', 100)]);
  assert.equal(purchaseJournal(ctx).length, 1); assert.equal(evaluateI01(ctx)[0].status, 'skipped');
  for (const bad of [{ keyItemId: '1' }, { ...options, gamePlan: ' ' }, { ...options, keyItemId: 1 }, { ...options, gamePlan: 'x'.repeat(2001) }, { ...options, extra: true }]) assert.throws(() => analysisOptions(bad));
  assert.equal(evaluateI01(ctx, options)[0].status, 'signal');
});
test('I01 distinguishes purchase from assembly, delivery, use, other players and other items', () => {
  for (const action of ['assembled', 'received', 'used']) assert.equal(evaluateI01(fixture([item('event', 100, action)]), options)[0].status, 'skipped');
  for (const row of [item('event', 100, 'purchased', '2'), item('event', 100, 'purchased', '1', 128)]) assert.equal(evaluateI01(fixture([row]), options)[0].status, 'skipped');
});
test('I01 uses the inclusive 180-second timeline, keeps all purchases and states incomplete coverage', () => {
  const ctx = fixture([item('first', 100), item('second', 150), death('left', 100), objective('right', 280), death('before', 99.9), death('after', 280.1)]);
  const rows = evaluateI01(ctx, options); assert.equal(rows.length, 2); assert.deepEqual(rows[0].eventIds, ['left', 'right']);
  assert.match(rows[0].limitations.join(' '), /покрытие окна неполно/);
  const truncated = evaluateI01(fixture([item('last', 1190)]), options)[0]; assert.equal(truncated.status, 'signal'); assert.equal(truncated.viewClipped, true);
  const conflict = fixture([item('bad', 100)]); conflict.validation.issues.push({ field: 'items', code: 'conflict', recordIds: ['bad'] }); assert.equal(evaluateI01(conflict, options)[0].status, 'skipped');
});
test('F01 requires verified boundaries and complete losses of both teams; never derives fights from kills', () => {
  assert.equal(evaluateF01(fixture([death('enemy', 110, 128)]))[0].status, 'skipped');
  const events = [fight(), death('enemy', 110, 128)]; assert.equal(evaluateF01(fixture(events))[0].status, 'skipped');
  const ctx = fixture(events, { complete: ['fights'] }); ctx.validation.coverage.find(c => c.field === 'deaths').participantSlots.pop(); assert.equal(evaluateF01(ctx)[0].status, 'skipped');
  const bad = fight(); bad.data.window.endSeconds = 1300; assert.equal(evaluateF01(fixture([bad], { complete: ['fights'] }))[0].status, 'skipped');
});
test('F01 counts inclusive boundaries and repeated buyback deaths, orients losses for Dire', () => {
  const events = [fight(), death('a', 100, 128), death('b', 120, 128, true), death('own', 110), death('outside', 120.1)];
  const output = evaluateF01(fixture(events, { complete: ['fights'] }))[0]; assert.equal(output.status, 'signal');
  assert.match(output.facts[0], /своя команда — 1, противник — 2/); assert.match(output.limitations.join(' '), /Данных об объектах недостаточно/);
  assert.equal(evaluateF01(fixture(events, { playerSlot: 128, complete: ['fights'] }))[0].status, 'no_signal');
});
test('F01 objective absence requires full 90-second window; positive events survive partial journals', () => {
  const events = [fight(), death('a', 110, 128)];
  const full = evaluateF01(fixture(events, { complete: ['fights', 'objectives'] }))[0]; assert.ok(full.facts.includes('Объекты в этом окне не зарегистрированы.'));
  for (const time of [120, 210]) assert.ok(evaluateF01(fixture([...events, objective('object', time)], { complete: ['fights'] }))[0].eventIds.includes('object'));
  assert.ok(!evaluateF01(fixture([...events, objective('object', 210.1)], { complete: ['fights'] }))[0].eventIds.includes('object'));
  const edge = evaluateF01(fixture([fight('end', 1100, 1150), death('a', 1120, 128)], { complete: ['fights', 'objectives'] }))[0]; assert.ok(!edge.facts.includes('Объекты в этом окне не зарегистрированы.'));
});
